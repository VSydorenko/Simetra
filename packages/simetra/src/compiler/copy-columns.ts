import type { PhysicalTable } from "simetra/model"
import type { SqlParser } from "./sql/parse"

/**
 * Колонки таблиці, чиє значення змінюється без підвищення версії рядка
 * (позначка `copy` каталогу, П4-B §3): копії носіїв прав (`origin.copyOf`) —
 * їх переписує платформа зі зміною джерела — і генеровані колонки, чий вираз
 * читає таку колонку, до нерухомої точки (генерована з генерованої з копії).
 * Маркер `known` несе ці колонки поточними: незмінна версія про них нічого не
 * доводить.
 */
export function copyColumns(
  table: PhysicalTable,
  parse: SqlParser
): ReadonlySet<string> {
  const copies = new Set(
    table.columns
      .filter((c) => c.origin.copyOf !== undefined)
      .map((c) => c.name)
  )
  const generated = table.columns.flatMap((c) =>
    c.generated === undefined
      ? []
      : [{ name: c.name, reads: readColumns(c.generated.expression, parse) }]
  )
  let grown = true
  while (grown) {
    grown = false
    for (const column of generated) {
      if (copies.has(column.name)) continue
      // Нерозібраний вираз (недосяжно в моделі без помилок) — копія: зайва
      // колонка маркера лише важча, а пропущена дала б застаріле значення.
      if (
        column.reads === undefined ||
        [...column.reads].some((name) => copies.has(name))
      ) {
        copies.add(column.name)
        grown = true
      }
    }
  }
  return copies
}

/**
 * Імена колонок, які читає вираз генерованої колонки. Postgres дозволяє йому
 * лише колонки своєї таблиці, тож ім'я — останнє поле `ColumnRef`; парсер уже
 * звів незакавичені імена до нижнього регістру. `undefined` — не розібрано.
 */
function readColumns(
  expression: string,
  parse: SqlParser
): ReadonlySet<string> | undefined {
  const parsed = parse(`SELECT (${expression})`)
  if (!parsed.ok) return undefined
  const names = new Set<string>()
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    if (typeof value !== "object" || value === null) return
    const node = value as Record<string, unknown>
    const ref = node.ColumnRef as
      { fields?: { String?: { sval?: string } }[] } | undefined
    const name = ref?.fields?.at(-1)?.String?.sval
    if (name !== undefined) names.add(name)
    for (const inner of Object.values(node)) visit(inner)
  }
  for (const statement of parsed.statements) visit(statement.stmt)
  return names
}
