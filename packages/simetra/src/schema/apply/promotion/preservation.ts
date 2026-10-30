import type { PromotionRecord, SqlParser } from "simetra/compiler"
import { quoteIdent, type PhysicalSnapshot } from "simetra/model"
import type { PreservedTable } from "../artifact"
import { tableKey } from "../table-key"
import { stringsOf } from "../type-guard"
import type { EngineDiagnostic } from "../../engine"
import { applyDiagnostic } from "../diagnostic"
import { planChange } from "../step-subject"
import type { PlanStep } from "../steps"
import {
  castExpression,
  typeIdentity,
  type DataTable,
  type TypePresence,
} from "./data"
import type { RenameIntent } from "./intent"

/**
 * Що заміри збереження порівнюють (спека промоції §7.2): для кожної
 * таблиці одиниці — ключ рядка й пари змаплених колонок як SQL-вирази в
 * старих і нових іменах. Колонки `retired` сюди не потрапляють: їхні дані
 * свідомо не переносяться.
 *
 * `typeChangeSteps` — `JSON.stringify([схема, нова таблиця, нова колонка])`
 * → id кроку двигуна, що змінює тип колонки: ним невдале приведення в замірі
 * «до» назветься `apply.type-narrowing`.
 *
 * Ціль кроку даних міряється за виразом: «до» —
 * вираз у типі запису (для змапленої цілі зі зміною типу — ще й приведений
 * до нового, як звичайна колонка), «після» — нова колонка; `dataStep` —
 * крок даних. Для змапленої цілі цей запис замінює звичайний, для
 * незмапленої — додається після змаплених.
 */
export function preservationPlan(
  record: PromotionRecord,
  intent: RenameIntent,
  before: Pick<PhysicalSnapshot, "tables">,
  typeChangeSteps: ReadonlyMap<string, string>,
  data: readonly Pick<DataTable, "before" | "columns">[]
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

    const typeChangeStep = (column: string): string | undefined => {
      const step = typeChangeSteps.get(JSON.stringify([t.schema, t.to, column]))
      // Зміна типу без кроку двигуна — розбіжність конвеєра плану, а не
      // даних: без id кроку невдале приведення не було б кому приписати
      if (newType(column) !== undefined && step === undefined)
        throw new Error(
          `type change of ${t.schema}.${t.to}.${column} has no step in the plan`
        )
      return step
    }
    const filled = new Map(
      (
        data.find(
          (d) => d.before.schema === t.schema && d.before.table === t.from
        )?.columns ?? []
      ).map((c) => [c.column, c])
    )
    const measured = (c: DataTable["columns"][number]) => {
      const step = typeChangeStep(c.column)
      return {
        ...dataMeasure(c, newType(c.column)),
        dataStep: c.step,
        ...(step === undefined ? {} : { typeChangeStep: step }),
      }
    }
    const mapped = new Set(columns.map((c) => c.to))

    return {
      before: { schema: oldSchema, table: oldName },
      after: { schema: t.schema, table: t.to },
      key: {
        before: key(beforeExpr),
        after: key((old) => quoteIdent(newName(old))),
      },
      columns: [
        ...columns.map((c) => {
          const fill = filled.get(c.to)
          if (fill !== undefined) return measured(fill)
          const step = typeChangeStep(c.to)
          return {
            before: beforeExpr(c.from),
            after: quoteIdent(c.to),
            ...(step === undefined ? {} : { typeChangeStep: step }),
          }
        }),
        ...[...filled.values()]
          .filter((c) => !mapped.has(c.column))
          .map(measured),
      ],
    }
  })
}

/**
 * Замір цілі кроку даних: «до» — вираз у типі
 * запису, для змапленої цілі зі зміною типу (`newType`) — ще й приведений до
 * нового, як звичайна колонка; «після» — нова колонка. Один рендер для плану
 * й для звірки раннера: помилково зібраний замір доводив би інше значення.
 */
export function dataMeasure(
  c: Pick<DataTable["columns"][number], "expression" | "type" | "column">,
  newType: string | undefined
): { before: string; after: string } {
  const cast = castExpression(c)
  return {
    before: newType === undefined ? cast : `(${cast}::${newType})`,
    after: quoteIdent(c.column),
  }
}

/** Конкатенація з `pg_catalog`, як і решта заміру: від `search_path` не залежить. */
const CONCAT = "OPERATOR(pg_catalog.||)"

