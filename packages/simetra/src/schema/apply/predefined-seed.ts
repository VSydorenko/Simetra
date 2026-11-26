import type { PredefinedSeedContract, QualifiedName } from "simetra/compiler"
import { quoteIdent, type CatalogModel } from "simetra/model"
import type { EngineDiagnostic } from "../engine"
import { applyDiagnostic } from "./diagnostic"
import type { ApplyTransaction } from "./port"
import { stepId, type PlanStep } from "./steps"
import { tableKey } from "./table-key"

/**
 * Рядки цілі, що стосуються рядка засіву: з його міткою або зі значенням
 * колонки `unique`. Значення — текст (`::text`), бо порівнюються з текстом
 * значень контракту; `absent` — на цілі немає таблиці. Колонки звірки, якої
 * на цілі ще немає, у рядку `NULL`.
 */
export type SeedTargetRows =
  "absent" | readonly Readonly<Record<string, string | null>>[]

/** Рішення звірки рядка засіву з ціллю (Р-B2-8). */
export type SeedVerdict =
  | { status: "seed" }
  | { status: "seeded" }
  | { status: "refused"; diagnostic: EngineDiagnostic }

const text = (value: string | boolean): string => String(value)

const valueOf = (seed: PredefinedSeedContract, column: string): string =>
  text(
    seed.values.find((v) => v.column === column)?.value ??
      // Колонка звірки без значення — дефект контракту компілятора
      (() => {
        throw new Error(`the seed of ${seed.table.name} has no value ${column}`)
      })()
  )

/**
 * Звірка Р-B2-8 над прочитаними рядками. Засів дозволено у двох станах:
 * нічого ще немає (ні рядка з міткою, ні рядка зі значенням колонки `unique`)
 * або рядок з міткою — це рядок засіву (усі колонки `unique` і `fixed` мають
 * значення контракту), і іншого рядка зі значенням `unique` немає. Решта —
 * відмова: `DO NOTHING` проковтнув би зміну основної мови чи лишив би базу без
 * неї, а вставка рядка без мітки з кодом основної впала б `23505`. Таблиця,
 * якої на цілі ще немає, — «основної ще немає».
 */
export function seedVerdict(
  seed: PredefinedSeedContract,
  rows: SeedTargetRows
): SeedVerdict {
  if (rows === "absent") return { status: "seed" }
  const label = (row: Readonly<Record<string, string | null>>) =>
    row[seed.label.column] === seed.label.value
  const labelled = rows.filter(label)
  const others = rows.filter((row) => !label(row))
  const matches = (row: Readonly<Record<string, string | null>>) =>
    [...seed.unique, ...seed.fixed].every(
      (column) => row[column] === valueOf(seed, column)
    )
  if (others.length === 0 && labelled.length === 0) return { status: "seed" }
  if (others.length === 0 && labelled.length === 1 && matches(labelled[0]!))
    return { status: "seeded" }
  return {
    status: "refused",
    diagnostic: applyDiagnostic("apply.primary-language-changed", "error", {
      table: qualified(seed.table),
      language: seed.subject,
    }),
  }
}

const qualified = (t: QualifiedName): string =>
  `${quoteIdent(t.schema)}.${quoteIdent(t.name)}`

/**
 * Читання цілі для звірки (Р-B2-8): рядки з міткою засіву або зі значенням
 * колонки `unique`, серед колонок, які на цілі вже є. Наявність таблиці й
 * колонок — з моделі живої цілі, а не
 * запитом, що впав би й зламав транзакцію. `names` — імена таблиці й колонок
 * на цілі, коли вони інші (промоція); рядки — в іменах контракту.
 */
