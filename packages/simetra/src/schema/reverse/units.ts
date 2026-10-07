import {
  diagnostic,
  type Diagnostic,
  type Node,
  type SqlParser,
} from "simetra/compiler"
import type { CatalogUnit, SqlUnitClass } from "simetra/model"
import { unitPlacement, unitTarget } from "../engine/unit-target"
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
  for (const unit of units) {
    if (ctx.described.has(unit.identity)) continue
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
    files.set(path, `${ordered.map((u) => terminate(u.sql)).join("\n\n")}\n`)
  }
  return { files, diagnostics }
}
