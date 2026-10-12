import type { Node } from "libpg-query"
import { relationNameText, type SqlParser } from "simetra/compiler"
import type { CatalogModel, CatalogTable } from "simetra/model"
import type {
  EngineObjectRef,
  ProviderLocks,
  ProviderLockStatement,
} from "../engine"
import type { ApplyTransaction } from "./port"
import type { PlanStep } from "./steps"
import { tableKey } from "./table-key"
import type { TypeChange } from "./type-guard"

/**
 * Режими блокування таблиці сильніші за `ROW EXCLUSIVE`, від слабшого до
 * сильнішого в порядку Postgres. Слабші режими блокування наперед не
 * потребують: їх бере будь-яке читання чи запис, і з DDL вони не
 * конфліктують так, щоб замок посеред транзакції чекав.
 */
export const TABLE_LOCK_MODES = [
  "shareUpdateExclusive",
  "share",
  "shareRowExclusive",
  "exclusive",
  "accessExclusive",
] as const

export type TableLockMode = (typeof TABLE_LOCK_MODES)[number]

/** Режим у тексті `LOCK TABLE … IN <режим> MODE`. */
export const LOCK_MODE_SQL: Readonly<Record<TableLockMode, string>> = {
  shareUpdateExclusive: "SHARE UPDATE EXCLUSIVE",
  share: "SHARE",
  shareRowExclusive: "SHARE ROW EXCLUSIVE",
  exclusive: "EXCLUSIVE",
  accessExclusive: "ACCESS EXCLUSIVE",
}

/**
 * Таблиця, яку раннер блокує до кроків, з режимом. Окремий тип плану:
 * `LockedTable` кроку режиму не несе, бо режим кроку дає його `lockClass`.
 */
export interface TableLock {
  schema: string
  name: string
  mode: TableLockMode
}

/**
 * Таблиця сліду, яку роль, що застосовує, не може заблокувати явно: замок
 * бере сам крок `step`, і вивід плану це показує.
 */
export interface ImplicitLock extends TableLock {
  step: string
}

/** Слід одного кроку: які наявні таблиці й у якому режимі він займе. */
export interface StepFootprint {
  step: string
  tables: TableLock[]
}

const strength = (mode: TableLockMode): number => TABLE_LOCK_MODES.indexOf(mode)

/**
 * Найслабший режим, що покриває обидва. Порядок лінійний, крім пари `SHARE`
 * і `SHARE UPDATE EXCLUSIVE`: перший не конфліктує сам із собою, другий —
 * конфліктує, тож жоден не покриває іншого, і їх покриває `SHARE ROW
 * EXCLUSIVE`.
 */
export function joinModes(a: TableLockMode, b: TableLockMode): TableLockMode {
  const pair = new Set([a, b])
  if (pair.has("share") && pair.has("shareUpdateExclusive"))
    return "shareRowExclusive"
  return strength(a) >= strength(b) ? a : b
}

/** Чи взятий наперед режим `planned` робить замок `held` неочікуваним. */
export const coversMode = (
  planned: TableLockMode,
  held: TableLockMode
): boolean => joinModes(planned, held) === planned

/**
 * Режим власної таблиці кроку за класом двигуна. `none` — замка немає;
 * невідомий клас — найгірший випадок, а не заспокійливе «нічого».
 */
function lockClassMode(lockClass: string): TableLockMode | undefined {
  if (lockClass === "none") return undefined
  return (TABLE_LOCK_MODES as readonly string[]).includes(lockClass)
    ? (lockClass as TableLockMode)
    : "accessExclusive"
}

/**
 * Моделі, з яких виводиться слід кроків двигуна. Імена — ті, якими кроки
 * двигуна називають таблиці: для плану з промоцією це нові імена копії після
 * наміру. `newToOld` перекладає їх у вихідні: блокування береться до першого
 * кроку, коли нових імен на цілі ще немає.
 */
