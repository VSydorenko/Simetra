import {
  DATA_STEP_KINDS,
  fillCalls,
  modelFunctions,
  NOW_FUNCTIONS,
  recordedFillKind,
  type CompiledModel,
  type DiagnosticParams,
  type PromotionRecord,
  type RuleCode,
  type SqlParser,
} from "simetra/compiler"
import { quoteIdent, type PhysicalSnapshot } from "simetra/model"
import type { EngineDiagnostic } from "../../engine"
import { applyDiagnostic } from "../diagnostic"
import { ApplyDbError, type ApplyTransaction } from "../port"
import { DATA_SETTINGS, withLocalSettings } from "../settings"
import type { PlanStep } from "../steps"
import { planChange } from "../step-subject"
import { tableKey } from "../table-key"
import {
  GUARD_PAIR_SQLSTATES,
  parseType,
  stringsOf,
  typeOf,
} from "../type-guard"

export type DataStepKind = (typeof DATA_STEP_KINDS)[number]

/** Режими тригера користувача, які раннер вимикає на час запису. */
export const DATA_TRIGGER_MODES = ["O", "A"] as const

/**
 * Таблиця кроків даних секції промоції (рішення 2 плану П3-2b-2): одна
 * тимчасова таблиця й один `UPDATE` на таблицю одиниці. Кроки даних — не
 * `PlanStep`: між операторами є умови (звірка тригерів, рівність
 * лічильників), тож SQL рендерять функції нижче з цих полів — одне джерело
 * правди для раннера й виводу `plan`.
 */
export interface DataTable {
  /** `simetra_fill_<n>`: `n` — порядок таблиці серед таблиць із кроками. */
  temp: string
  /** Старі імена: обчислення йде до кроків наміру. */
  before: { schema: string; table: string; key: string }
  /** Нові імена: запис іде після кроків наміру. */
  after: { schema: string; table: string; key: string }
  columns: {
    /** `d<N>` наскрізно в порядку `record.dataSteps`. */
    step: string
    /** Нове ім'я колонки-цілі. */
    column: string
    /** Тип колонки на момент запису, форма `record.typeChanges`. */
    type: string
    /** Вираз у старих іменах. */
    expression: string
    kind: DataStepKind
    /** SQL сторожа приведення до `type` (рішення 12). */
    guard: string
  }[]
  /** Тригери користувача, які запис вимикає, за іменем. */
  triggers: { name: string; enabled: (typeof DATA_TRIGGER_MODES)[number] }[]
}

type DataColumn = DataTable["columns"][number]

/** Таблиця кроків даних до читання тригерів цілі. */
export type PlannedDataTable = Omit<DataTable, "triggers">

/** Запис промоції й файл, які називають відмови. */
export interface DataOrigin {
  objectId: string
  file: string
}

const qualified = (schema: string, name: string): string =>
  `${quoteIdent(schema)}.${quoteIdent(name)}`

const multiline = (expression: string): string => `(\n${expression}\n)`

/** Вираз кроку, приведений до типу запису, — та сама форма в CTAS і замірі. */
export const castExpression = (
  c: Pick<DataColumn, "expression" | "type">
): string => `(${multiline(c.expression)}::${c.type})`

/**
 * Форма сторожа приведення (рішення 12): `compare` — порівняння в типах, які
 * розв'язує Postgres; `text` — текстова, коли такого оператора немає.
 */
export type GuardForm = "compare" | "text"

/**
 * SQL сторожа приведення кроку: скільки ненульових значень виразу
 * приведення до типу запису змінює. Таблиця — у старих іменах, як CTAS.
 * Вираз рахується в підзапиті, як і в замірі (рішення 8): віконна функція в
 * `WHERE` заборонена, а вираз кроку може бути віконним.
 */
