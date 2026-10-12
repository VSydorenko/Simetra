import type { PromotionRecord, SqlParser } from "simetra/compiler"
import { quoteIdent, type PhysicalSnapshot } from "simetra/model"
import type { PreservedTable } from "../artifact"
import { tableKey } from "../table-key"
import { stringsOf } from "../type-guard"
import type { RenameIntent } from "./intent"

/**
 * Що заміри збереження порівнюють (рішення 6 плану П3-2a): для кожної
 * таблиці одиниці — ключ рядка й пари змаплених колонок як SQL-вирази в
 * старих і нових іменах. Колонки `retired` сюди не потрапляють: їхні дані
 * свідомо не переносяться.
 *
 * `typeChangeSteps` — `JSON.stringify([схема, нова таблиця, нова колонка])`
 * → id кроку двигуна, що змінює тип колонки: ним невдале приведення в замірі
 * «до» назветься `apply.type-narrowing`.
 */
export function preservationPlan(
  record: PromotionRecord,
  intent: RenameIntent,
  before: Pick<PhysicalSnapshot, "tables">,
  typeChangeSteps: ReadonlyMap<string, string>
): PreservedTable[] {
  return record.tables.map((t) => {
    const newKey = tableKey(t.schema, t.to)
    const [oldSchema, oldName] = JSON.parse(
      intent.tablesNewToOld.get(newKey) ?? newKey
    ) as [string, string]
    const source = before.tables.find(
      (s) => s.schema === oldSchema && s.name === oldName
    )
    // Таблицю без первинного ключа виявлення переходу вже відхилило
    // (`plan.promotion-unsupported`): хеш без ключа не доводить, що значення
    // лишились у своїх рядках
    if (source?.primaryKey === undefined)
      throw new Error(
        `promotion table ${oldSchema}.${oldName} has no primary key in the source state`
      )

    const columns = record.columns.filter(
      (c) => c.schema === t.schema && c.table === t.to
    )
    const newName = (old: string): string =>
      columns.find((c) => c.from === old)?.to ?? old
    const newType = (column: string): string | undefined =>
      record.typeChanges.find(
        (c) => c.schema === t.schema && c.table === t.to && c.column === column
      )?.to
    // «До» колонка зі зміною типу читається через те саме приведення, що й
    // крок двигуна: інакше текст значення різнився б лише через тип
    // (`1.50` проти `1.5000`), а не через втрату даних
    const beforeExpr = (old: string): string => {
      const type = newType(newName(old))
      return type === undefined
        ? quoteIdent(old)
        : `(${quoteIdent(old)}::${type})`
    }

    // Ключ «після» — ті самі колонки в нових іменах. Колонка ключа без мапи
    // (вилучена) лишила б вираз зі старим іменем, і замір «після» впав би
    // сирим збоєм: це розбіжність конвеєра плану, а не даних
    const keyColumns = source.primaryKey.columns
    for (const old of keyColumns)
      if (!columns.some((c) => c.from === old))
        throw new Error(
          `primary key column ${oldSchema}.${oldName}.${old} has no mapping`
        )
    const key = (expr: (name: string) => string): string =>
      keyColumns.length === 1
        ? expr(keyColumns[0]!)
        : `ROW(${keyColumns.map(expr).join(", ")})::text`

    return {
      before: { schema: oldSchema, table: oldName },
      after: { schema: t.schema, table: t.to },
      key: {
        before: key(beforeExpr),
        after: key((old) => quoteIdent(newName(old))),
      },
      columns: columns.map((c) => {
        const typeChanged = newType(c.to) !== undefined
        const step = typeChangeSteps.get(JSON.stringify([t.schema, t.to, c.to]))
        // Зміна типу без кроку двигуна — розбіжність конвеєра плану, а не
        // даних: без id кроку невдале приведення не було б кому приписати
        if (typeChanged && step === undefined)
          throw new Error(
            `type change of ${t.schema}.${t.to}.${c.to} has no step in the plan`
          )
        return {
          before: beforeExpr(c.from),
          after: quoteIdent(c.to),
          ...(step === undefined ? {} : { typeChangeStep: step }),
        }
      }),
    }
  })
}

/**
 * Один прохід по таблиці: `count(*)` і для кожної колонки сума хешів
 * «ключ:значення». `NULL` кодується окремою ознакою `n`, значення — `v` і
 * текстом: інакше `NULL` і рядок, що виглядає як маркер, дали б той самий
 * хеш. Без `ONLY`, як і сторож: рядки партицій і нащадків теж рахуються.
 * Сума — `numeric`, тож переповнення немає, а пам'ять стала.
 */
export function preservationQuery(
  t: PreservedTable,
  side: "before" | "after"
): string {
  const key = t.key[side]
  const sums = t.columns.map((c, i) => {
    const expr = c[side]
    return `sum(hashtextextended(${key}::text || ':' || CASE WHEN (${expr}) IS NULL THEN 'n' ELSE 'v' || (${expr})::text END, 0)::numeric) AS c${i}`
  })
  return `${["SELECT count(*) AS rows", ...sums].join(", ")} FROM ${qualified(t[side])}`
}

/**
 * Проба одного приведення «до», коли замір таблиці впав на приведенні: лише
 * вираз колонки, без ключа. Ключ зі зміною типу — теж змаплена колонка зі
 * своєю пробою; з ключем у кожній пробі його збій приписався б першій колонці.
 */
export function castProbeQuery(
  t: PreservedTable,
  column: PreservedTable["columns"][number]
): string {
  return `SELECT count(${column.before}) AS probe FROM ${qualified(t.before)}`
}

const qualified = ({ schema, table }: PreservedTable["before"]): string =>
  `${quoteIdent(schema)}.${quoteIdent(table)}`

/**
 * Ім'я колонки з виразу «після» для діагностики: секція несе лише SQL-вирази,
 * тож ім'я читаємо розбором, як сторож читає свою ціль, а не зняттям лапок.
 */
export function preservedColumnName(expr: string, parse: SqlParser): string {
  const result = parse(`SELECT ${expr}`)
  const stmt = result.ok ? result.statements[0]?.stmt : undefined
  const target =
    stmt !== undefined && "SelectStmt" in stmt
      ? stmt.SelectStmt.targetList?.[0]
      : undefined
  const value =
    target !== undefined && "ResTarget" in target
      ? target.ResTarget.val
      : undefined
  if (value === undefined || !("ColumnRef" in value)) return expr
  return stringsOf(value.ColumnRef.fields).join(".")
}
