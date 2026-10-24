import { describe, expect, it } from "vitest"
import { carrierBackfillStatements } from "simetra/compiler"
import type { PhysicalTable } from "simetra/model"
import {
  carrierBackfillRefusals,
  carrierBackfillSteps,
  pendingCarrierCopies,
  stepFootprint,
  tableKey,
  type ApplyTransaction,
  type FootprintModels,
} from "simetra/schema"
import {
  ATTACHMENTS_TABLE,
  CHECKLIST_TABLE,
  TASK_NOTE_ADOPTED_TABLE,
  compileRights,
  policyDomain,
  promotableTaskNote,
  promotedRights,
  taskNoteMapping,
} from "../../../compiler/__tests__/fixtures/rights"

/**
 * Копії носіїв без значень (Р2a2-11) і кроки даних плану, що їх заповнюють
 * (Р2b2-1, Р2b2-6): яка копія чекає значень і який крок, SQL та замок її
 * заповнюють.
 */

const CHECKLIST = { schema: "public", name: CHECKLIST_TABLE }
const LEGACY = { schema: "public", name: "legacy_checklist" }
const COPIES = ["assignee_id", "project_id", "region_id"]

async function checklist(): Promise<PhysicalTable> {
  const compiled = await compileRights(policyDomain())
  return compiled.model!.physical.tables.find(
    (t) => t.name === CHECKLIST_TABLE
  )!
}

/** Таблиця, у якій колонки `names` — не копії, а звичайні колонки. */
const withoutCopyOf = (
  table: PhysicalTable,
  names: readonly string[]
): PhysicalTable => ({
  ...table,
  columns: table.columns.map((c) =>
    names.includes(c.name)
      ? { ...c, origin: { elementId: "00000000-0000-4000-8000-000000000001" } }
      : c
  ),
})

const withoutColumns = (
  table: PhysicalTable,
  names: readonly string[]
): PhysicalTable => ({
  ...table,
  columns: table.columns.filter((c) => !names.includes(c.name)),
})

describe("pendingCarrierCopies", () => {
  it.each([
    {
      case: "already-copy",
      applied: (t: PhysicalTable) => [t],
      created: [],
      expected: [],
    },
    {
      // Видалений реквізит ТЧ з даними під іменем копії: старі значення не
      // стають копією
      case: "same-name-not-copy",
      applied: (t: PhysicalTable) => [withoutCopyOf(t, ["assignee_id"])],
      created: [],
      expected: [{ table: CHECKLIST, columns: ["assignee_id"] }],
    },
    {
      case: "other-source",
      applied: (t: PhysicalTable) => [
        {
          ...t,
          columns: t.columns.map((c) =>
            c.name === "region_id" && c.origin.copyOf !== undefined
              ? {
                  ...c,
                  origin: { copyOf: { ...c.origin.copyOf, through: "other" } },
                }
              : c
          ),
        },
      ],
      created: [],
      expected: [{ table: CHECKLIST, columns: ["region_id"] }],
    },
    {
      case: "created",
      applied: () => [],
      created: [`table:public.${CHECKLIST_TABLE}`],
      expected: [],
    },
    {
      case: "new-copy",
      applied: (t: PhysicalTable) => [withoutColumns(t, COPIES)],
      created: [],
      expected: [{ table: CHECKLIST, columns: COPIES }],
    },
    {
      case: "fresh",
      applied: undefined,
      created: [],
      expected: [{ table: CHECKLIST, columns: COPIES }],
    },
  ])("$case", async ({ applied, created, expected }) => {
    const table = await checklist()
    const pending = pendingCarrierCopies(
      { tables: [table] },
      applied === undefined ? undefined : { tables: applied(table) },
      new Set(created)
    )
    expect(pending).toEqual(expected)
  })

  it("promotion: an adopted column of the copy's name is not a copy, reported in the new name", async () => {
    // Крок іде після кроків двигуна, коли таблиця вже в новому імені; старе
    // ім'я лише шукає її в знімку `applied` (Р2b2-6)
    const table = await checklist()
    const adopted = { ...withoutCopyOf(table, COPIES), name: LEGACY.name }
    const pending = pendingCarrierCopies(
      { tables: [table] },
      { tables: [adopted] },
      new Set(),
      (t) => (t.name === CHECKLIST_TABLE ? LEGACY : t)
    )
    expect(pending).toEqual([{ table: CHECKLIST, columns: COPIES }])
  })
})

/** Моделі сліду кроку копій: лише переклад нових імен у вихідні. */
const footprintModels = (
  newToOld: ReadonlyMap<string, string> = new Map()
): FootprintModels => {
  const empty = { tables: [], enumTypes: [], units: [] }
  return {
    source: empty,
    desired: empty,
    typeChanges: [],
    newToOld,
    columnsNewToOld: new Map(),
    live: [],
    providerStatements: new Map(),
    providerLocks: [],
  }
}

