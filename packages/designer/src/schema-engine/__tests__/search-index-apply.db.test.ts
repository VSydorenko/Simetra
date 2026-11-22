import pg from "pg"
import { describe, expect, it } from "vitest"
import {
  compiled,
  EMPTY,
  establish,
  inTarget,
  type Json,
  NOTES,
  notes,
  PARTY,
  party,
  plan,
  planned,
  applyArtifact,
  stepMatching,
  USER,
  useBuildPlanRoles,
} from "./build-plan.support"
import { asSuperuser, query } from "../../__tests__/support/db"
import { PROVIDER_API_ROLES, SEARCH_PREFIX_CHARS } from "simetra/model"
import { attribute, testProvider, uuid } from "../../../../simetra/test/support"

/**
 * Пошуковий індекс полів `search` (ADR-0097, спека П2 §5): збережена
 * згенерована колонка `lower(<колонка> COLLATE "default")` і btree
 * `(<нормалізована> text_pattern_ops)`. DB-рівень потрібен, бо лише справжній
 * двигун доводить, що план застосовується й повторний план порожній (без шуму
 * відбитка), а лише справжня база під RLS показує, чи стала умова
 * `starts_with` діапазоном індексу для ролі запиту, а не фільтром після
 * політики.
 */

useBuildPlanRoles()

/** Рядків засіву: досить, щоб планувальник обрав індекс за статистикою. */
const ROWS = 20_000

/**
 * Спайк рушія (Р7): та сама форма, оголошена прийнятою таблицею вручну, —
 * незалежно від того, як її виводить компілятор.
 */
const spikeNotes = (): Json => {
  const base = notes() as unknown as Json
  return {
    ...base,
    rowLevelSecurity: "enabled",
    columns: [
      ...(base.columns as Json[]),
      {
        id: uuid(9210),
        name: "owner",
        physicalName: "owner",
        type: "Text",
        notNull: true,
      },
      {
        id: uuid(9211),
        name: "noteNorm",
        physicalName: "note_norm",
        type: "Text",
        generated: { expression: `lower(note COLLATE "default")` },
      },
    ],
    indexes: [
      {
        name: "notes_note_norm_idx",
        keys: [{ column: "noteNorm", opclass: { name: "text_pattern_ops" } }],
      },
    ],
  }
}

/** Політика членства з підзапитом, як у ролей застосунку. */
const READ_POLICY = `GRANT SELECT ON app.notes TO ${USER};
CREATE POLICY notes_read ON app.notes FOR SELECT TO ${USER}
  USING (owner IN (SELECT current_user::text));`

async function seed(url: string): Promise<void> {
  await query(
    asSuperuser(url),
    `insert into app.notes (id, owner, note)
       select gen_random_uuid(),
              case when g % 2 = 0 then '${USER}' else 'other' end,
              'Note ' || g
         from generate_series(1, ${ROWS}) g;
     analyze app.notes;`
  )
}

interface PlanNode {
  "Node Type": string
  "Index Name"?: string
  "Index Cond"?: string
  Plans?: PlanNode[]
}

const nodesOf = (node: PlanNode): PlanNode[] => [
  node,
  ...(node.Plans ?? []).flatMap(nodesOf),
]

/** План запиту від ролі запиту профілю (`USER`); транзакція відкочується. */
async function explainAsUser(url: string, sql: string): Promise<PlanNode[]> {
  const client = new pg.Client({ connectionString: asSuperuser(url) })
  await client.connect()
  try {
    await client.query("begin")
    // Схему застосунку роль API бачить через гранти платформи; ціль спайку
    // їх не має, тож USAGE — лише в цій транзакції
    await client.query(`grant usage on schema app to ${USER}`)
    await client.query(
      `set local role ${PROVIDER_API_ROLES[testProvider()].user}`
    )
    const rows = (
      await client.query<{ "QUERY PLAN": [{ Plan: PlanNode }] }>(
        `explain (format json) ${sql}`
      )
    ).rows
    return nodesOf(rows[0]!["QUERY PLAN"][0].Plan)
  } finally {
    await client.query("rollback").catch(() => undefined)
    await client.end()
  }
}

/** Вузол індексу, чия умова — діапазон `text_pattern_ops` за колонкою. */
const prefixRange = (nodes: PlanNode[], column: string) =>
  nodes.filter(
    (n) =>
      n["Index Cond"] !== undefined &&
      n["Index Cond"].includes(`${column} ~>=~`) &&
      n["Index Cond"].includes(`${column} ~<~`)
  )