export interface FootprintModels {
  /** Вихідний стан кроків двигуна: тут шукаються FK, які крок знімає. */
  source: CatalogModel
  /** Бажаний стан: тут шукаються FK, які крок створює. */
  desired: CatalogModel
  /** Зміни типу колонок із кроками, з дерева розбору (`typeGuards`). */
  typeChanges: readonly Pick<
    TypeChange,
    "step" | "schema" | "table" | "column"
  >[]
  /** `tableKey` нового імені → старого; порожня без промоції. */
  newToOld: ReadonlyMap<string, string>
  /**
   * `JSON.stringify([схема, нова таблиця, нова колонка])` → старе ім'я
   * колонки; порожня без промоції.
   */
  columnsNewToOld: ReadonlyMap<string, string>
  /**
   * FK живої цілі (вихідні імена), що торкаються таблиць `footprintSubjects`
   * в обидва боки. Моделі каталогу бачать лише межу двигуна, а таблиця поза
   * нею, що посилається на колонку зі зміною типу, теж займається.
   */
  live: readonly LiveForeignKey[]
  /** Класи провайдерських операторів кожного кроку (`providerStatements`). */
  providerStatements: ReadonlyMap<string, readonly ProviderLockStatement[]>
  /** Перелік таблиць провайдера, прочитаний з цілі (`readProviderLocks`). */
  providerLocks: readonly ProviderLockSet[]
}

/**
 * Джерело провайдерських замків пресету з переліком, прочитаним з цілі для
 * ролі плану: лише наявні таблиці, порядок — схема, потім ім'я. Пишеться в
 * артефакт під `planHash`, бо перелік — властивість цілі, а не коду.
 */
export interface ProviderLockSet {
  setting: string
  statements: ProviderLockStatement[]
  tables: { schema: string; name: string }[]
}

/** FK живої цілі у вихідних іменах. */
export interface LiveForeignKey {
  schema: string
  table: string
  columns: string[]
  references: { schema: string; table: string; columns: string[] }
}

interface Named {
  schema: string
  name: string
}

const findTable = (
  model: CatalogModel,
  schema: string,
  name: string
): CatalogTable | undefined =>
  model.tables.find((t) => t.schema === schema && t.name === name)

type ForeignKey = CatalogTable["foreignKeys"][number]

const target = (fk: ForeignKey): Named => ({
  schema: fk.references.schema,
  name: fk.references.table,
})

/** Чи названо обмеження таблиці в моделі якимось відомим їй видом. */
function knownConstraint(table: CatalogTable | undefined, name: string) {
  if (table === undefined) return false
  return (
    table.primaryKey?.name === name ||
    table.uniques.some((u) => u.name === name) ||
    table.checks.some((c) => c.name === name)
  )
}

/**
 * Таблиці, пов'язані з таблицею FK в обидва боки, в обох моделях. Запасне
 * правило: наслідку кроку для FK модель надійно не визначає, тож замість
 * вгадування — `ACCESS EXCLUSIVE` на всьому, з чим таблиця пов'язана.
 */
function linkedTables(
  m: Pick<FootprintModels, "source" | "desired">,
  own: Named
): Named[] {
  const out: Named[] = []
  for (const model of [m.source, m.desired])
    for (const t of model.tables) {
      if (t.schema === own.schema && t.name === own.name)
        out.push(...t.foreignKeys.map(target))
      if (
        t.foreignKeys.some(
          (fk) =>
            fk.references.schema === own.schema &&
            fk.references.table === own.name
        )
      )
        out.push({ schema: t.schema, name: t.name })
    }
  return out
}

/**
 * Наслідки кроку двигуна для FK за моделями — у тих самих іменах, що й крок.
 * `fallbacks` — власні таблиці кроку, для яких спрацювало запасне правило:
 * їхні зв'язки на живій цілі дає `liveEffects`.
 */
