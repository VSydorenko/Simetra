import {
  catalogFromSnapshot,
  diffCatalogModels,
  type CatalogTable,
  type CatalogUnit,
  type PhysicalTable,
} from "simetra/model"
import type { SqlParser } from "../sql/parse"
import { withoutLocations, type SqlUnit } from "../sql/units"

/**
 * What the platform itself installs or renders, as the recogniser compares
 * it: tables of the platform (no owner object) and generated units.
 */
export interface PlatformReference {
  tables: readonly PhysicalTable[]
  units: readonly Pick<SqlUnit, "class" | "identity" | "sql">[]
}

/** A unit of a live catalog, as the recogniser reads it. */
export type RecognisedUnit = Pick<CatalogUnit, "class" | "identity" | "sql">

/**
 * Recogniser of platform content among the objects of a catalog: a table or
 * unit is the platform's only when its content matches the reference. A
 * grant is the platform's when every atom of its parse tree (action, object,
 * role, privilege with column, grant option, behaviour, grantor) is an atom
 * of a reference grant; any other unit when its normalised parse tree equals
 * the tree of the reference unit with the same identity; a table when the
 * catalog comparison with the reference table finds no difference. What does
 * not parse, has no reference or differs without a normalisation rule is not
 * the platform's: the folder gets it and the compiler judges it.
 */
export interface PlatformRecogniser {
  table(table: CatalogTable): boolean
  unit(unit: RecognisedUnit): boolean
}

export function platformRecogniser(
  reference: PlatformReference,
  parse: SqlParser
): PlatformRecogniser {
  const tables = new Map(
    reference.tables.map((t) => [`${t.schema}.${t.name}`, t])
  )
  const atoms = new Set<string>()
  const trees = new Map<string, string>()
  for (const u of reference.units) {
    const stmt = statementOf(u.sql, parse)
    if (stmt === undefined) continue
    if (u.class === "grant") {
      for (const atom of grantAtomsOf(stmt) ?? []) atoms.add(atom)
    } else trees.set(`${u.class}|${u.identity}`, canon(normalised(stmt)))
  }
  return {
    table: (table) => {
      const own = tables.get(`${table.schema}.${table.name}`)
      if (own === undefined) return false
      const expected = comparable(
        catalogFromSnapshot({ tables: [own], enumTypes: [] }).tables[0]!,
        parse
      )
      const actual = comparable(table, parse)
      if (expected === undefined || actual === undefined) return false
      return (
        diffCatalogModels(
          { tables: [expected], enumTypes: [], units: [] },
          { tables: [actual], enumTypes: [], units: [] },
          // Порядок колонок — не вміст: та сама опція, що й у дрейфу
          // «проєкт ↔ ціль»
          { columnOrder: false }
        ).length === 0
      )
    },
    unit: (unit) => {
      const stmt = statementOf(unit.sql, parse)
      if (stmt === undefined) return false
      if (unit.class === "grant") {
        const own = grantAtomsOf(stmt)
        return (
          own !== undefined &&
          own.length > 0 &&
          own.every((atom) => atoms.has(atom))
        )
      }
      const expected = trees.get(`${unit.class}|${unit.identity}`)
      return expected !== undefined && expected === canon(normalised(stmt))
    },
  }
}

type Tree = Record<string, unknown>

const isTree = (value: unknown): value is Tree =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Єдиний оператор тексту без позицій; інакше — `undefined` (не платформне). */
function statementOf(sql: string, parse: SqlParser): Tree | undefined {
  const parsed = parse(sql)
  if (!parsed.ok || parsed.statements.length !== 1) return undefined
  const stmt = withoutLocations(parsed.statements[0]!.stmt)
  return isTree(stmt) ? stmt : undefined
}

/** Канонічна JSON-форма: порядок ключів не впливає. */
function canon(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    isTree(v)
      ? Object.fromEntries(
          Object.entries(v).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
        )
      : v
  )
}

/**
 * Поля `GrantStmt`, з яких складається атом. Поле поза цим переліком, але
 * не пусте, робить грант не платформним: форма, якої атом не знає, не може
 * збігтися з еталоном мовчки.
 */
const GRANT_FIELDS = new Set([
  "is_grant",
  "targtype",
  "objtype",
  "objects",
  "privileges",
  "grantees",
  "grant_option",
  "behavior",
  "grantor",
])

const isEmpty = (value: unknown) =>
  value === undefined ||
  value === false ||
  (Array.isArray(value) && value.length === 0)