export function dataGuardSql(
  before: { schema: string; table: string },
  c: Pick<DataColumn, "expression" | "type">,
  form: GuardForm
): string {
  const changed =
    form === "compare"
      ? `(x::${c.type}) IS DISTINCT FROM x`
      : `(x::${c.type})::pg_catalog.text IS DISTINCT FROM x::pg_catalog.text`
  return `SELECT pg_catalog.count(*) AS lost FROM (SELECT ${multiline(c.expression)} AS x FROM ${qualified(before.schema, before.table)}) AS s WHERE x IS NOT NULL AND ${changed}`
}

/** Перший `d<N>` таблиці: ним називаються її оператори даних. */
export const dataTableStep = (t: Pick<DataTable, "columns">): string =>
  t.columns[0]!.step

/**
 * Обчислення кроків таблиці в старих іменах: ключ і по колонці на крок у
 * тимчасову таблицю транзакції (рішення 1, 7).
 */
export function dataComputeSql(t: PlannedDataTable): string {
  const values = t.columns.map((c, i) => `${castExpression(c)} AS v${i + 1}`)
  return `CREATE TEMP TABLE ${quoteIdent(t.temp)} ON COMMIT DROP AS SELECT ${[`${quoteIdent(t.before.key)} AS k`, ...values].join(", ")} FROM ${qualified(t.before.schema, t.before.table)}`
}

/** Скільки рядків обчислено: запис мусить дати рівно стільки ж. */
export function dataCountSql(t: PlannedDataTable): string {
  return `SELECT pg_catalog.count(*) AS computed FROM pg_temp.${quoteIdent(t.temp)}`
}

/**
 * Запис одним `UPDATE` на таблицю в нових іменах: кожен `UPDATE` пише нову
 * версію рядка, тож по одному на крок дало б N переписувань.
 */
export function dataWriteSql(t: PlannedDataTable): string {
  const sets = t.columns.map((c, i) => `${quoteIdent(c.column)} = d.v${i + 1}`)
  return `WITH u AS (UPDATE ${qualified(t.after.schema, t.after.table)} AS t SET ${sets.join(", ")} FROM pg_temp.${quoteIdent(t.temp)} AS d WHERE t.${quoteIdent(t.after.key)} OPERATOR(pg_catalog.=) d.k RETURNING 1) SELECT pg_catalog.count(*) AS written FROM u`
}

/**
 * Вимкнення (`on = false`) чи повернення тригерів таблиці в нових іменах,
 * поштучно: `ENABLE TRIGGER` дав би завжди ввімкненому тригеру режим `O`.
 */
export function triggerSql(t: DataTable, on: boolean): string[] {
  const table = qualified(t.after.schema, t.after.table)
  return t.triggers.map(
    (g) =>
      `ALTER TABLE ${table} ${
        !on ? "DISABLE" : g.enabled === "A" ? "ENABLE ALWAYS" : "ENABLE"
      } TRIGGER ${quoteIdent(g.name)}`
  )
}

const error = (code: RuleCode, params: DiagnosticParams) =>
  applyDiagnostic(code, "error", params)

const unsupported = (
  origin: DataOrigin,
  reason: string,
  extra: DiagnosticParams
): EngineDiagnostic =>
  error("plan.promotion-unsupported", {
    objectId: origin.objectId,
    file: origin.file,
    reason,
    ...extra,
  })

/**
 * Ідентичність типу структурно, за правилом `typeOf`: голе ім'я — тип
 * `pg_catalog`, бо типи запису й змін типу пише знімок адаптера чи
 * `pgTypeOf` під `search_path = pg_catalog`, і користувацький тип там завжди
 * кваліфікований (рішення В5). Масив — тип елемента. Тип, якого так не
 * назвати, — `undefined`, і план відмовляє.
 */
export function typeIdentity(
  type: string,
  parse: SqlParser
): { schema: string; name: string } | undefined {
  const tree = parseType(type, parse)
  if (tree === undefined) return undefined
  const element = { ...tree, arrayBounds: [] }
  if (typeOf(element) === undefined) return undefined
  const names = stringsOf(tree.names)
  const parts = names.length === 1 ? ["pg_catalog", names[0]!] : names
  return parts.length === 2 ? { schema: parts[0]!, name: parts[1]! } : undefined
}