describe("carrierBackfillSteps", () => {
  it("one dataStep per link, after the given offset", async () => {
    const physical = (await compileRights(policyDomain())).model!.physical
    const pending = [{ table: CHECKLIST, columns: COPIES }]
    const statements = carrierBackfillStatements(physical, pending)
    expect(statements.length).toBeGreaterThan(0)
    const steps = carrierBackfillSteps(physical, pending, 3)
    expect(steps).toEqual(
      statements.map((s, i) => ({
        id: `s${4 + i}`,
        origin: "carriers",
        sql: s.sql,
        verb: "alter",
        class: "dataStep",
        lockClass: "shareRowExclusive",
        transactionality: "transactional",
        newSegmentBefore: false,
        lockedTables: [s.table, s.source],
        produces: [],
        consumes: [],
        destroys: [],
        produced: [],
        destroyed: [],
        consumed: [],
        dataLoss: false,
        rewriteRisk: false,
        guards: [],
      }))
    )
  })

  it("no steps without pending copies", async () => {
    const physical = (await compileRights(policyDomain())).model!.physical
    expect(carrierBackfillSteps(physical, [], 0)).toEqual([])
  })

  it("marker snapshot to footprint: a step for the table with rows, none for a table the plan creates", async () => {
    // Ланцюг плану (Р2a2-11, Р2b2-1): у marker колонки копій `checklist` і
    // `attachments` не були копіями; `attachments` план створює наново
    const physical = (await compileRights(policyDomain())).model!.physical
    const applied = physical.tables.map((t) =>
      [CHECKLIST_TABLE, ATTACHMENTS_TABLE].includes(t.name)
        ? withoutCopyOf(
            t,
            t.columns.filter((c) => c.origin.copyOf).map((c) => c.name)
          )
        : t
    )
    const pending = pendingCarrierCopies(
      physical,
      { tables: applied },
      new Set([`table:public.${ATTACHMENTS_TABLE}`])
    )
    const steps = carrierBackfillSteps(physical, pending, 0)
    expect(steps.length).toBeGreaterThan(0)
    for (const step of steps) {
      const [own, source] = step.lockedTables
      expect(own).toEqual(CHECKLIST)
      expect(stepFootprint(step, footprintModels())).toEqual([
        { ...CHECKLIST, mode: "shareRowExclusive" },
        { ...source, mode: "shareRowExclusive" },
      ])
    }
  })

  it("a table renamed by the promotion gets its step in the new name", async () => {
    // Р2b2-6: копія носія лягає на таблицю, яку промоція перейменовує;
    // крок іде після кроків двигуна, тож SQL і `lockedTables` — у новому
    // імені, а слід (замок від початку транзакції) — у старому
    const { before, desired } = await promotedRights(
      promotableTaskNote(),
      taskNoteMapping()
    )
    const renamed = { schema: "public", name: "task_note" }
    const old = { schema: "public", name: TASK_NOTE_ADOPTED_TABLE }
    expect(
      desired.physical.tables.some((t) => t.name === TASK_NOTE_ADOPTED_TABLE)
    ).toBe(false)
    const pending = pendingCarrierCopies(
      desired.physical,
      before.physical,
      new Set(),
      (t) => (t.name === renamed.name ? old : t)
    )
    expect(pending).toEqual([
      { table: renamed, columns: ["task_id_assignee_id"] },
    ])
    const [step, ...rest] = carrierBackfillSteps(desired.physical, pending, 0)
    expect(rest).toEqual([])
    const [statement] = carrierBackfillStatements(desired.physical, pending)
    expect(step).toMatchObject({
      sql: statement!.sql,
      lockedTables: [renamed, { schema: "public", name: "task" }],
    })
    expect(
      stepFootprint(
        step!,
        footprintModels(
          new Map([
            [
              tableKey(renamed.schema, renamed.name),
              tableKey(old.schema, old.name),
            ],
          ])
        )
      )
    ).toEqual([
      { ...old, mode: "shareRowExclusive" },
      { schema: "public", name: "task", mode: "shareRowExclusive" },
    ])
  })
})

describe("carrierBackfillRefusals", () => {
  /** Фейкова транзакція: `EXISTS` відповідає `found`. */
  function fakeTx(found: boolean) {
    const statements: string[] = []
    const tx: ApplyTransaction = {
      query: async <R extends Record<string, unknown>>(sql: string) => {
        statements.push(sql)
        return (sql.startsWith("SELECT EXISTS")
          ? [{ found }]
          : []) as unknown as R[]
      },
      extract: () => Promise.reject(new Error("no extract expected")),
    }
    return { tx, statements }
  }

  const pending = [{ table: CHECKLIST, columns: ["assignee_id", "region_id"] }]

  it("refuses a table with rows, reading it with row security off first", async () => {
    const { tx, statements } = fakeTx(true)
    expect(await carrierBackfillRefusals(tx, pending)).toMatchObject([
      {
        code: "plan.carrier-backfill-missing",
        severity: "error",
        params: {
          table: `public.${CHECKLIST_TABLE}`,
          columns: "assignee_id, region_id",
        },
      },
    ])
    expect(statements).toEqual([
      "SET LOCAL row_security = off",
      `SELECT EXISTS (SELECT 1 FROM public.${CHECKLIST_TABLE}) AS found`,
    ])
  })

  it("passes an empty table", async () => {
    const { tx, statements } = fakeTx(false)
    expect(await carrierBackfillRefusals(tx, pending)).toEqual([])
    expect(statements[0]).toBe("SET LOCAL row_security = off")
  })
})