function foreignKeyEffects(
  step: PlanStep,
  m: Pick<FootprintModels, "source" | "desired" | "typeChanges">
): { locks: TableLock[]; fallbacks: Named[] } {
  const out: TableLock[] = []
  const fallbacks: Named[] = []
  const add = (tables: readonly Named[], mode: TableLockMode) => {
    for (const t of tables) out.push({ schema: t.schema, name: t.name, mode })
  }
  const fallback = (ref: { schema: string; table: string }) => {
    const own = { schema: ref.schema, name: ref.table }
    fallbacks.push(own)
    add(linkedTables(m, own), "accessExclusive")
  }
  const tableRef = (r: EngineObjectRef) =>
    r.table === undefined ? undefined : { schema: r.schema, table: r.table }

  // Створення FK: `SHARE ROW EXCLUSIVE` на таблиці, на яку він посилається
  for (const ref of step.produced) {
    const owner = tableRef(ref)
    if (ref.kind !== "constraint" || owner === undefined) continue
    const table = findTable(m.desired, owner.schema, owner.table)
    const fk = table?.foreignKeys.find((f) => f.name === ref.name)
    if (fk !== undefined) add([target(fk)], "shareRowExclusive")
    else if (!knownConstraint(table, ref.name)) fallback(owner)
  }

  // Зняття FK — і разом із колонкою чи таблицею: `ACCESS EXCLUSIVE` на
  // таблиці, на яку він посилався
  for (const ref of step.destroyed) {
    if (ref.kind === "table") {
      const table = findTable(m.source, ref.schema, ref.name)
      add(table?.foreignKeys.map(target) ?? [], "accessExclusive")
      continue
    }
    const owner = tableRef(ref)
    if (owner === undefined) continue
    const table = findTable(m.source, owner.schema, owner.table)
    if (ref.kind === "column")
      add(
        (table?.foreignKeys ?? [])
          .filter((fk) => fk.columns.includes(ref.name))
          .map(target),
        "accessExclusive"
      )
    else if (ref.kind === "constraint") {
      const fk = table?.foreignKeys.find((f) => f.name === ref.name)
      if (fk !== undefined) add([target(fk)], "accessExclusive")
      else if (!knownConstraint(table, ref.name)) fallback(owner)
    }
  }

  // Зміна FK на місці (не зняття й створення) — форма, якої модель не
  // описує: запасне правило
  if (step.verb === "alter")
    for (const ref of step.consumed) {
      const owner = tableRef(ref)
      if (ref.kind !== "constraint" || owner === undefined) continue
      const isForeignKey = [m.source, m.desired].some((model) =>
        findTable(model, owner.schema, owner.table)?.foreignKeys.some(
          (fk) => fk.name === ref.name
        )
      )
      if (isForeignKey) fallback(owner)
    }

  // Зміна типу колонки FK перебудовує FK: `ACCESS EXCLUSIVE` на таблиці, на
  // яку він посилається. Зміна типу колонки, на яку посилаються, перебудовує
  // FK таблиць, що посилаються: `ACCESS EXCLUSIVE` на них
  for (const change of m.typeChanges) {
    if (change.step !== step.id) continue
    const table = findTable(m.source, change.schema, change.table)
    add(
      (table?.foreignKeys ?? [])
        .filter((fk) => fk.columns.includes(change.column))
        .map(target),
      "accessExclusive"
    )
    add(
      m.source.tables.filter((t) =>
        t.foreignKeys.some(
          (fk) =>
            fk.references.schema === change.schema &&
            fk.references.table === change.table &&
            fk.references.columns.includes(change.column)
        )
      ),
      "accessExclusive"
    )
  }
  return { locks: out, fallbacks }
}

/** Вихідне ім'я таблиці, яку крок двигуна називає `schema.name`. */
function oldTable(
  m: Pick<FootprintModels, "newToOld">,
  schema: string,
  name: string
): Named {
  const old = m.newToOld.get(tableKey(schema, name))
  if (old === undefined) return { schema, name }
  const [s, n] = JSON.parse(old) as [string, string]
  return { schema: s, name: n }
}

/**
 * Наслідки кроку двигуна для FK за живою ціллю, уже у вихідних іменах:
 * таблиці, що посилаються на колонку зі зміною типу (зокрема поза межею
 * двигуна), і зв'язки в обидва боки власних таблиць запасного правила.
 */
