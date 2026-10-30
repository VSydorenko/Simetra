import {
  AUTHOR_FUNCTION,
  authorTriggerName,
  authorUpdateTriggerName,
  carrierFunctionNames,
  carrierTriggerNames,
  diagnostic,
  effectsFunctionName,
  effectsTriggerNames,
  hierarchyNames,
  rightsGuardNames,
  grantTargetKeys,
  KEY_FUNCTION,
  keyTriggerNames,
  MECHANICS_FUNCTION,
  mechanicsTriggerName,
  mechanicsUpdateTriggerName,
  ownsTarget,
  readSqlUnits,
  unitPlacement,
  unitTarget,
  type Diagnostic,
  type Node,
  type SqlParser,
  withoutLocations,
} from "simetra/compiler"
import type { CatalogUnit, SqlUnitClass } from "simetra/model"
import { terminate } from "../render/desired-state"

export interface UnitsContext {
  parse: SqlParser
  defaultSchema: string
  /** `<Ім'я>.sql` згенерованої таблиці за `schema.name`. */
  sidecars: ReadonlyMap<string, string>
  /**
   * Ідентичності одиниць, які вже описують збережені файли: їх не пишемо, але
   * рахуємо серед викликів тригерних функцій.
   */
  described: ReadonlySet<string>
  /**
   * Обробники збережених підписок (`schema.name`): тригер на них генерує
   * платформа, тож у базі виклику ще може не бути (застосування ще не було),
   * але функцію вже кличе збережений файл.
   */
  handlers: ReadonlySet<string>
  /**
   * Цілі згенерованих грантів збереженої теки (`grantTargetKeys`): дослівний
   * грант на них не пишемо — правами володіє платформа, і в теці він був би
   * помилкою `sql.generated-grant`.
   */
  platformGrants: ReadonlySet<string>
}

export interface UnitFiles {
  files: Map<string, string>
  diagnostics: Diagnostic[]
}

const qualified = (schema: string, name: string) => `${schema}.${name}`

/**
 * Порядок операторів у `<Ім'я>.sql` таблиці — порядок створення (рішення
 * плану 7): функція раніше за тригер, що її викликає, далі решта.
 */
const SIDECAR_ORDER: readonly SqlUnitClass[] = [
  "function",
  "functionSettings",
  "trigger",
  "policy",
  "replicaIdentity",
  "sequenceOwnedBy",
  "grant",
  "comment",
]

/** Цілі, що називають не відношення: їхнє ім'я може збігтися з таблицею. */
const NOT_RELATIONS: ReadonlySet<string | undefined> = new Set([
  "function",
  "schema",
  "publication",
])

/** Функціям — сигнатура в імені файлу, бо перевантаження ділять ім'я. */
const SIGNED: ReadonlySet<SqlUnitClass> = new Set([
  "function",
  "procedure",
  "aggregate",
])

/** Класи з власним іменем у схемі: файл — це ім'я. */
const NAMED: ReadonlySet<SqlUnitClass> = new Set([
  "view",
  "materializedView",
  "sequence",
  "domain",
])

function strings(nodes: readonly Node[] | undefined): string[] {
  return (nodes ?? []).map((n) => ("String" in n ? (n.String.sval ?? "") : ""))
}