/**
 * Один прохід по таблиці: `count(*)` і для кожної колонки сума хешів
 * «ключ:значення». `NULL` кодується окремою ознакою `n`, значення — `v` і
 * текстом: інакше `NULL` і рядок, що виглядає як маркер, дали б той самий
 * хеш. Без `ONLY`, як і сторож: рядки партицій і нащадків теж рахуються.
 * Сума — `numeric`, тож переповнення немає, а пам'ять стала.
 *
 * Вирази рахуються в підзапиті, агрегати — над його колонками
 * (спека промоції §7.2): віконна функція в аргументі агрегату заборонена, а вираз
 * кроку даних може бути віконним; одна форма для всіх колонок не дає двох
 * шляхів. Вираз — між переводами рядка: коментар `--` у ньому інакше
 * закоментував би решту оператора.
 */
export function preservationQuery(
  t: PreservedTable,
  side: "before" | "after"
): string {
  const sums = t.columns.map(
    (_, i) =>
      `pg_catalog.sum(pg_catalog.hashtextextended(k::pg_catalog.text ${CONCAT} ':' ${CONCAT} CASE WHEN x${i} IS NULL THEN 'n' ELSE 'v' ${CONCAT} x${i}::pg_catalog.text END, 0)::pg_catalog.numeric) AS c${i}`
  )
  const values = t.columns.map((c, i) => `${multiline(c[side])} AS x${i}`)
  return `${["SELECT pg_catalog.count(*) AS rows", ...sums].join(", ")} FROM (SELECT ${[`${t.key[side]} AS k`, ...values].join(", ")} FROM ${qualified(t[side])}) AS s`
}

/**
 * Проба одного приведення «до», коли замір таблиці впав на приведенні: лише
 * вираз колонки, без ключа. Ключ зі зміною типу — теж змаплена колонка зі
 * своєю пробою; з ключем у кожній пробі його збій приписався б першій колонці.
 * Підзапит — як у заміру: віконна функція прямо в `count` дала б `42803`, а
 * не клас `22`, і сховала б справжню колонку зі звуженням.
 */
export function castProbeQuery(
  t: PreservedTable,
  column: PreservedTable["columns"][number]
): string {
  return `SELECT pg_catalog.count(x) AS probe FROM (SELECT ${multiline(column.before)} AS x FROM ${qualified(t.before)}) AS s`
}

const multiline = (expr: string): string => `(\n${expr}\n)`

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

const qualifiedColumn = (t: {
  schema: string
  table: string
  column: string
}) => `${quoteIdent(t.schema)}.${quoteIdent(t.table)}.${quoteIdent(t.column)}`

/**
 * Відмови `plan.preservation-type` до копії (спека
 * промоції §4): замір «до» приводить колонку до нового типу до будь-якого
 * кроку, тож тип, якого у вихідному стані цілі немає (`missing`) чи якого не
 * назвати (`unparsed`), дав би сирий `42704` замість доказу. `presence` —
 * `readTypePresence` нових типів `record.typeChanges`.
 */
export function preservationTypeRefusals(
  record: PromotionRecord,
  presence: ReadonlyMap<string, TypePresence>
): EngineDiagnostic[] {
  return record.typeChanges.flatMap((t) => {
    const found = presence.get(t.to) ?? "missing"
    return found === "found"
      ? []
      : [
          applyDiagnostic("plan.preservation-type", "error", {
            column: qualifiedColumn(t),
            type: t.to,
            detail: found,
          }),
        ]
  })
}

/**
 * Відмови `plan.preservation-type` за кроками плану — після `analyseOnClone`:
 * новий тип, який крок створює, змінює чи знищує (`planChange`), замір «до»
 * читав би ще старим. `detail` — `changed` чи `unproven`, `by` — крок.
 */
export function preservationTypeStepRefusals(
  record: PromotionRecord,
  steps: readonly PlanStep[],
  parse: SqlParser
): EngineDiagnostic[] {
  return record.typeChanges.flatMap((t) => {
    const id = typeIdentity(t.to, parse)
    const change =
      id === undefined
        ? undefined
        : planChange(steps, { kind: "type", ...id }, parse)
    return change === undefined
      ? []
      : [
          applyDiagnostic("plan.preservation-type", "error", {
            column: qualifiedColumn(t),
            type: t.to,
            detail: change.verdict,
            by: change.step,
          }),
        ]
  })
}