function liveEffects(
  step: PlanStep,
  m: FootprintModels,
  fallbacks: readonly Named[]
): TableLock[] {
  const out: TableLock[] = []
  const exclusive = (schema: string, name: string) =>
    out.push({ schema, name, mode: "accessExclusive" })
  for (const change of m.typeChanges) {
    if (change.step !== step.id) continue
    const table = oldTable(m, change.schema, change.table)
    const column =
      m.columnsNewToOld.get(
        JSON.stringify([change.schema, change.table, change.column])
      ) ?? change.column
    for (const fk of m.live)
      if (
        fk.references.schema === table.schema &&
        fk.references.table === table.name &&
        fk.references.columns.includes(column)
      )
        exclusive(fk.schema, fk.table)
  }
  for (const own of fallbacks) {
    const table = oldTable(m, own.schema, own.name)
    for (const fk of m.live) {
      if (fk.schema === table.schema && fk.table === table.name)
        exclusive(fk.references.schema, fk.references.table)
      if (
        fk.references.schema === table.schema &&
        fk.references.table === table.name
      )
        exclusive(fk.schema, fk.table)
    }
  }
  return out
}

/**
 * Таблиці (вихідні імена), чиї FK на живій цілі потрібні сліду: таблиці
 * змін типу колонок і власні таблиці запасного правила.
 */
export function footprintSubjects(
  steps: readonly PlanStep[],
  m: Pick<
    FootprintModels,
    "source" | "desired" | "typeChanges" | "newToOld" | "columnsNewToOld"
  >
): Named[] {
  const out = new Map<string, Named>()
  const put = (t: Named) => out.set(tableKey(t.schema, t.name), t)
  for (const step of steps) {
    if (step.origin === "intent") continue
    for (const own of foreignKeyEffects(step, m).fallbacks)
      put(oldTable(m, own.schema, own.name))
    for (const change of m.typeChanges)
      if (change.step === step.id) put(oldTable(m, change.schema, change.table))
  }
  return [...out.values()]
}

/**
 * Слід кроку (спека промоції §7.2, «З'єднання й блокування»): які таблиці
 * й у якому режимі крок займе, у вихідних іменах. Власна таблиця — з
 * `lockedTables` і `lockClass`; наслідки для FK — зі структурних
 * `produced`/`destroyed`/`consumed` і моделей (жива — для знятого, бажана —
 * для створеного), без розбору рядкових ідентичностей. Крок наміру —
 * перейменування — займає лише власну таблицю, і його таблиці вже у
 * вихідних іменах: при обміні імен старе ім'я одного — нове ім'я іншого,
 * тож перекладати їх не можна.
 */
export function stepFootprint(step: PlanStep, m: FootprintModels): TableLock[] {
  const own = lockClassMode(step.lockClass)
  const tables: TableLock[] =
    own === undefined ? [] : step.lockedTables.map((t) => ({ ...t, mode: own }))
  const provider = providerEffects(step, m)
  if (step.origin === "intent") return merged([...tables, ...provider])
  const effects = foreignKeyEffects(step, m)
  return merged([
    ...[...tables, ...effects.locks].map((t) => ({
      ...oldTable(m, t.schema, t.name),
      mode: t.mode,
    })),
    ...liveEffects(step, m, effects.fallbacks),
    ...provider,
  ])
}

/**
 * Замки, які додає провайдер (R27): крок класу оператора з джерела пресету
 * займає `ACCESS EXCLUSIVE` на кожній таблиці його переліку. Перелік — з
 * живої цілі, тож імена вже вихідні.
 */
function providerEffects(step: PlanStep, m: FootprintModels): TableLock[] {
  const statements = m.providerStatements.get(step.id) ?? []
  return m.providerLocks
    .filter((set) => set.statements.some((s) => statements.includes(s)))
    .flatMap((set) =>
      set.tables.map((t): TableLock => ({ ...t, mode: "accessExclusive" }))
    )
}