function statement(unit: CatalogUnit, parse: SqlParser): Node | undefined {
  const parsed = parse(unit.sql)
  return parsed.ok ? parsed.statements[0]?.stmt : undefined
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

type DefElemNode = Extract<Node, { DefElem: unknown }>

function createFunction(sql: string, parse: SqlParser) {
  const parsed = parse(sql)
  const stmt = parsed.ok ? parsed.statements[0]?.stmt : undefined
  if (stmt === undefined || !("CreateFunctionStmt" in stmt)) return undefined
  const fn = stmt.CreateFunctionStmt
  const options = (fn.options ?? []).filter(
    (o): o is DefElemNode => "DefElem" in o
  )
  return { fn, options: options.map((o) => o.DefElem) }
}

/**
 * Текст функції з волатильністю з факту каталогу (спека П2 §9).
 * `pg_get_functiondef` типової VOLATILE не друкує, а закрита оболонка вимагає
 * волатильність явно: без неї обробник підписки після повторного introspect
 * став би боргом. Слово стає перед першою опцією списку `options` розбору;
 * решта тексту не змінюється. Позиції розбору — у байтах UTF-8.
 */
function explicitVolatility(unit: CatalogUnit, parse: SqlParser): string {
  if (unit.class !== "function" || unit.volatility === undefined)
    return unit.sql
  const before = createFunction(unit.sql, parse)
  if (before === undefined) return unit.sql
  if (before.options.some((o) => o.defname === "volatility")) return unit.sql
  const at = Math.min(
    ...before.options.flatMap((o) =>
      o.location === undefined ? [] : [o.location]
    )
  )
  if (!Number.isFinite(at)) return unit.sql
  const bytes = encoder.encode(unit.sql)
  const sql = `${decoder.decode(bytes.subarray(0, at))}${unit.volatility.toUpperCase()} ${decoder.decode(bytes.subarray(at))}`
  // Вставка змінює лише волатильність: тіло й ідентичність — ті самі.
  // Тіло SQL-стандарту стоїть після опцій, тож його позиції зсуваються —
  // порівнюємо зміст без них.
  const after = createFunction(sql, parse)
  const body = (f: NonNullable<typeof before>) =>
    JSON.stringify(
      withoutLocations([
        f.options.find((o) => o.defname === "as")?.arg,
        f.fn.sql_body,
      ])
    )
  const [identity] = readSqlUnits(
    [{ file: unit.identity, text: sql, schema: "" }],
    parse,
    []
  ).units
  const arg = after?.options.find((o) => o.defname === "volatility")?.arg
  const volatility = arg !== undefined && "String" in arg ? arg.String.sval : ""
  if (
    after === undefined ||
    body(after) !== body(before) ||
    identity?.identity !== unit.identity ||
    volatility !== unit.volatility
  )
    throw new Error(`volatility insertion changed ${unit.identity}`)
  return sql
}

/** Функція, яку викликає тригер; некваліфіковане ім'я — схема проєкту (R3). */
function triggerFunction(
  unit: CatalogUnit,
  ctx: UnitsContext
): string | undefined {
  const stmt = statement(unit, ctx.parse)
  if (stmt === undefined || !("CreateTrigStmt" in stmt)) return undefined
  const names = strings(stmt.CreateTrigStmt.funcname)
  const name = names.at(-1) ?? ""
  return qualified(names.length > 1 ? names.at(-2)! : ctx.defaultSchema, name)
}

/**
 * Грант чи коментар на функцію без аргументів: лише він належить тригерній
 * функції таблиці, а не її перевантаженню з тим самим ім'ям.
 */
function withoutArguments(unit: CatalogUnit, ctx: UnitsContext): boolean {
  const stmt = statement(unit, ctx.parse)
  const target =
    stmt === undefined
      ? undefined
      : "GrantStmt" in stmt
        ? stmt.GrantStmt.objects?.[0]
        : "CommentStmt" in stmt
          ? stmt.CommentStmt.object
          : undefined
  if (target === undefined || !("ObjectWithArgs" in target)) return false
  const fn = target.ObjectWithArgs
  return fn.args_unspecified !== true && (fn.objargs ?? []).length === 0
}

/** Таблиця `OWNED BY` послідовності; `NONE` власника не має. */
function sequenceOwner(
  unit: CatalogUnit,
  ctx: UnitsContext
): string | undefined {
  const stmt = statement(unit, ctx.parse)
  if (stmt === undefined || !("AlterSeqStmt" in stmt)) return undefined
  for (const option of stmt.AlterSeqStmt.options ?? []) {
    if (!("DefElem" in option) || option.DefElem.defname !== "owned_by")
      continue
    const arg = option.DefElem.arg
    const names =
      arg !== undefined && "List" in arg ? strings(arg.List.items) : []
    if (names.length < 2) return undefined
    const table = names.at(-2)!
    return qualified(
      names.length > 2 ? names.at(-3)! : ctx.defaultSchema,
      table
    )
  }
  return undefined
}

/** Таблиця, до якої належить одиниця, — ключ `schema.name`. */
function ownerTable(unit: CatalogUnit, ctx: UnitsContext): string | undefined {
  switch (unit.class) {
    case "replicaIdentity":
      return qualified(unit.schema, unit.name)
    case "sequenceOwnedBy":
      return sequenceOwner(unit, ctx)
    case "trigger":
    case "policy":
    case "grant":
    case "comment": {
      const target = unitTarget(unit, ctx.parse)
      if (target?.object === undefined || NOT_RELATIONS.has(target.kind))
        return undefined
      return qualified(target.schema || ctx.defaultSchema, target.object)
    }
    default:
      return undefined
  }
}

const MECHANICS = qualified(MECHANICS_FUNCTION.schema, MECHANICS_FUNCTION.name)
const AUTHOR = qualified(AUTHOR_FUNCTION.schema, AUTHOR_FUNCTION.name)
const KEY = qualified(KEY_FUNCTION.schema, KEY_FUNCTION.name)

/**
 * Функція, яку платформний тригер таблиці мусить кликати за своїм іменем:
 * механіка рядка (`<t>_simetra_touch` і, на таблиці з копіями носіїв,
 * `<t>_simetra_touch_update`) — `simetra.touch()`, авторство
 * (`<t>_simetra_author`, `<t>_simetra_author_update`) — `simetra.author()`
 * (Р-A1-8), незмінність ключа (`<t>_simetra_key`, `<t>_simetra_key_after`) —
 * `simetra.key_immutable()` (Рб1-4), тригери копій носіїв —
 * функції носіїв таблиці (Р2a2-20), тригери ефектів — функція ефектів таблиці
 * (Р2b1-12), тригери ієрархії — функція ієрархії таблиці (Р-A2-1). Інше
 * ім'я — не платформний тригер.
 */
function platformTriggerFunction(
  unit: CatalogUnit,
  ctx: UnitsContext
): string | undefined {
  const target = unitTarget(unit, ctx.parse)
  if (target?.object === undefined) return undefined
  const table = {
    schema: target.schema || ctx.defaultSchema,
    name: target.object,
  }
  if (
    unit.name === mechanicsTriggerName(table.name) ||
    unit.name === mechanicsUpdateTriggerName(table.name)
  )
    return MECHANICS
  if (
    unit.name === authorTriggerName(table.name) ||
    unit.name === authorUpdateTriggerName(table.name)
  )
    return AUTHOR
  const key = keyTriggerNames(table.name)
  if (unit.name === key.before || unit.name === key.after) return KEY
  const triggers = carrierTriggerNames(table)
  const functions = carrierFunctionNames(table)
  if (unit.name === triggers.derive)
    return qualified(functions.derive.schema, functions.derive.name)
  if (
    unit.name === triggers.propagate ||
    unit.name === triggers.propagateInsert
  )
    return qualified(functions.propagate.schema, functions.propagate.name)
  // Тригери ієрархії (Р-A2-1): обидва кличуть одну функцію таблиці
  const hierarchy = hierarchyNames(table)
  if (unit.name === hierarchy.insert || unit.name === hierarchy.update)
    return qualified(hierarchy.fn.schema, hierarchy.fn.name)
  // Тригери ефектів дії (Р2b1-12): обидва кличуть одну функцію таблиці
  const effects = effectsTriggerNames(table)
  if (unit.name === effects.all || unit.name === effects.update) {
    const fn = effectsFunctionName(table)
    return qualified(fn.schema, fn.name)
  }
  const guard = rightsGuardNames(table).find(
    (entry) => entry.trigger === unit.name
  )
  if (guard !== undefined)
    return qualified(guard.function.schema, guard.function.name)
  return undefined
}

/**
 * Функції платформних тригерів серед одиниць: механіка, авторство й
 * незмінність ключа (по одній функції на проєкт) й ті функції носіїв,
 * які кличе тригер носіїв з відповідним іменем. Функцію носіїв за самим
 * іменем не впізнаємо: ім'я таблиці, від якого воно походить, дає лише
 * тригер.
 */
function platformFunctions(
  units: readonly CatalogUnit[],
  ctx: UnitsContext
): ReadonlySet<string> {
  const found = new Set([MECHANICS, AUTHOR, KEY])
  for (const unit of units) {
    if (unit.class !== "trigger") continue
    const fn = platformTriggerFunction(unit, ctx)
    if (fn !== undefined && triggerFunction(unit, ctx) === fn) found.add(fn)
  }
  return found
}

/**
 * Платформна одиниця тригерів таблиці (рішення 9 плану П3-3a2, Р2a2-20):
 * механіка рядка й копії носіїв — функція без аргументів, грант лише на такі
 * функції й тригер з платформним ім'ям, що кличе саме свою функцію. Ними
 * володіє платформа, тож вони не пишуться й без збереженого опису теки —
 * модуль користувача ними не володіє. Інший тригер, що кличе ту саму
 * функцію, — власний тригер таблиці: пропуск за самою схемою `simetra` чи
 * за міткою імені його б загубив.
 */
function isPlatformTrigger(
  unit: CatalogUnit,
  ctx: UnitsContext,
  functions: ReadonlySet<string>
): boolean {
  switch (unit.class) {
    case "function":
      return [...functions].some((fn) => unit.identity === `function:${fn}()`)
    case "grant": {
      const targets = grantTargetKeys(unit, ctx.parse)
      return (
        targets.length > 0 &&
        targets.every((t) =>
          [...functions].some((fn) => t === `function|${fn}()`)
        )
      )
    }
    case "trigger": {
      const fn = platformTriggerFunction(unit, ctx)
      return fn !== undefined && triggerFunction(unit, ctx) === fn
    }
    default:
      return false
  }
}

/** Сегмент імені файлу: лише безпечні символи, `[]` — `_array`. */
function slug(text: string): string {
  return text
    .replace(/\[\]/g, "_array")
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
}

/**
 * Ім'я файлу з повної ідентичності одиниці (рішення плану 7): функціям —
 * типи аргументів, іменованим об'єктам — ім'я, решті (грант, коментар,
 * publication, типові привілеї) — уся ідентичність з ціллю й роллю.
 */
function baseName(unit: CatalogUnit, ctx: UnitsContext): string {
  if (SIGNED.has(unit.class)) {
    const prefix = `${unit.class}:${qualified(unit.schema, unit.name)}(`
    const args = unit.identity.startsWith(prefix)
      ? unit.identity.slice(prefix.length, -1)
      : ""
    if (args === "") return slug(unit.name)
    if (args === "*") return `${slug(unit.name)}__star`
    return `${slug(unit.name)}__${args.split(",").map(slug).join("_")}`
  }
  if (NAMED.has(unit.class)) return slug(unit.name)
  if (unit.class === "trigger" || unit.class === "policy") {
    const target = unitTarget(unit, ctx.parse)
    return `${slug(target?.object ?? "")}__${slug(unit.name)}`
  }
  const segments = unit.identity.split(":")
  // Ідентичність гранту вже починається дієсловом `grant`/`revoke`.
  if (segments[1] === segments[0]) segments.shift()
  return segments.map(slug).join("__")
}

/** Схема теки спільної одиниці: власна, інакше схема цілі, інакше проєкту. */
function schemaDir(unit: CatalogUnit, ctx: UnitsContext): string {
  if (unit.schema !== "") return unit.schema
  const schemas = unitPlacement(unit, ctx.parse)
    .map((t) => t.schema)
    .filter((s) => s !== "")
    .sort()
  return schemas[0] ?? ctx.defaultSchema
}

/**
 * Розкладка дослівних одиниць по файлах (спека П2 §3, рішення плану 7):
 * усе, що належить одній згенерованій таблиці, разом із тригерною функцією,
 * яку викликають лише її тригери, — у `<Ім'я>.sql` таблиці; решта — по
 * одній одиниці на файл у `sql/<схема>/`.
 */
export function layoutUnits(
  units: readonly CatalogUnit[],
  ctx: UnitsContext
): UnitFiles {
  const users = new Map<string, Set<string>>()
  for (const unit of units) {
    if (unit.class !== "trigger") continue
    const fn = triggerFunction(unit, ctx)
    const table = ownerTable(unit, ctx)
    if (fn === undefined || table === undefined) continue
    const set = users.get(fn) ?? new Set()
    set.add(table)
    users.set(fn, set)
  }
  // Тригерна функція без аргументів, яку викликають тригери однієї таблиці.
  const ownFunctions = new Map<string, string>()
  for (const [fn, tables] of users) {
    // Обробник підписки — виклик із збереженого файлу, як тригер довідника.
    if (ctx.handlers.has(fn)) continue
    const [table] = tables
    const sidecar = table === undefined ? undefined : ctx.sidecars.get(table)
    if (tables.size === 1 && sidecar !== undefined)
      ownFunctions.set(fn, sidecar)
  }
  const pathOf = (unit: CatalogUnit): string => {
    const fn = qualified(unit.schema, unit.name)
    const own = ownFunctions.get(fn)
    if (
      own !== undefined &&
      ((unit.class === "function" && unit.identity === `function:${fn}()`) ||
        (unit.class === "functionSettings" &&
          unit.identity === `functionSettings:${fn}()`))
    )
      return own
    if (unit.class === "grant" || unit.class === "comment") {
      const target = unitTarget(unit, ctx.parse)
      if (target?.kind === "function" && withoutArguments(unit, ctx)) {
        const sidecar = ownFunctions.get(
          qualified(target.schema || ctx.defaultSchema, target.object ?? "")
        )
        if (sidecar !== undefined) return sidecar
      }
    }
    const table = ownerTable(unit, ctx)
    const sidecar = table === undefined ? undefined : ctx.sidecars.get(table)
    if (sidecar !== undefined) return sidecar
    return `sql/${schemaDir(unit, ctx)}/${baseName(unit, ctx)}.sql`
  }

  const grouped = new Map<string, CatalogUnit[]>()
  const platform = platformFunctions(units, ctx)
  const platformOwned = (unit: CatalogUnit) =>
    grantTargetKeys(unit, ctx.parse).some((target) =>
      ownsTarget(ctx.platformGrants, target)
    )
  for (const unit of units) {
    if (
      ctx.described.has(unit.identity) ||
      platformOwned(unit) ||
      isPlatformTrigger(unit, ctx, platform)
    )
      continue
    const path = pathOf(unit)
    grouped.set(path, [...(grouped.get(path) ?? []), unit])
  }
  const sidecarPaths = new Set(ctx.sidecars.values())
  const rank = (u: CatalogUnit) => {
    const index = SIDECAR_ORDER.indexOf(u.class)
    return index === -1 ? SIDECAR_ORDER.length : index
  }
  // Табличний REVOKE знімає й колонкові гранти, тож у файлі він іде раніше за
  // GRANT. Рендер і тінь слідують графу створення (ребро в
  // compiler/sql/dependencies.ts), а не порядку файлу; порядок тут потрібен
  // людині, що читає файл або застосовує його вручну.
  const revokeFirst = (u: CatalogUnit) =>
    u.class === "grant" && u.identity.startsWith("grant:revoke:") ? 0 : 1
  const files = new Map<string, string>()
  const diagnostics: Diagnostic[] = []
  // Файлова система без регістру злила б `F.sql` і `f.sql` в один файл.
  const folded = new Map<string, string>()
  for (const [path, list] of [...grouped].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0
  )) {
    const ordered = [...list].sort(
      (a, b) =>
        rank(a) - rank(b) ||
        revokeFirst(a) - revokeFirst(b) ||
        (a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0)
    )
    const clash = folded.get(path.toLowerCase())
    if (
      !sidecarPaths.has(path) &&
      (ordered.length > 1 || clash !== undefined)
    ) {
      diagnostics.push(
        diagnostic("introspect.path-collision", path, "", {
          path,
          first: clash ?? ordered[0]!.identity,
          second: ordered.at(-1)!.identity,
        })
      )
      continue
    }
    folded.set(path.toLowerCase(), ordered[0]!.identity)
    files.set(
      path,
      `${ordered.map((u) => terminate(explicitVolatility(u, ctx.parse))).join("\n\n")}\n`
    )
  }
  return { files, diagnostics }
}