/** Рядковий тип без межі: запис у нього несе текстову форму значення точно. */
function isUnboundedString(type: string, parse: SqlParser): boolean {
  const tree = parseType(type, parse)
  const t = tree === undefined ? undefined : typeOf(tree)
  return (
    t !== undefined &&
    t.mods.length === 0 &&
    (t.name === "pg_catalog.text" || t.name === "pg_catalog.varchar")
  )
}

/** Таблиця одиниці в бажаному стані — за ідентичністю, як у наміру. */
function desiredTableOf(
  desired: Pick<PhysicalSnapshot, "tables">,
  id: string
): PhysicalSnapshot["tables"][number] | undefined {
  return desired.tables.find(({ origin }) => {
    const { objectId, tabularSectionId, part } = origin
    return part === undefined && (tabularSectionId ?? objectId) === id
  })
}

/**
 * Секція кроків даних із запису (рішення 2, 4 плану П3-2b-2). Запису T2 не
 * вірить на слово: таблиця кроку — з `record.tables`, колонка — є в бажаній
 * таблиці, вид — той, що виводить T1 (`recordedFillKind`). Розбіжність —
 * `plan.promotion-record-mismatch`; межі кроку (ключ, тип запису) —
 * `plan.promotion-unsupported`. `sources` — старе ім'я колонки-джерела
 * змапленої цілі за id кроку: за ним факти цілі шукають вхідні FK.
 */