/**
 * Атоми гранту з дерева розбору: один на (об'єкт, роль, привілей, колонка).
 * Каталог тримає грант у своїй формі (одна одиниця на колонку, злиті
 * привілеї ролі), але кожен атом той самий. Роль — вузол `RoleSpec`, не
 * рядок ідентичності, тож лапки й коми в імені нічого не ділять.
 */
function grantAtomsOf(stmt: Tree): string[] | undefined {
  const grant = stmt.GrantStmt
  if (!isTree(grant)) return undefined
  if (
    Object.keys(grant).some((k) => !GRANT_FIELDS.has(k) && !isEmpty(grant[k]))
  )
    return undefined
  const objects = Array.isArray(grant.objects) ? grant.objects : []
  const grantees = Array.isArray(grant.grantees) ? grant.grantees : []
  // Порожній перелік привілеїв — `ALL`
  const privileges = Array.isArray(grant.privileges)
    ? grant.privileges.flatMap((p): [string, string | null][] => {
        const priv = isTree(p) && isTree(p.AccessPriv) ? p.AccessPriv : {}
        const name = typeof priv.priv_name === "string" ? priv.priv_name : ""
        const cols = Array.isArray(priv.cols) ? priv.cols : []
        return cols.length === 0
          ? [[name, null]]
          : cols.map((c) => [name, canon(c)])
      })
    : []
  const privilegeList: [string, string | null][] =
    privileges.length === 0 ? [["all", null]] : privileges
  const shared = {
    is_grant: grant.is_grant === true,
    targtype: grant.targtype ?? null,
    objtype: grant.objtype ?? null,
    grant_option: grant.grant_option === true,
    behavior: grant.behavior ?? "DROP_RESTRICT",
    grantor: grant.grantor ?? null,
  }
  return objects.flatMap((object) =>
    grantees.flatMap((role) =>
      privilegeList.map(([privilege, column]) =>
        canon({ ...shared, object, role, privilege, column })
      )
    )
  )
}

/**
 * Закритий перелік відмінностей «форма каталогу ↔ форма генератора» (спека
 * П2 §9, «Платформне — за вмістом»). Кожне правило має тест-пару, записану з
 * живого extract обох профілів (`__tests__/fixtures/platform-catalog-forms.ts`);
 * нове правило з'являється лише з такою парою. Позиції прибрано вже
 * (`withoutLocations`).
 */
function normalised(stmt: Tree): Tree {
  if (isTree(stmt.CreateFunctionStmt))
    return {
      CreateFunctionStmt: functionWithoutDefaults(stmt.CreateFunctionStmt),
    }
  if (isTree(stmt.CreateSeqStmt)) {
    const seq = sequenceWithDefaults(stmt.CreateSeqStmt)
    if (seq !== undefined) return { CreateSeqStmt: seq }
  }
  return stmt
}

const defElem = (option: unknown): Tree | undefined =>
  isTree(option) && isTree(option.DefElem) ? option.DefElem : undefined

/**
 * `pg_get_functiondef` не друкує типового `SECURITY INVOKER`, а генератор
 * пише його явно.
 */
function functionWithoutDefaults(fn: Tree): Tree {
  const options = Array.isArray(fn.options) ? fn.options : []
  return {
    ...fn,
    options: options.filter((option) => {
      const d = defElem(option)
      return !(
        d?.defname === "security" &&
        isTree(d.arg) &&
        isTree(d.arg.Boolean) &&
        d.arg.Boolean.boolval !== true
      )
    }),
  }
}

/** Межі типу послідовності `AS …`; інший тип — правила немає. */
const SEQUENCE_TYPES: Readonly<Record<string, [bigint, bigint]>> = {
  int2: [-32768n, 32767n],
  int4: [-2147483648n, 2147483647n],
  int8: [-9223372036854775808n, 9223372036854775807n],
}

/** Число вузла опції (`Integer` без `ival` — нуль; велике — `Float`). */
function numberOf(arg: unknown): bigint | undefined {
  if (!isTree(arg)) return undefined
  if (isTree(arg.Integer))
    return BigInt(typeof arg.Integer.ival === "number" ? arg.Integer.ival : 0)
  if (isTree(arg.Float) && typeof arg.Float.fval === "string")
    return /^-?\d+$/.test(arg.Float.fval) ? BigInt(arg.Float.fval) : undefined
  return undefined
}

/**
 * Extract друкує всі параметри `CREATE SEQUENCE` явно (`INCREMENT BY 1`,
 * `MAXVALUE` типу, `START WITH`), а генератор — лише нетипові. Обидві форми
 * зводяться до повного набору з типовими значеннями Postgres
 * (`CREATE SEQUENCE`, розділ «Parameters»). Параметр поза набором лишається
 * як є; невідомий тип чи значення — без правила (`undefined`).
 */
