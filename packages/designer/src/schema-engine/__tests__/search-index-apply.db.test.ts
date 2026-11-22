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
import { PROVIDER_API_ROLES } from "simetra/model"
import { testProvider, uuid } from "../../../../simetra/test/support"

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
        generation_expression: `lower(((description)::text COLLATE "default"))`,
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
        generation_expression: `lower(((description)::text COLLATE "default"))`,
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
})