export function dataPlan(p: {
  record: PromotionRecord
  file: string
  source: Pick<PhysicalSnapshot, "tables">
  desired: Pick<CompiledModel, "physical" | "sqlUnits">
  parse: SqlParser
}):
  | { tables: PlannedDataTable[]; sources: Map<string, string> }
  | { refusal: EngineDiagnostic[] } {
  const { record, source, desired, parse } = p
  const origin = { objectId: record.objectId, file: p.file }
  const steps = record.dataSteps
  if (steps.length === 0) return { tables: [], sources: new Map() }
  const functions = modelFunctions(desired)
  const mismatch = (i: number, detail: string) => ({
    refusal: [
      error("plan.promotion-record-mismatch", {
        objectId: record.objectId,
        file: p.file,
        // `detail` — буквально `dataSteps` (рішення 2): який крок і чому —
        // окремими параметрами
        detail: "dataSteps",
        step: `d${i + 1}`,
        reason: detail,
      }),
    ],
  })

  // Звірка кожного кроку — до будь-якого виводу з нього
  const resolved: {
    id: string
    step: PromotionRecord["dataSteps"][number]
    promoted: PromotionRecord["tables"][number]
    desiredType: string
    old: PhysicalSnapshot["tables"][number]
  }[] = []
  for (const [i, step] of steps.entries()) {
    const promoted = record.tables.find(
      (t) => t.schema === step.schema && t.from === step.table
    )
    if (promoted === undefined)
      return mismatch(
        i,
        `table ${qualified(step.schema, step.table)} is not a table of the promotion`
      )
    const target = desiredTableOf(desired.physical, promoted.id)
    const column = target?.columns.find((c) => c.name === step.column)
    if (target === undefined || column === undefined)
      return mismatch(
        i,
        `column ${quoteIdent(step.column)} is not in the desired table ${qualified(promoted.schema, promoted.to)}`
      )
    const old = source.tables.find(
      (t) => t.schema === promoted.schema && t.name === promoted.from
    )
    // Таблиці запису звірено зі знімком marker ще у виявленні переходу
    if (old === undefined)
      throw new Error(
        `promotion table ${promoted.schema}.${promoted.from} is not in the source state`
      )
    const derived = recordedFillKind(
      step,
      record,
      { columns: old.columns.map((c) => c.name) },
      functions,
      parse
    )
    if ("reason" in derived)
      return mismatch(
        i,
        `the expression is not a data step (${derived.reason}), recorded ${step.kind}`
      )
    if (derived.kind !== step.kind)
      return mismatch(i, `derived ${derived.kind}, recorded ${step.kind}`)
    resolved.push({
      id: `d${i + 1}`,
      step,
      promoted,
      desiredType: column.type,
      old,
    })
  }

  const refusals: EngineDiagnostic[] = []
  const sources = new Map<string, string>()
  const columns = new Map<string, DataColumn[]>()
  const keys = new Map<string, { before: string; after: string }>()
  for (const { id, step, promoted, desiredType, old } of resolved) {
    const at = qualified(promoted.schema, promoted.from)
    const mappedTo = (from: string) =>
      record.columns.find(
        (c) =>
          c.schema === promoted.schema &&
          c.table === promoted.to &&
          c.from === from
      )?.to
    const typeChange = (column: string) =>
      record.typeChanges.find(
        (t) =>
          t.schema === promoted.schema &&
          t.table === promoted.to &&
          t.column === column
      )

    // Ключ — одноколонковий первинний ключ вихідного стану, що доживає до
    // запису тим самим: інакше `UPDATE … WHERE t.<ключ> = d.k` адресував би
    // не ті рядки
    const primary = old.primaryKey?.columns ?? []
    const keyAfter = mappedTo(step.key)
    const keyProblem =
      primary.length !== 1 || primary[0] !== step.key
        ? "notPrimaryKey"
        : keyAfter === undefined
          ? "retired"
          : steps.some(
                (s) =>
                  s.schema === step.schema &&
                  s.table === step.table &&
                  s.column === keyAfter
              )
            ? "fillTarget"
            : typeChange(keyAfter) !== undefined
              ? "typeChange"
              : undefined
    if (keyProblem !== undefined) {
      refusals.push(
        unsupported(origin, "dataStepKey", {
          step: id,
          table: at,
          key: quoteIdent(step.key),
          detail: keyProblem,
        })
      )
      continue
    }

    // Тип запису: змаплена ціль зі зміною типу пишеться в старий тип, бо
    // зміна — крок двигуна після запису, і звуження ловить його сторож
    const source = record.columns.find(
      (c) =>
        c.schema === promoted.schema &&
        c.table === promoted.to &&
        c.to === step.column
    )
    const change = source === undefined ? undefined : typeChange(step.column)
    if (change !== undefined && !isUnboundedString(change.from, parse)) {
      refusals.push(
        unsupported(origin, "dataStepType", {
          step: id,
          table: at,
          column: quoteIdent(step.column),
          type: change.from,
          detail: "oldType",
        })
      )
      continue
    }
    if (source !== undefined) sources.set(id, source.from)
    const type = change?.from ?? desiredType
    const before = { schema: promoted.schema, table: promoted.from }
    const list = columns.get(promoted.id) ?? []
    list.push({
      step: id,
      column: step.column,
      type,
      expression: step.expression,
      kind: step.kind,
      guard: dataGuardSql(
        before,
        { expression: step.expression, type },
        "compare"
      ),
    })
    columns.set(promoted.id, list)
    keys.set(promoted.id, { before: step.key, after: keyAfter! })
  }
  if (refusals.length > 0) return { refusal: refusals }

  // Таблиці — у порядку `record.tables`, тимчасові імена — від 1 серед тих,
  // що мають кроки: детерміновані, під `planHash`
  const tables: PlannedDataTable[] = []
  for (const t of record.tables) {
    const list = columns.get(t.id)
    const key = keys.get(t.id)
    if (list === undefined || key === undefined) continue
    tables.push({
      temp: `simetra_fill_${tables.length + 1}`,
      before: { schema: t.schema, table: t.from, key: key.before },
      after: { schema: t.schema, table: t.to, key: key.after },
      columns: list,
    })
  }
  return { tables, sources }
}

/**
 * Факти цілі для кроків даних (рішення 4–6, 13), прочитані в `READ ONLY` до
 * копії. Ключі мап — `tableKey` старого імені; `types` — тип запису (текст
 * секції) → наявність у вихідному стані; `cascading` — id кроків, на колонку-ціль
 * яких посилається вхідний FK з `ON UPDATE CASCADE | SET NULL | SET DEFAULT`.
 */