/**
 * Клас провайдерського оператора за вузлом дерева розбору; інші оператори —
 * `undefined`. Перейменування політики (`RenameStmt`) провайдер не займає.
 */
export function providerStatement(
  stmt: Node
): ProviderLockStatement | undefined {
  if ("CreatePolicyStmt" in stmt) return "createPolicy"
  if ("AlterPolicyStmt" in stmt) return "alterPolicy"
  if ("DropStmt" in stmt) {
    const type = stmt.DropStmt.removeType
    if (type === "OBJECT_POLICY") return "dropPolicy"
    if (type === "OBJECT_TRIGGER") return "dropTrigger"
    return undefined
  }
  if ("CommentStmt" in stmt && stmt.CommentStmt.objtype === "OBJECT_POLICY")
    return "commentPolicy"
  return undefined
}

/**
 * Класи провайдерських операторів кожного кроку з дерева розбору його SQL,
 * за id кроку; крок без таких операторів у мапу не входить. SQL кроку, якого
 * парсер не розбирає, — дефект: план таких кроків уже відмовив раніше.
 */
export function providerStatements(
  steps: readonly PlanStep[],
  parse: SqlParser
): Map<string, ProviderLockStatement[]> {
  const out = new Map<string, ProviderLockStatement[]>()
  for (const step of steps) {
    const result = parse(step.sql)
    if (!result.ok)
      throw new Error(`plan step ${step.id} does not parse: ${result.message}`)
    const found = result.statements.flatMap(({ stmt }) => {
      const statement = providerStatement(stmt)
      return statement === undefined ? [] : [statement]
    })
    if (found.length > 0) out.set(step.id, found)
  }
  return out
}

/** Одна таблиця — один запис з об'єднаним режимом, у порядку появи. */
function merged(tables: readonly TableLock[]): TableLock[] {
  const out = new Map<string, TableLock>()
  for (const t of tables) {
    const key = tableKey(t.schema, t.name)
    const seen = out.get(key)
    out.set(key, {
      schema: t.schema,
      name: t.name,
      mode: seen === undefined ? t.mode : joinModes(seen.mode, t.mode),
    })
  }
  return [...out.values()]
}

/** Слід кожного кроку плану. */
export const planFootprint = (
  steps: readonly PlanStep[],
  m: FootprintModels
): StepFootprint[] =>
  steps.map((step) => ({ step: step.id, tables: stepFootprint(step, m) }))

/** Таблиці сліду плану без повторів — вхід читання прав на цілі. */
export function footprintTables(footprint: readonly StepFootprint[]): Named[] {
  const out = new Map<string, Named>()
  for (const { tables } of footprint)
    for (const { schema, name } of tables)
      out.set(tableKey(schema, name), { schema, name })
  return [...out.values()]
}

const byCodeUnit = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0

/**
 * Блокування плану з його сліду. Для кожної таблиці — найсильніший режим
 * серед кроків, тож замок посеред транзакції не підвищується. `rights` —
 * таблиці, що є на цілі, з правом ролі на явний `LOCK`: таблиці, якої немає
 * (її створює сам план), не заблокувати; таблиця без права лишається
 * неявним замком кроку, що бере найсильніший режим (першого такого).
 *
 * Порядок детермінований — режим від сильнішого, потім схема й ім'я за
 * кодовими одиницями, а не порядок плану: два застосування з різними
 * планами блокують спільні таблиці в одному порядку і не чекають одне одного
 * навхрест. Правило однакове для плану з промоцією й без неї.
 */