describe.concurrent("search index: engine spike", () => {
  it("applies the generated column and the text_pattern_ops index, replans empty, and is a range under RLS", async () => {
    const model = await compiled({
      [NOTES]: spikeNotes(),
      "sql/app/notes-read.sql": READ_POLICY,
    })
    await inTarget(EMPTY, async (url) => {
      await establish(url, model)
      const again = await plan(url, model)
      expect(again.status).toBe("unchanged")
      expect(again.diagnostics.map((d) => d.code)).not.toContain("apply.drift")

      await seed(url)
      const nodes = await explainAsUser(
        url,
        `select id from app.notes where starts_with(note_norm, lower('note 12' COLLATE "default"))`
      )
      expect(prefixRange(nodes, "note_norm")).toHaveLength(1)
      // Без `^@` у прямій формі `ILIKE` той самий індекс не діє: контроль,
      // що діапазон дав саме leakproof-оператор
      const like = await explainAsUser(
        url,
        `select id from app.notes where note_norm ilike 'note 12%'`
      )
      expect(prefixRange(like, "note_norm")).toEqual([])
    })
  })
})

/** Вираз нормалізованої колонки найменування так, як його показує база. */
const DESCRIPTION_SEARCH = `"left"(lower(((description)::text COLLATE "default")), ${SEARCH_PREFIX_CHARS})`

/**
 * Значення найгіршого кодування: `chars` різних 4-байтових символів (поза
 * BMP), що майже не стискаються, — повний `lower` такого значення не влазить
 * у рядок btree (54000). \`seed\` дає різні значення.
 */
const wideValue = (chars: number, seed: string) =>
  `(select string_agg(chr(65536 + (g * 7919 + ${seed} * 104729) % 900000), '')
      from generate_series(1, ${chars}) g)`

/** Колонка й індекс таблиці так, як їх бачить сама база. */
async function searchColumnOf(url: string, table: string, column: string) {
  const [shape] = await query(
    url,
    `select c.is_generated, c.generation_expression,
            (select indexdef from pg_indexes i
              where i.schemaname = 'app' and i.tablename = $1
                and i.indexdef like '%' || $2 || '%') as indexdef
       from information_schema.columns c
      where c.table_schema = 'app' and c.table_name = $1 and c.column_name = $2`,
    [table, column]
  )
  return shape
}