export interface DataFacts {
  triggers: Map<string, DataTable["triggers"]>
  inherited: string[]
  tempPrivilege: boolean
  replicationRole: string
  types: Map<string, TypePresence>
  functions: {
    step: string
    schema?: string
    name: string
    immutable: boolean
    exists: boolean
  }[]
  cascading: string[]
}

const byCodeUnit = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0

const TRIGGERS_SQL = `
select t.tgname::text as name, t.tgenabled::text as enabled
from pg_catalog.pg_trigger t
join pg_catalog.pg_class c on c.oid = t.tgrelid
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where n.nspname = $1 and c.relname = $2
  and not t.tgisinternal and t.tgenabled in ('O', 'A')
`

/**
 * Тригери користувача таблиці, які запис вимикає: не внутрішні (FK
 * працюють) і ввімкнені (`O`) чи завжди ввімкнені (`A`); за іменем у
 * порядку кодових одиниць. Той самий запит раннер звіряє перед вимкненням.
 */
export async function readUserTriggers(
  tx: ApplyTransaction,
  table: { schema: string; table: string }
): Promise<DataTable["triggers"]> {
  const rows = await tx.query<{ name: string; enabled: "O" | "A" }>(
    TRIGGERS_SQL,
    [table.schema, table.table]
  )
  return rows
    .map((r) => ({ name: r.name, enabled: r.enabled }))
    .sort((a, b) => byCodeUnit(a.name, b.name))
}

const INHERITED_SQL = `
select x.schema, x.name
from pg_catalog.json_to_recordset($1::pg_catalog.json) as x(schema text, name text)
join pg_catalog.pg_namespace n on n.nspname = x.schema
join pg_catalog.pg_class c on c.relnamespace = n.oid and c.relname = x.name
where c.relkind = 'p'
   or exists (select 1 from pg_catalog.pg_inherits h where h.inhparent = c.oid)
`

const TYPES_SQL = `
select x.i, exists (
  select 1 from pg_catalog.pg_type t
  join pg_catalog.pg_namespace n on n.oid = t.typnamespace
  where n.nspname = x.schema and t.typname = x.name
) as found
from pg_catalog.json_to_recordset($1::pg_catalog.json) as x(i int, schema text, name text)
`

const FUNCTIONS_SQL = `
select x.i, pg_catalog.count(p.oid)::int as overloads,
  coalesce(pg_catalog.bool_and(p.provolatile = 'i' and not p.proretset), false) as immutable
from pg_catalog.json_to_recordset($1::pg_catalog.json) as x(i int, schema text, name text)
left join pg_catalog.pg_namespace n on n.nspname = x.schema
left join pg_catalog.pg_proc p on p.pronamespace = n.oid and p.proname = x.name
group by x.i
`

const CASCADING_SQL = `
select distinct x.step
from pg_catalog.json_to_recordset($1::pg_catalog.json)
  as x(step text, schema text, "table" text, "column" text)
join pg_catalog.pg_namespace n on n.nspname = x.schema
join pg_catalog.pg_class c on c.relnamespace = n.oid and c.relname = x."table"
join pg_catalog.pg_attribute a
  on a.attrelid = c.oid and a.attname = x."column" and not a.attisdropped
join pg_catalog.pg_constraint k
  on k.contype = 'f' and k.confrelid = c.oid and a.attnum = any (k.confkey)
 and k.confupdtype in ('c', 'n', 'd')
`

const SESSION_SQL = `
select pg_catalog.has_database_privilege(pg_catalog.current_database(), 'TEMP') as temp,
  pg_catalog.current_setting('session_replication_role') as role
`

/**
 * Наявність типу у вихідному стані цілі: `unparsed` — тип, якого не назвати
 * за правилом `typeIdentity` (його не питають і не вгадують).
 */
export type TypePresence = "found" | "missing" | "unparsed"

/**
 * Наявність типів за текстом (рішення В5): ідентичність — `typeIdentity`,
 * пошук — структурно в `pg_type` за схемою й ім'ям. Викликач відкриває
 * транзакцію `READ ONLY` на цілі. Спільне для типів запису кроків даних і
 * нових типів замірів збереження.
 */