export async function readSeedTargetRows(
  tx: ApplyTransaction,
  seeds: readonly PredefinedSeedContract[],
  live: Pick<CatalogModel, "tables">,
  names: {
    table: (table: QualifiedName) => QualifiedName
    /** `table` — ім'я контракту. */
    column: (table: QualifiedName, column: string) => string
  } = { table: (t) => t, column: (_t, c) => c }
): Promise<SeedTargetRows[]> {
  const tables = new Map(
    live.tables.map((t) => [tableKey(t.schema, t.name), t])
  )
  const result: SeedTargetRows[] = []
  for (const seed of seeds) {
    const name = names.table(seed.table)
    const table = tables.get(tableKey(name.schema, name.name))
    if (table === undefined) {
      result.push("absent")
      continue
    }
    const columns = [seed.label.column, ...seed.unique, ...seed.fixed]
    const onTarget = (c: string) => names.column(seed.table, c)
    const present = (c: string) =>
      table.columns.some((t) => t.name === onTarget(c))
    // Колонки, якої на цілі ще немає (роль додано на наявний довідник), рядок
    // не має: `NULL` не збігається зі значенням засіву, тож рядок з міткою
    // чи з кодом основної без `is_primary`/`state` — відмова, а не тихий
    // `DO NOTHING` чи `23505` на застосуванні
    const keys = [
      { column: seed.label.column, value: seed.label.value },
      ...seed.unique.map((c) => ({ column: c, value: valueOf(seed, c) })),
    ].filter((k) => present(k.column))
    if (keys.length === 0) {
      result.push([])
      continue
    }
    const where = keys
      .map((k, i) => `${quoteIdent(onTarget(k.column))}::text = $${i + 1}`)
      .join(" OR ")
    const select = columns
      .map(
        (c) =>
          `${present(c) ? `${quoteIdent(onTarget(c))}::text` : "NULL::text"} AS ${quoteIdent(c)}`
      )
      .join(", ")
    result.push(
      await tx.query<Record<string, string | null>>(
        `SELECT ${select} FROM ${qualified(name)} WHERE ${where}`,
        keys.map((k) => k.value)
      )
    )
  }
  return result
}

const literal = (value: string | boolean): string =>
  typeof value === "boolean"
    ? String(value)
    : `'${value.replaceAll("'", "''")}'`

/**
 * Оператор засіву (Р-B2-7): ключ — `gen_random_uuid()`, мітка — арбітр
 * `ON CONFLICT` за предикатом її часткового індексу, тож повтор після
 * засіяного рядка нічого не пише.
 */
export function predefinedSeedSql(seed: PredefinedSeedContract): string {
  const columns = [
    seed.keyColumn,
    ...seed.values.map((v) => v.column),
    seed.label.column,
  ].map(quoteIdent)
  const values = [
    "pg_catalog.gen_random_uuid()",
    ...seed.values.map((v) => literal(v.value)),
    literal(seed.label.value),
  ]
  return `INSERT INTO ${qualified(seed.table)} (${columns.join(", ")}) VALUES (${values.join(", ")}) ON CONFLICT (${quoteIdent(seed.label.column)}) WHERE ${seed.label.where} DO NOTHING`
}

/**
 * Кроки засіву (Р-B2-7) — лише для рядків у стані «ще немає» (Р-B2-8): на
 * засіяній цілі кроку немає, тож повторний план кроку змін не дає. Стоять
 * після DDL і блоку `versions`: таблиця, її тригери й послідовність версій
 * уже є. Замок `SHARE ROW EXCLUSIVE`, як у кроку копій: чужа вставка між
 * читанням кроку й `COMMIT` не проскочить.
 */
export function predefinedSeedSteps(
  seeds: readonly { seed: PredefinedSeedContract; verdict: SeedVerdict }[],
  offset: number
): PlanStep[] {
  return seeds
    .filter(({ verdict }) => verdict.status === "seed")
    .map(({ seed }, i): PlanStep => ({
      id: stepId(offset + i),
      origin: "seeds",
      sql: predefinedSeedSql(seed),
      verb: "alter",
      class: "dataStep",
      lockClass: "shareRowExclusive",
      transactionality: "transactional",
      newSegmentBefore: false,
      lockedTables: [{ schema: seed.table.schema, name: seed.table.name }],
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
}