function sequenceWithDefaults(seq: Tree): Tree | undefined {
  const options = Array.isArray(seq.options) ? seq.options : []
  const given = new Map<string, unknown>()
  const rest: unknown[] = []
  for (const option of options) {
    const d = defElem(option)
    const name = typeof d?.defname === "string" ? d.defname : undefined
    if (
      name !== undefined &&
      [
        "as",
        "increment",
        "minvalue",
        "maxvalue",
        "start",
        "cache",
        "cycle",
      ].includes(name) &&
      !given.has(name)
    )
      given.set(name, d!.arg)
    else rest.push(option)
  }
  let type = "int8"
  if (given.has("as")) {
    const t = given.get("as")
    const names =
      isTree(t) && isTree(t.TypeName) && Array.isArray(t.TypeName.names)
        ? t.TypeName.names.map((n) =>
            isTree(n) && isTree(n.String) ? n.String.sval : undefined
          )
        : []
    if (names.length !== 2 || names[0] !== "pg_catalog") return undefined
    type = String(names[1])
  }
  const bounds = SEQUENCE_TYPES[type]
  if (bounds === undefined) return undefined
  const number = (name: string, fallback: bigint): bigint | undefined => {
    if (!given.has(name)) return fallback
    const arg = given.get(name)
    // `NO MINVALUE`/`NO MAXVALUE` — опція без значення: типове
    return arg === undefined ? fallback : numberOf(arg)
  }
  const increment = number("increment", 1n)
  if (increment === undefined) return undefined
  const ascending = increment > 0n
  const minvalue = number("minvalue", ascending ? 1n : bounds[0])
  const maxvalue = number("maxvalue", ascending ? bounds[1] : -1n)
  if (minvalue === undefined || maxvalue === undefined) return undefined
  const start = number("start", ascending ? minvalue : maxvalue)
  const cache = number("cache", 1n)
  if (start === undefined || cache === undefined) return undefined
  const cycleArg = given.get("cycle")
  const cycle =
    isTree(cycleArg) && isTree(cycleArg.Boolean)
      ? cycleArg.Boolean.boolval === true
      : given.has("cycle")
        ? undefined
        : false
  if (cycle === undefined) return undefined
  return {
    ...seq,
    options: rest,
    defaults: {
      type,
      increment: String(increment),
      minvalue: String(minvalue),
      maxvalue: String(maxvalue),
      start: String(start),
      cache: String(cache),
      cycle,
    },
  }
}

/**
 * Таблиця для порівняння: тексти виразів CHECK — дерево розбору з правилом
 * «рядковий літерал з приведенням до `text` ↔ літерал». База зберігає CHECK
 * розібраним і друкує його з приведеннями й дужками (`(method =
 * 'publish'::text)`), генератор — у формі автора (`method = 'publish'`).
 * Вираз, що не розбирається, — `undefined` (не платформне).
 */
function comparable(
  table: CatalogTable,
  parse: SqlParser
): CatalogTable | undefined {
  const checks: CatalogTable["checks"] = []
  for (const check of table.checks) {
    const parsed = parse(`SELECT (${check.expression})`)
    if (!parsed.ok || parsed.statements.length !== 1) return undefined
    checks.push({
      ...check,
      expression: canon(
        withoutTextLiteralCasts(withoutLocations(parsed.statements[0]!.stmt))
      ),
    })
  }
  return { ...table, checks }
}

/** `'x'::text` → `'x'`: так друкує база літерал, який автор лишив без типу. */
function withoutTextLiteralCasts(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutTextLiteralCasts)
  if (!isTree(value)) return value
  const cast = value.TypeCast
  if (isTree(cast) && isTextLiteralCast(cast)) return cast.arg
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k, withoutTextLiteralCasts(v)])
  )
}

function isTextLiteralCast(cast: Tree): boolean {
  const arg = cast.arg
  const type = cast.typeName
  if (!isTree(arg) || !isTree(arg.A_Const) || !isTree(arg.A_Const.sval))
    return false
  if (!isTree(type)) return false
  const { names, typemod, ...rest } = type
  return (
    Array.isArray(names) &&
    names.length === 1 &&
    isTree(names[0]) &&
    isTree(names[0].String) &&
    names[0].String.sval === "text" &&
    typemod === -1 &&
    Object.values(rest).every(isEmpty)
  )
}