export async function readTypePresence(
  tx: ApplyTransaction,
  types: readonly string[],
  parse: SqlParser
): Promise<Map<string, TypePresence>> {
  const texts = [...new Set(types)]
  const identities = texts.map((type) => typeIdentity(type, parse))
  const asked = identities.flatMap((id, i) =>
    id === undefined ? [] : [{ i, ...id }]
  )
  const found = new Set(
    asked.length === 0
      ? []
      : (
          await tx.query<{ i: number; found: boolean }>(TYPES_SQL, [
            JSON.stringify(asked),
          ])
        )
          .filter((r) => r.found)
          .map((r) => r.i)
  )
  return new Map(
    texts.map((type, i): [string, TypePresence] => [
      type,
      identities[i] === undefined
        ? "unparsed"
        : found.has(i)
          ? "found"
          : "missing",
    ])
  )
}

/** Функція виразу питається як функція каталогу: голе ім'я чи `pg_catalog`. */
const isCatalog = (schema: string | undefined): boolean =>
  schema === undefined || schema === "pg_catalog"

/**
 * Факти цілі для кроків даних; викликач відкриває транзакцію `READ ONLY` на
 * цілі. Таблиці — у старих іменах. Функції — прямі виклики виразу
 * (`fillCalls`), крім функцій часу транзакції (`NOW_FUNCTIONS`): вони
 * `STABLE`, і T1 уже допустив їх лише поза ремонтом. `sources` — старе ім'я
 * колонки-джерела змапленої цілі за id кроку (`dataPlan`).
 */
export async function readDataFacts(
  tx: ApplyTransaction,
  tables: readonly PlannedDataTable[],
  parse: SqlParser,
  sources: ReadonlyMap<string, string> = new Map()
): Promise<DataFacts> {
  const triggers = new Map<string, DataTable["triggers"]>()
  for (const t of tables)
    triggers.set(
      tableKey(t.before.schema, t.before.table),
      await readUserTriggers(tx, t.before)
    )

  const inherited = (
    await tx.query<{ schema: string; name: string }>(INHERITED_SQL, [
      JSON.stringify(
        tables.map((t) => ({ schema: t.before.schema, name: t.before.table }))
      ),
    ])
  )
    .map((r) => tableKey(r.schema, r.name))
    .sort(byCodeUnit)

  const types = await readTypePresence(
    tx,
    tables.flatMap((t) => t.columns.map((c) => c.type)),
    parse
  )

  const calls = tables.flatMap((t) =>
    t.columns.flatMap((c) =>
      fillCalls(c.expression, parse)
        .filter((f) => !(isCatalog(f.schema) && NOW_FUNCTIONS.has(f.name)))
        .map((f) => ({ step: c.step, ...f }))
    )
  )
  const overloads = new Map(
    calls.length === 0
      ? []
      : (
          await tx.query<{ i: number; overloads: number; immutable: boolean }>(
            FUNCTIONS_SQL,
            [
              JSON.stringify(
                calls.map((f, i) => ({
                  i,
                  schema: f.schema ?? "pg_catalog",
                  name: f.name,
                }))
              ),
            ]
          )
        ).map((r) => [r.i, r])
  )
  const functions = calls.map((f, i) => {
    const row = overloads.get(i)
    return {
      ...f,
      immutable: row?.immutable === true,
      exists: (row?.overloads ?? 0) > 0,
    }
  })

  const targets = tables.flatMap((t) =>
    t.columns.flatMap((c) => {
      const column = sources.get(c.step)
      return column === undefined
        ? []
        : [
            {
              step: c.step,
              schema: t.before.schema,
              table: t.before.table,
              column,
            },
          ]
    })
  )
  const cascading =
    targets.length === 0
      ? []
      : (
          await tx.query<{ step: string }>(CASCADING_SQL, [
            JSON.stringify(targets),
          ])
        )
          .map((r) => r.step)
          .sort(byCodeUnit)

  const [session] = await tx.query<{ temp: boolean; role: string }>(SESSION_SQL)
  if (session === undefined)
    throw new Error("the session facts returned no row")
  return {
    triggers,
    inherited,
    tempPrivilege: session.temp,
    replicationRole: session.role,
    types,
    functions,
    cascading,
  }
}