export function planLocks(p: {
  footprint: readonly StepFootprint[]
  rights: ReadonlyMap<string, boolean>
}): { locks: TableLock[]; implicitLocks: ImplicitLock[] } {
  const strongest = new Map<string, ImplicitLock>()
  for (const { step, tables } of p.footprint)
    for (const t of tables) {
      const key = tableKey(t.schema, t.name)
      if (!p.rights.has(key)) continue
      const seen = strongest.get(key)
      if (seen === undefined) {
        strongest.set(key, { ...t, step })
        continue
      }
      const mode = joinModes(seen.mode, t.mode)
      // Крок неявного замка — той, що першим бере підсумковий режим
      if (mode !== seen.mode)
        strongest.set(key, {
          ...seen,
          mode,
          step: mode === t.mode ? step : seen.step,
        })
    }
  const all = [...strongest.entries()]
  const order = (a: TableLock, b: TableLock): number =>
    strength(b.mode) - strength(a.mode) ||
    byCodeUnit(a.schema, b.schema) ||
    byCodeUnit(a.name, b.name)
  return {
    locks: all
      .filter(([key]) => p.rights.get(key) === true)
      .map(([, { schema, name, mode }]) => ({ schema, name, mode }))
      .sort(order),
    implicitLocks: all
      .filter(([key]) => p.rights.get(key) === false)
      .map(([, l]) => l)
      .sort(
        (a, b) => byCodeUnit(a.schema, b.schema) || byCodeUnit(a.name, b.name)
      ),
  }
}

/**
 * Привілеї, будь-який із яких дає явний `LOCK` сильніше за `ROW EXCLUSIVE`.
 * `MAINTAIN` з'явився в Postgres 17, а 15 і 16 саме слово в переліку
 * `has_table_privilege` відкидають.
 */
export const lockPrivileges = (serverVersionNum: number): string =>
  serverVersionNum >= 170000
    ? "MAINTAIN, UPDATE, DELETE, TRUNCATE"
    : "UPDATE, DELETE, TRUNCATE"

/**
 * Право ролі сесії на явний `LOCK` кожної таблиці сліду, що є на цілі
 * (`relkind` r/p): членство в ролі-власнику (з успадкуванням привілеїв) чи
 * один із `lockPrivileges`. Таблиці, якої на цілі немає, у мапі немає.
 * Ключ — `tableKey`.
 */
export async function readLockRights(
  tx: ApplyTransaction,
  tables: readonly Named[]
): Promise<Map<string, boolean>> {
  if (tables.length === 0) return new Map()
  const [version] = await tx.query<{ version: number }>(
    "SELECT pg_catalog.current_setting('server_version_num')::int AS version"
  )
  if (version === undefined)
    throw new Error("server_version_num returned no row")
  const rows = await tx.query<{
    schema: string
    name: string
    lockable: boolean
  }>(
    `SELECT x.schema, x.name,
       pg_catalog.pg_has_role(c.relowner, 'USAGE')
         OR pg_catalog.has_table_privilege(c.oid, $2) AS lockable
     FROM pg_catalog.json_to_recordset($1::pg_catalog.json) AS x(schema text, name text)
     JOIN pg_catalog.pg_namespace n ON n.nspname = x.schema
     JOIN pg_catalog.pg_class c ON c.relnamespace = n.oid AND c.relname = x.name
       AND c.relkind IN ('r', 'p')`,
    [JSON.stringify(tables), lockPrivileges(version.version)]
  )
  return new Map(rows.map((r) => [tableKey(r.schema, r.name), r.lockable]))
}

/**
 * FK живої цілі, що торкаються `tables` в обидва боки, з колонками в порядку
 * ключа; партиції теж, бо Postgres займає й їх. Читання — у транзакції
 * `READ ONLY` побудови плану.
 */
