import type { QualifiedName } from "simetra/compiler"
import {
  quoteIdent,
  type CarrierCopyOf,
  type PhysicalColumn,
  type PhysicalSnapshot,
} from "simetra/model"
import type { EngineDiagnostic } from "../engine"
import { applyDiagnostic } from "./diagnostic"
import type { ApplyTransaction } from "./port"
import { tableKey } from "./table-key"

/** Таблиця з копіями носіїв, яким план не дає значень. */
export interface PendingCarrierCopies {
  table: QualifiedName
  columns: string[]
}

const sameCopy = (a: CarrierCopyOf, b: CarrierCopyOf | undefined): boolean =>
  b !== undefined &&
  a.table.schema === b.table.schema &&
  a.table.name === b.table.name &&
  a.column === b.column &&
  a.through === b.through

/**
 * Копії носіїв бажаного стану, яким план не дає значень (Р2a2-11): кроку
 * даних для копій ще немає (план Права-2b), а тригер носіїв виводить копію
 * лише на запис рядка, тож наявні рядки лишилися б з порожньою копією — і
 * політики читання за нею їх не бачили б, або, гірше, бачили б за чужим
 * значенням.
 *
 * Копія вже жива, лише коли в знімку останнього застосування (`applied`,
 * marker цілі) та сама колонка — копія з тим самим `copyOf`: тоді тригери її
 * підтримували. Одна лише наявність колонки з тим самим ім'ям не рахується:
 * видалений реквізит ТЧ `assignee_id` з даними чи прийнята колонка промоції
 * дали б старі значення за копію. Таблиця, яку план створює (`created` —
 * ідентичності `table:<схема>.<ім'я>` з `produces` дій двигуна), рядків не
 * має. `oldName` — ім'я таблиці на цілі, коли воно інше (промоція, `applied`
 * у старих іменах); звіт — теж у ньому, бо `EXISTS` читає живу ціль.
 */
export function pendingCarrierCopies(
  desired: Pick<PhysicalSnapshot, "tables">,
  applied: Pick<PhysicalSnapshot, "tables"> | undefined,
  created: ReadonlySet<string>,
  oldName: (table: QualifiedName) => QualifiedName = (table) => table
): PendingCarrierCopies[] {
  const appliedTables = new Map(
    (applied?.tables ?? []).map((t) => [tableKey(t.schema, t.name), t])
  )
  const pending: PendingCarrierCopies[] = []
  for (const table of desired.tables) {
    const copies = table.columns.filter(
      (c): c is PhysicalColumn & { origin: { copyOf: CarrierCopyOf } } =>
        c.origin.copyOf !== undefined
    )
    if (copies.length === 0) continue
    if (created.has(`table:${table.schema}.${table.name}`)) continue
    const live = oldName({ schema: table.schema, name: table.name })
    const before = appliedTables.get(tableKey(live.schema, live.name))
    const columns = copies
      .filter(
        (c) =>
          !sameCopy(
            c.origin.copyOf,
            before?.columns.find((b) => b.name === c.name)?.origin.copyOf
          )
      )
      .map((c) => c.name)
    if (columns.length > 0) pending.push({ table: live, columns })
  }
  return pending
}

/**
 * Відмова `plan.carrier-backfill-missing` на кожну таблицю з копіями без
 * значень, у якій уже є рядок. `row_security = off` — як у `DATA_SETTINGS`:
 * під `FORCE ROW LEVEL SECURITY` власник без `BYPASSRLS` інакше бачив би
 * лише рядки, які пропускають політики, і порожня з погляду політик таблиця
 * дала б тихий «рядків немає». З `off` Postgres такий запит відхиляє
 * помилкою — план падає гучно, а не пропускає дані без копій. Транзакцію
 * відкочує той, хто її відкрив, тож налаштування не виходить за неї.
 */
export async function carrierBackfillRefusals(
  tx: ApplyTransaction,
  pending: readonly PendingCarrierCopies[]
): Promise<EngineDiagnostic[]> {
  if (pending.length === 0) return []
  await tx.query("SET LOCAL row_security = off")
  const refusals: EngineDiagnostic[] = []
  for (const { table, columns } of pending) {
    const [row] = await tx.query<{ found: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM ${quoteIdent(table.schema)}.${quoteIdent(table.name)}) AS found`
    )
    if (row === undefined) throw new Error("EXISTS returned no row")
    if (row.found)
      refusals.push(
        applyDiagnostic("plan.carrier-backfill-missing", "error", {
          table: `${table.schema}.${table.name}`,
          columns: columns.join(", "),
        })
      )
  }
  return refusals
}