const functionName = (f: { schema?: string; name: string }): string =>
  f.schema === undefined ? quoteIdent(f.name) : qualified(f.schema, f.name)

/**
 * Відмови з фактів цілі — до копії (рішення 4–6, 13): таблиця з нащадками
 * чи партиціонована, тип запису, якого немає у вихідному стані, вхідний FK
 * з каскадом оновлення, право `TEMP`, `session_replication_role` і
 * детермінованість викликів на цілі. `models` — кваліфіковані імена
 * функцій моделі бажаного стану (`modelFunctions`): функція моделі, якої на
 * цілі немає, — `plan.data-step-function-changed` (її створює сам план), а
 * будь-яка інша відсутня функція — `plan.data-step-volatile`: її
 * детермінованість на цілі не доведено.
 */
export function dataFactRefusals(
  tables: readonly PlannedDataTable[],
  facts: DataFacts,
  role: string,
  origin: DataOrigin,
  models: ReadonlySet<string>
): EngineDiagnostic[] {
  if (tables.length === 0) return []
  const out: EngineDiagnostic[] = []
  const inherited = new Set(facts.inherited)
  const cascading = new Set(facts.cascading)
  for (const t of tables) {
    const table = qualified(t.before.schema, t.before.table)
    if (inherited.has(tableKey(t.before.schema, t.before.table))) {
      out.push(
        unsupported(origin, "dataStepTable", {
          step: dataTableStep(t),
          table,
        })
      )
      continue
    }
    for (const c of t.columns) {
      const presence = facts.types.get(c.type) ?? "missing"
      if (presence !== "found")
        out.push(
          unsupported(origin, "dataStepType", {
            step: c.step,
            table,
            column: quoteIdent(c.column),
            type: c.type,
            detail: presence,
          })
        )
      if (cascading.has(c.step))
        out.push(
          unsupported(origin, "dataStepReferenced", {
            step: c.step,
            table,
            column: quoteIdent(c.column),
          })
        )
    }
  }
  if (!facts.tempPrivilege)
    out.push(error("plan.temp-privilege", { role: quoteIdent(role) }))
  if (facts.replicationRole !== "origin")
    out.push(error("plan.replication-role", { value: facts.replicationRole }))
  for (const f of facts.functions) {
    const params = { step: f.step, function: functionName(f) }
    const model = f.schema !== undefined && models.has(`${f.schema}.${f.name}`)
    if (model && !f.exists)
      out.push(error("plan.data-step-function-changed", params))
    else if (!f.exists || !f.immutable)
      out.push(error("plan.data-step-volatile", params))
  }
  return out
}

/**
 * Відмови за кроками плану — після `analyseOnClone` (рішення 4, 5, вердикт
 * В7): обчислення й `ADD COLUMN` наміру йдуть до кроків двигуна, тож тип
 * запису, який крок створює, змінює чи знищує, — `dataStepType`, а функція
 * моделі виразу — `plan.data-step-function-changed`: значення порахувало б
 * старе тіло. Чи змінює крок об'єкт — `planChange`; `detail` — `changed`
 * чи `unproven` (крок вживає об'єкт, а предмета його оператора не визначити),
 * `by` — id кроку.
 */
