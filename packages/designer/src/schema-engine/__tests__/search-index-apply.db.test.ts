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
  plan,
  USER,
  useBuildPlanRoles,
} from "./build-plan.support"
import { asSuperuser, query } from "../../__tests__/support/db"
import { uuid } from "../../../../simetra/test/support"

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

/** План запиту від ролі запиту; транзакція відкочується. */
async function explainAs(
  url: string,
  role: string,
  sql: string
): Promise<PlanNode[]> {
  const client = new pg.Client({ connectionString: asSuperuser(url) })
  await client.connect()
  try {
    await client.query("begin")
    // Схему застосунку роль API бачить через гранти платформи; ціль спайку
    // їх не має, тож USAGE — лише в цій транзакції
    await client.query(`grant usage on schema app to ${role}`)
    await client.query(`set local role ${role}`)
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
      const nodes = await explainAs(
        url,
        USER,
        `select id from app.notes where starts_with(note_norm, lower('note 12' COLLATE "default"))`
      )
      expect(prefixRange(nodes, "note_norm")).toHaveLength(1)
      // Без `^@` у прямій формі `ILIKE` той самий індекс не діє: контроль,
      // що діапазон дав саме leakproof-оператор
      const like = await explainAs(
        url,
        USER,
        `select id from app.notes where note_norm ilike 'note 12%'`
      )
      expect(prefixRange(like, "note_norm")).toEqual([])
    })
  })
})
