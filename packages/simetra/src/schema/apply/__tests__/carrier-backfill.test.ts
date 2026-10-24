import { describe, expect, it } from "vitest"
import type { PhysicalTable } from "simetra/model"
import {
  carrierBackfillRefusals,
  pendingCarrierCopies,
  type ApplyTransaction,
} from "simetra/schema"
import {
  CHECKLIST_TABLE,
  compileRights,
  policyDomain,
} from "../../../compiler/__tests__/fixtures/rights"

/**
 * Відмова плану без кроку даних для копій носіїв (Р2a2-11): яка копія не
 * має значень і як план питає, чи є в таблиці рядки.
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

  it("promotion: an adopted column of the copy's name is not a copy, reported in the old name", async () => {
    const table = await checklist()
    const adopted = { ...withoutCopyOf(table, COPIES), name: LEGACY.name }
    const pending = pendingCarrierCopies(
      { tables: [table] },
      { tables: [adopted] },
      new Set(),
      (t) => (t.name === CHECKLIST_TABLE ? LEGACY : t)
    )
    expect(pending).toEqual([{ table: LEGACY, columns: COPIES }])
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