export function dataStepRefusals(
  tables: readonly PlannedDataTable[],
  steps: readonly PlanStep[],
  parse: SqlParser,
  origin: DataOrigin
): EngineDiagnostic[] {
  if (tables.length === 0) return []
  const out: EngineDiagnostic[] = []
  for (const t of tables) {
    const table = qualified(t.before.schema, t.before.table)
    for (const c of t.columns) {
      const id = typeIdentity(c.type, parse)
      const type =
        id === undefined
          ? undefined
          : planChange(steps, { kind: "type", ...id }, parse)
      if (type !== undefined)
        out.push(
          unsupported(origin, "dataStepType", {
            step: c.step,
            table,
            column: quoteIdent(c.column),
            type: c.type,
            detail: type.verdict,
            by: type.step,
          })
        )
      for (const f of fillCalls(c.expression, parse)) {
        if (f.schema === undefined || isCatalog(f.schema)) continue
        const change = planChange(
          steps,
          { kind: "routine", schema: f.schema, name: f.name },
          parse
        )
        if (change !== undefined)
          out.push(
            error("plan.data-step-function-changed", {
              step: c.step,
              function: functionName(f),
              detail: change.verdict,
              by: change.step,
            })
          )
      }
    }
  }
  return out
}

/** Ім'я підготовленого оператора проби форми; префікс платформи. */
const probeName = (index: number): string => `simetra_fill_probe_${index}`

/**
 * Форма сторожа приведення кожної колонки (рішення 12): `PREPARE` на першій
 * копії до кроків наміру — вираз у старих іменах — лише розбирає й аналізує
 * запит, нічого не обчислюючи. Порівняння в типах, коли є оператор, інакше
 * (`GUARD_PAIR_SQLSTATES`) текстова форма; жодна не готується —
 * `dataStepType`. Інший збій проби летить як є. Під `DATA_SETTINGS`,
 * як і раннер: від `search_path` залежить, які імена розв'язуються. Точка
 * збереження — щоб одна невдала проба не обірвала решту; `DEALLOCATE`
 * обов'язковий, бо підготовлений оператор живе поза транзакцією.
 */
export async function castGuardForms(
  tx: ApplyTransaction,
  tables: readonly PlannedDataTable[],
  origin: DataOrigin
): Promise<{ tables: PlannedDataTable[] } | { refusal: EngineDiagnostic[] }> {
  let index = 0
  const prepared = async (sql: string): Promise<boolean> => {
    const name = probeName(index++)
    await tx.query("SAVEPOINT simetra_fill_probe")
    try {
      await tx.query(`PREPARE ${name} AS ${sql}`)
    } catch (error) {
      // Лише «для цієї пари типів немає оператора чи приведення» міняє
      // форму; решта (права, повторювані збої) летить як є, а не стає
      // відмовою плану
      if (
        !(error instanceof ApplyDbError) ||
        !GUARD_PAIR_SQLSTATES.has(error.sqlstate ?? "")
      )
        throw error
      await tx.query("ROLLBACK TO SAVEPOINT simetra_fill_probe")
      return false
    }
    await tx.query(`DEALLOCATE ${name}`)
    await tx.query("RELEASE SAVEPOINT simetra_fill_probe")
    return true
  }
  const refusals: EngineDiagnostic[] = []
  const out = await withLocalSettings(tx, DATA_SETTINGS, async () => {
    const result: PlannedDataTable[] = []
    for (const t of tables) {
      const columns: DataColumn[] = []
      for (const c of t.columns) {
        const form = (await prepared(dataGuardSql(t.before, c, "compare")))
          ? "compare"
          : (await prepared(dataGuardSql(t.before, c, "text")))
            ? "text"
            : undefined
        if (form === undefined) {
          refusals.push(
            unsupported(origin, "dataStepType", {
              step: c.step,
              table: qualified(t.before.schema, t.before.table),
              column: quoteIdent(c.column),
              type: c.type,
              detail: "cast",
            })
          )
          columns.push(c)
          continue
        }
        columns.push({ ...c, guard: dataGuardSql(t.before, c, form) })
      }
      result.push({ ...t, columns })
    }
    return result
  })
  return refusals.length > 0 ? { refusal: refusals } : { tables: out }
}

/** Секція з тригерами з фактів цілі. */
export function withTriggers(
  tables: readonly PlannedDataTable[],
  facts: Pick<DataFacts, "triggers">
): DataTable[] {
  return tables.map((t) => ({
    ...t,
    triggers:
      facts.triggers.get(tableKey(t.before.schema, t.before.table)) ?? [],
  }))
}
