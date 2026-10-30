import { describe, expect, it } from "vitest"
import { carrierBackfillStatements } from "simetra/compiler"
import type { PhysicalTable } from "simetra/model"
import {
  carrierBackfillSteps,
  createdByPlan,
  pendingCarrierCopies,
  stepFootprint,
  tableKey,
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
 * Копії носіїв без значень (спека прав §5.2) і кроки даних плану, що їх заповнюють
 * (спека промоції §7.2): яка копія чекає значень і який крок, SQL та замок її
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

/**
 * Що створюють дії двигуна плану — структурні `produced`, як їх дає адаптер:
 * таблиці цілком і окремі колонки (`<таблиця>.<колонка>`) у `public`.
 */
const created = (o: { tables?: string[]; columns?: string[] } = {}) =>
  createdByPlan([
    {
      produced: [
        ...(o.tables ?? []).map((name) => ({
          kind: "table",
          schema: "public",
          name,
        })),
        ...(o.columns ?? []).map((c) => {
          const [table, name] = c.split(".") as [string, string]
          return { kind: "column", schema: "public", table, name }
        }),
      ],
    },
  ])

describe("pendingCarrierCopies", () => {
  // Чим колонка копії була в `applied` — випадок 3 (звичайна колонка)
  // перезаписує дані й іде в `overwrites` (спека прав §5.2). Колонку, яку
  // створює двигун цього плану, план заповнює, хоч би що казав `applied`
  it.each([
    {
      case: "already-copy",
      applied: (t: PhysicalTable) => [t],
      created: created(),
      expected: [],
    },
    {
      // Випадок 3: видалений реквізит ТЧ з даними під іменем копії — старі
      // значення не стають копією, а крок їх перезаписує
      case: "same-name-not-copy",
      applied: (t: PhysicalTable) => [withoutCopyOf(t, ["assignee_id"])],
      created: created(),
      expected: [
        {
          table: CHECKLIST,
          columns: ["assignee_id"],
          overwrites: ["assignee_id"],
        },
      ],
    },
    {
      // Випадок 2: копія з іншого джерела — значення похідні, не чужі дані
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
      created: created(),
      expected: [{ table: CHECKLIST, columns: ["region_id"], overwrites: [] }],
    },
    {
      case: "created",
      applied: () => [],
      created: created({ tables: [CHECKLIST_TABLE] }),
      expected: [],
    },
    {
      // Випадок 1: колонки не було
      case: "new-copy",
      applied: (t: PhysicalTable) => [withoutColumns(t, COPIES)],
      created: created(),
      expected: [{ table: CHECKLIST, columns: COPIES, overwrites: [] }],
    },
    {
      // Без знімка (спека прав §5.2) наявна колонка з іменем копії — колонка з даними
      case: "fresh",
      applied: undefined,
      created: created(),
      expected: [{ table: CHECKLIST, columns: COPIES, overwrites: COPIES }],
    },
    {
      // Колонку, створену планом, і без знімка заповнюють без дозволу
      case: "fresh-recreated",
      applied: undefined,
      created: created({ columns: [`${CHECKLIST_TABLE}.assignee_id`] }),
      expected: [
        {
          table: CHECKLIST,
          columns: COPIES,
          overwrites: COPIES.filter((c) => c !== "assignee_id"),
        },
      ],
    },
    {
      // Колонку-копію вручну знято, дрейф прийнято — знімок каже
      // «жива», а двигун відтворює її порожньою
      case: "recreated-copy",
      applied: (t: PhysicalTable) => [t],
      created: created({ columns: [`${CHECKLIST_TABLE}.assignee_id`] }),
      expected: [
        { table: CHECKLIST, columns: ["assignee_id"], overwrites: [] },
      ],
    },
    {
      // Колонку, створену планом, план і заповнює: старі дані губить крок
      // двигуна, що зняв звичайну колонку, і дозвіл просить він
      case: "recreated-over-plain-column",
      applied: (t: PhysicalTable) => [withoutCopyOf(t, ["assignee_id"])],
      created: created({ columns: [`${CHECKLIST_TABLE}.assignee_id`] }),
      expected: [
        { table: CHECKLIST, columns: ["assignee_id"], overwrites: [] },
      ],
    },
  ])("$case", async ({ applied, created, expected }) => {
    const table = await checklist()
    const pending = pendingCarrierCopies(
      { tables: [table] },
      applied === undefined ? undefined : { tables: applied(table) },
      created
    )
    expect(pending).toEqual(expected)
  })

  it("promotion: an unmapped adopted column of the copy's name is overwritten, found under the old name", async () => {
    // Крок іде після кроків двигуна, коли таблиця вже в
    // новому імені; старе ім'я лише шукає її в знімку `applied`. Прийнята
    // колонка `assignee_id`, яку мапінг не взяв, — випадок 3; решти копій у
    // прийнятій таблиці не було — випадок 1
    const table = await checklist()
    const adopted = {
      ...withoutCopyOf(withoutColumns(table, ["project_id", "region_id"]), [
        "assignee_id",
      ]),
      name: LEGACY.name,
    }
    const pending = pendingCarrierCopies(
      { tables: [table] },
      { tables: [adopted] },
      created(),
      (t) => (t.name === CHECKLIST_TABLE ? LEGACY : t)
    )
    expect(pending).toEqual([
      { table: CHECKLIST, columns: COPIES, overwrites: ["assignee_id"] },
    ])
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
    const pending = [{ table: CHECKLIST, columns: COPIES, overwrites: [] }]
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

  it("a statement overwriting a plain column is destructive, the rest stay dataStep", async () => {
    // Колонка `assignee_id` ТЧ була звичайною колонкою з даними —
    // оператор її зв'язку перезаписує чужі дані й потребує дозволу; копія
    // вкладення — чисте заповнення
    const physical = (await compileRights(policyDomain())).model!.physical
    const attachments = { schema: "public", name: ATTACHMENTS_TABLE }
    const steps = carrierBackfillSteps(
      physical,
      [
        { table: CHECKLIST, columns: COPIES, overwrites: ["assignee_id"] },
        {
          table: attachments,
          columns: ["task_id_assignee_id"],
          overwrites: [],
        },
      ],
      0
    )
    expect(
      steps.map((s) => ({
        table: s.lockedTables[0]!.name,
        class: s.class,
        dataLoss: s.dataLoss,
      }))
    ).toEqual([
      { table: CHECKLIST_TABLE, class: "destructive", dataLoss: true },
      { table: ATTACHMENTS_TABLE, class: "dataStep", dataLoss: false },
    ])
  })

  it("no steps without pending copies", async () => {
    const physical = (await compileRights(policyDomain())).model!.physical
    expect(carrierBackfillSteps(physical, [], 0)).toEqual([])
  })

  it("marker snapshot to footprint: a step for the table with rows, none for a table the plan creates", async () => {
    // Ланцюг плану (спека прав §5.2): у marker колонки копій `checklist` і
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
      created({ tables: [ATTACHMENTS_TABLE] })
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
    // Копія носія лягає на таблицю, яку промоція перейменовує;
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
      created(),
      (t) => (t.name === renamed.name ? old : t)
    )
    expect(pending).toEqual([
      { table: renamed, columns: ["task_id_assignee_id"], overwrites: [] },
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