export async function readLiveForeignKeys(
  tx: ApplyTransaction,
  tables: readonly Named[]
): Promise<LiveForeignKey[]> {
  if (tables.length === 0) return []
  const rows = await tx.query<{
    schema: string
    table: string
    columns: string[]
    ref_schema: string
    ref_table: string
    ref_columns: string[]
  }>(
    `WITH subject AS (
       SELECT c.oid
       FROM pg_catalog.json_to_recordset($1::pg_catalog.json) AS x(schema text, name text)
       JOIN pg_catalog.pg_namespace n ON n.nspname = x.schema
       JOIN pg_catalog.pg_class c ON c.relnamespace = n.oid AND c.relname = x.name
     )
     SELECT n.nspname AS schema, c.relname AS "table",
       ARRAY(SELECT a.attname::text
             FROM pg_catalog.unnest(k.conkey) WITH ORDINALITY AS u(num, ord)
             JOIN pg_catalog.pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.num
             ORDER BY u.ord) AS columns,
       rn.nspname AS ref_schema, rc.relname AS ref_table,
       ARRAY(SELECT a.attname::text
             FROM pg_catalog.unnest(k.confkey) WITH ORDINALITY AS u(num, ord)
             JOIN pg_catalog.pg_attribute a ON a.attrelid = k.confrelid AND a.attnum = u.num
             ORDER BY u.ord) AS ref_columns
     FROM pg_catalog.pg_constraint k
     JOIN pg_catalog.pg_class c ON c.oid = k.conrelid
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     JOIN pg_catalog.pg_class rc ON rc.oid = k.confrelid
     JOIN pg_catalog.pg_namespace rn ON rn.oid = rc.relnamespace
     WHERE k.contype = 'f'
       AND (k.conrelid IN (SELECT oid FROM subject)
         OR k.confrelid IN (SELECT oid FROM subject))
     ORDER BY n.nspname, c.relname, k.conname`,
    [JSON.stringify(tables)]
  )
  return rows.map((r) => ({
    schema: r.schema,
    table: r.table,
    columns: r.columns,
    references: {
      schema: r.ref_schema,
      table: r.ref_table,
      columns: r.ref_columns,
    },
  }))
}

/**
 * Імена таблиць ролі `role` зі значення налаштування провайдера (JSON-об'єкт
 * «роль → імена»). Немає налаштування, немає ключа ролі чи JSON битий —
 * таблиць немає, без відмови: звірка сліду на доказі й репетиції підстрахує.
 * Ім'я, яке `to_regclass` не розбере без помилки (понад дві частини чи
 * нерозбірний текст), відкидається: помилка зірвала б транзакцію плану.
 */
export function providerTableNames(raw: string | null, role: string): string[] {
  if (raw === null) return []
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return []
  }
  if (typeof json !== "object" || json === null || Array.isArray(json))
    return []
  const entry: unknown = Object.hasOwn(json, role)
    ? (json as Record<string, unknown>)[role]
    : undefined
  if (!Array.isArray(entry)) return []
  return entry.filter((name): name is string => {
    if (typeof name !== "string") return false
    const parts = relationNameText(name)
    return parts !== undefined && parts.length <= 2
  })
}

/**
 * Перелік таблиць кожного джерела провайдерських замків для ролі плану
 * (R27): `current_setting(…, true)` дає `NULL` без налаштування, а
 * `to_regclass` лишає лише наявні таблиці (`relkind` r/p) — тим самим
 * правилом розв'язання імені, що й у провайдера. Читання — у транзакції
 * `READ ONLY` побудови плану, разом із правами на `LOCK`.
 */
export async function readProviderLocks(
  tx: ApplyTransaction,
  role: string,
  locks: ProviderLocks
): Promise<ProviderLockSet[]> {
  const out: ProviderLockSet[] = []
  for (const source of locks.sources) {
    const [setting] = await tx.query<{ value: string | null }>(
      "SELECT pg_catalog.current_setting($1, true) AS value",
      [source.setting]
    )
    const names = providerTableNames(setting?.value ?? null, role)
    const rows =
      names.length === 0
        ? []
        : await tx.query<{ schema: string; name: string }>(
            `SELECT DISTINCT n.nspname AS schema, c.relname AS name
             FROM pg_catalog.unnest($1::text[]) AS x(name)
             JOIN pg_catalog.pg_class c ON c.oid = pg_catalog.to_regclass(x.name)
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
             WHERE c.relkind IN ('r', 'p')`,
            [names]
          )
    out.push({
      setting: source.setting,
      statements: [...source.statements],
      tables: rows
        .map((r) => ({ schema: r.schema, name: r.name }))
        .sort(
          (a, b) => byCodeUnit(a.schema, b.schema) || byCodeUnit(a.name, b.name)
        ),
    })
  }
  return out
}