describe.concurrent("search index: derived from the search fields", () => {
  it("a catalog gets the column and the index of its default search field", async () => {
    const model = await compiled({ [PARTY]: party() })
    await inTarget(EMPTY, async (url) => {
      await establish(url, model)
      expect(await searchColumnOf(url, "party", "description_search")).toEqual({
        is_generated: "ALWAYS",
        generation_expression: DESCRIPTION_SEARCH,
        indexdef: expect.stringMatching(
          /USING btree \(description_search text_pattern_ops\)$/
        ),
      })
      await query(
        asSuperuser(url),
        `insert into app.party (id, description, code)
           values ('00000000-0000-4000-8000-000000000001', 'Ковбаса Ab', '1')`
      )
      expect(
        await query(url, "select description_search from app.party")
      ).toEqual([{ description_search: "ковбаса ab" }])
      const again = await plan(url, model)
      expect(again.status).toBe("unchanged")
      expect(again.diagnostics.map((d) => d.code)).not.toContain("apply.drift")
    })
  })

  it("search on an adopted table adds the column as a table rewrite without permission", async () => {
    const before = await compiled({ [NOTES]: notes() })
    const after = await compiled({
      [NOTES]: {
        ...(notes() as unknown as Json),
        search: { fields: ["note"] },
      },
    })
    await inTarget(EMPTY, async (url) => {
      await establish(url, before)
      await query(
        asSuperuser(url),
        `insert into app.notes (id, note)
           values ('00000000-0000-4000-8000-000000000001', 'Note A')`
      )
      const artifact = planned(await plan(url, after))
      const [add] = stepMatching(
        artifact,
        /ADD COLUMN "note_search" text GENERATED ALWAYS AS .* STORED/
      )
      const [index] = stepMatching(
        artifact,
        /CREATE INDEX notes_note_search_idx/
      )
      expect(add?.class).toBe("tableRewrite")
      expect(index?.class).toBe("catalogOnly")
      // Переписування, як і решта, дозволу не вимагає (платформна спека §6.6)
      expect(artifact.requiredPermissions).toEqual([])

      await applyArtifact(url, artifact, after)

      expect(await query(url, "select note_search from app.notes")).toEqual([
        { note_search: "note a" },
      ])
      const again = await plan(url, after)
      expect(again.status).toBe("unchanged")
      expect(again.diagnostics.map((d) => d.code)).not.toContain("apply.drift")
    })
  })

  it("a type change of a searched column recomputes the derived column", async () => {
    const before = await compiled({ [PARTY]: party() })
    const after = await compiled({
      [PARTY]: { ...(party() as unknown as Json), descriptionLength: 200 },
    })
    await inTarget(EMPTY, async (url) => {
      await establish(url, before)
      await query(
        asSuperuser(url),
        `insert into app.party (id, description, code)
           values ('00000000-0000-4000-8000-000000000001', 'Ковбаса Ab', '1')`
      )
      const artifact = planned(await plan(url, after))
      const [drop] = stepMatching(artifact, /DROP COLUMN "?description_search/)
      expect(drop?.class).toBe("catalogOnly")
      expect(artifact.requiredPermissions).toEqual([])

      await applyArtifact(url, artifact, after)

      expect(await searchColumnOf(url, "party", "description_search")).toEqual({
        is_generated: "ALWAYS",
        generation_expression: DESCRIPTION_SEARCH,
        indexdef: expect.stringMatching(
          /USING btree \(description_search text_pattern_ops\)$/
        ),
      })
      expect(
        await query(url, "select description_search from app.party")
      ).toEqual([{ description_search: "ковбаса ab" }])
      const again = await plan(url, after)
      expect(again.status).toBe("unchanged")
      expect(again.diagnostics.map((d) => d.code)).not.toContain("apply.drift")
    })
  })

  it("a type change of a searched column applies when the engine also replaces the derived index", async () => {
    const before = await compiled({ [PARTY]: party() })
    // Ім'я похідного індексу каталогу зайняте індексом нової прийнятої
    // таблиці: бажаний похідний індекс отримує інше ім'я, двигун знімає лише
    // старий індекс (колонка лишається), а зміна типу джерела все одно
    // впирається в похідну колонку (0A000)
    const after = await compiled({
      [PARTY]: { ...(party() as unknown as Json), descriptionLength: 200 },
      [NOTES]: {
        ...(notes() as unknown as Json),
        indexes: [
          { name: "party_description_search_idx", keys: [{ column: "note" }] },
        ],
      },
    })
    await inTarget(EMPTY, async (url) => {
      await establish(url, before)
      await query(
        asSuperuser(url),
        `insert into app.party (id, description, code)
           values ('00000000-0000-4000-8000-000000000001', 'Ковбаса Ab', '1')`
      )
      const artifact = planned(await plan(url, after))
      const sql = artifact.steps.map((s) => s.sql)
      expect(
        sql.some((s) => /DROP INDEX .*party_description_search_idx\b/.test(s))
      ).toBe(true)

      await applyArtifact(url, artifact, after)

      expect(await searchColumnOf(url, "party", "description_search")).toEqual({
        is_generated: "ALWAYS",
        generation_expression: DESCRIPTION_SEARCH,
        indexdef: expect.stringMatching(
          /INDEX party_description_search_idx1 ON .*USING btree \(description_search text_pattern_ops\)$/
        ),
      })
      expect(
        await query(url, "select description_search from app.party")
      ).toEqual([{ description_search: "ковбаса ab" }])
      expect((await plan(url, after)).status).toBe("unchanged")
    })
  })

  it("a field leaving search drops the derived column without permission", async () => {
    const before = await compiled({ [PARTY]: party() })
    const after = await compiled({
      [PARTY]: { ...(party() as unknown as Json), search: { fields: [] } },
    })
    await inTarget(EMPTY, async (url) => {
      await establish(url, before)
      const artifact = planned(await plan(url, after))
      const [drop] = stepMatching(artifact, /DROP COLUMN "?description_search/)
      // Значення похідної колонки обчислює база: втрати даних немає
      expect(drop?.class).toBe("catalogOnly")
      expect(artifact.requiredPermissions).toEqual([])

      await applyArtifact(url, artifact, after)

      expect(await searchColumnOf(url, "party", "description_search")).toBe(
        undefined
      )
      const again = await plan(url, after)
      expect(again.status).toBe("unchanged")
    })
  })

  it("a field leaving search while its column changes type: the drop goes first", async () => {
    const before = await compiled({ [PARTY]: party() })
    const after = await compiled({
      [PARTY]: {
        ...(party() as unknown as Json),
        descriptionLength: 200,
        search: { fields: [] },
      },
    })
    await inTarget(EMPTY, async (url) => {
      await establish(url, before)
      const artifact = planned(await plan(url, after))
      const sql = artifact.steps.map((s) => s.sql)
      const drop = sql.findIndex((s) =>
        /DROP COLUMN "?description_search/.test(s)
      )
      const alter = sql.findIndex((s) =>
        /ALTER COLUMN "description" TYPE/.test(s)
      )
      expect(drop).toBeGreaterThanOrEqual(0)
      expect(alter).toBeGreaterThan(drop)
      expect(artifact.requiredPermissions).toEqual([])

      await applyArtifact(url, artifact, after)

      expect(await searchColumnOf(url, "party", "description_search")).toBe(
        undefined
      )
      expect((await plan(url, after)).status).toBe("unchanged")
    })
  })

  it("a value longer than the prefix bound is adopted into the index and saved", async () => {
    const text = { type: "Text" }
    const before = await compiled({ [NOTES]: notes(text) })
    const after = await compiled({
      [NOTES]: {
        ...(notes(text) as unknown as Json),
        search: { fields: ["note"] },
      },
    })
    await inTarget(EMPTY, async (url) => {
      await establish(url, before)
      // Прийняті дані: довгі значення є до появи індексу
      await query(
        asSuperuser(url),
        `insert into app.notes (id, note)
           select gen_random_uuid(), ${wideValue(3000, "k")}
             from generate_series(1, 2) k`
      )
      const artifact = planned(await plan(url, after))
      await applyArtifact(url, artifact, after)

      // Збереження довгого значення в таблицю з індексом
      await query(
        asSuperuser(url),
        `insert into app.notes (id, note) values (gen_random_uuid(), ${wideValue(3000, "7")})`
      )
      expect(
        await query(
          url,
          `select char_length(note_search) as chars,
                  note_search = left(lower(note), ${SEARCH_PREFIX_CHARS}) as prefix
             from app.notes`
        )
      ).toEqual(
        Array.from({ length: 3 }, () => ({
          chars: SEARCH_PREFIX_CHARS,
          prefix: true,
        }))
      )
      expect((await plan(url, after)).status).toBe("unchanged")
    })
  })

  it("removing a searched attribute drops index, derived column and source; only the source drop is destructive", async () => {
    const note = attribute("note", {
      id: uuid(9220),
      type: "String",
      length: 50,
    })
    const before = await compiled({
      [PARTY]: {
        ...(party([note]) as unknown as Json),
        search: { fields: ["description", "note"] },
      },
    })
    const after = await compiled({
      [PARTY]: {
        ...(party() as unknown as Json),
        search: { fields: ["description"] },
      },
    })
    await inTarget(EMPTY, async (url) => {
      await establish(url, before)
      await query(
        asSuperuser(url),
        `insert into app.party (id, description, code, note)
           values ('00000000-0000-4000-8000-000000000001', 'Ковбаса', '1', 'Нотатка')`
      )
      const artifact = planned(await plan(url, after))
      const sql = artifact.steps.map((s) => s.sql)
      const at = (pattern: RegExp) => sql.findIndex((s) => pattern.test(s))
      const index = at(/DROP INDEX .*party_note_search_idx/)
      const derived = at(/DROP COLUMN "?note_search"?$/)
      const source = at(/DROP COLUMN "?note"?$/)
      expect(index).toBeGreaterThanOrEqual(0)
      expect(derived).toBeGreaterThan(index)
      expect(source).toBeGreaterThan(derived)
      // Значення похідної колонки обчислює база; втрачене — лише джерело
      expect(artifact.steps[derived]!.class).toBe("catalogOnly")
      expect(artifact.steps[source]!.class).toBe("destructive")
      expect(artifact.requiredPermissions).toEqual([artifact.steps[source]!.id])

      await applyArtifact(url, artifact, after)

      expect(await searchColumnOf(url, "party", "note_search")).toBe(undefined)
      expect((await plan(url, after)).status).toBe("unchanged")
    })
  })

  it("a field entering search while its column changes type", async () => {
    const before = await compiled({
      [PARTY]: { ...(party() as unknown as Json), search: { fields: [] } },
    })
    const after = await compiled({
      [PARTY]: { ...(party() as unknown as Json), descriptionLength: 200 },
    })
    await inTarget(EMPTY, async (url) => {
      await establish(url, before)
      await query(
        asSuperuser(url),
        `insert into app.party (id, description, code)
           values ('00000000-0000-4000-8000-000000000001', 'Ковбаса Ab', '1')`
      )
      const artifact = planned(await plan(url, after))
      expect(artifact.requiredPermissions).toEqual([])

      await applyArtifact(url, artifact, after)

      expect(await searchColumnOf(url, "party", "description_search")).toEqual({
        is_generated: "ALWAYS",
        generation_expression: DESCRIPTION_SEARCH,
        indexdef: expect.stringMatching(
          /USING btree \(description_search text_pattern_ops\)$/
        ),
      })
      expect(
        await query(url, "select description_search from app.party")
      ).toEqual([{ description_search: "ковбаса ab" }])
      expect((await plan(url, after)).status).toBe("unchanged")
    })
  })
})
