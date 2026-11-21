import { encodeId, parseId, type StableId } from "@supabase/pg-delta"
import {
  grantAtoms,
  keyIdentity,
  qualifiedName,
  readSqlUnits,
  unitIdentity,
  type PlatformInstall,
  type SqlParser,
} from "simetra/compiler"
import type { CatalogDifference } from "simetra/model"
import type { EngineAction } from "simetra/schema"

/**
 * The exact platform install that `diff` of a database without the apply
 * state shows (fork (b) of the outbox: the first apply installs the platform
 * part, and `diff` lists that install). The expectation is derived from
 * `platformInstall` — the compiled empty project — so a new platform table or
 * unit changes it by itself, and the comparison is exact on two levels:
 * objects (tables and non-grant units) and grants as
 * `<grant|revoke>|<target object>|<role>` pairs. Every plan action and every
 * difference names install objects and install grants only, and together
 * they name every one of them. Pure: its own unit test pins the mapping on
 * the engine's real output shape. The comparison is in the unit language:
 * an engine id of a plan action is read into the unit identity through the
 * same `readSqlUnits` that maps engine SQL (`classifyUnit`), because the
 * engine leaves upper case and keywords unquoted (`(interval)`), while the
 * unit identity quotes every name part (`("interval")`).
 */

type Action = Pick<EngineAction, "sql" | "produces" | "consumes" | "destroys">

/**
 * Object classes whose built-in default privileges (PostgreSQL docs, table
 * 5.2) give `PUBLIC` something — `EXECUTE` on routines, `USAGE` on types and
 * languages. Only there a revoke from `PUBLIC` changes the catalog; a revoke
 * from any other role, or on another class, removes nothing and is not a
 * difference.
 */
const PUBLIC_DEFAULT_CLASSES: ReadonlySet<string> = new Set([
  "function",
  "procedure",
  "routine",
  "type",
  "domain",
  "language",
])

/** Grant pair of an atom `<action>|<class>|<object>|<role>|<privilege>`. */
function pairOf(atom: string): { pair: string; visible: boolean } {
  const [action, kind, object, role] = atom.split("|")
  return {
    pair: `${action}|${kind}:${object}|${role}`,
    visible:
      action === "grant" ||
      (role === "public" && PUBLIC_DEFAULT_CLASSES.has(kind!)),
  }
}

/** Grant pairs of a grant unit identity. */
const pairsOf = (identity: string): string[] =>
  unique(grantAtoms(identity).map((a) => pairOf(a).pair))

/** What the install creates, without what the apply state owns. */
export interface InstallExpectation {
  /** Engine ids of the install tables and non-grant units. */
  objects: string[]
  /** Grant pairs the catalog shows: `<grant|revoke>|<object>|<role>`. */
  grants: string[]
}

export function installObjects(
  install: PlatformInstall,
  ownedByState: (identity: string) => boolean
): InstallExpectation {
  const units = install.units.filter((u) => !ownedByState(u.identity))
  return {
    objects: [
      ...install.tables.map((t) => unitIdentity("table", t.schema, t.name)),
      ...units.filter((u) => u.class !== "grant").map((u) => u.identity),
    ]
      .filter((id) => !ownedByState(id))
      .sort(),
    grants: unique(
      units
        .filter((u) => u.class === "grant")
        .flatMap((u) => grantAtoms(u.identity).map(pairOf))
        .filter((p) => p.visible)
        .map((p) => p.pair)
    ),
  }
}

/**
 * The unit identity of the object an engine id is about: a member of a table
 * (column, constraint, default) is its table, an ACL or a comment is its
 * object; a role or a schema is a dependency, not an install object. A
 * routine is read by `readSqlUnits` from a statement that names it, so its
 * argument types take the canonical form of the unit; a kind the unit
 * language has no class for keeps the engine id and matches nothing.
 */
function objectOf(id: StableId, parse: SqlParser): string | undefined {
  switch (id.kind) {
    case "comment":
    case "acl":
    case "securityLabel":
      return objectOf(id.target, parse)
    case "role":
    case "schema":
      return undefined
    case "column":
    case "constraint":
    case "default":
      return unitIdentity("table", id.schema, id.table)
    case "trigger":
    case "policy":
      return unitIdentity(id.kind, id.schema, id.table, id.name)
    case "table":
    case "view":
    case "materializedView":
    case "sequence":
    case "domain":
      return unitIdentity(id.kind, id.schema, id.name)
    case "extension":
      return unitIdentity(id.kind, id.name)
    case "function":
    case "procedure":
    case "aggregate":
      return routineIdentity(id, parse)
    default:
      return encodeId(id)
  }
}

/** Routine identity from `COMMENT ON` its signature: the target is the key. */
function routineIdentity(
  id: Extract<StableId, { kind: "function" | "procedure" | "aggregate" }>,
  parse: SqlParser
): string {
  const sql = `COMMENT ON ${id.kind === "procedure" ? "PROCEDURE" : "FUNCTION"} ${qualifiedName(id.schema, id.name)}(${id.args.join(", ")}) IS ''`
  const { units, diagnostics } = readSqlUnits(
    [{ file: "engine", text: sql, schema: "" }],
    parse,
    []
  )
  const [unit] = units
  if (unit === undefined || units.length > 1 || diagnostics.length > 0) {
    throw new Error(`engine routine is outside the unit language: ${sql}`)
  }
  return keyIdentity(id.kind, unit.name)
}

/** Objects of a plan action: what it creates or drops, else what it changes. */
export function actionObjects(action: Action, parse: SqlParser): string[] {
  const own = [...action.produces, ...action.destroys]
  const ids = own.length > 0 ? own : action.consumes
  return unique(ids.flatMap((id) => objectOf(parseId(id), parse) ?? []))
}

/**
 * Grant pairs of a plan action: the direction from its statement, the roles
 * from `role:` dependencies and from ACL entries (`acl:(…).<role>`), the
 * targets from its objects. Not a grant statement — no pairs.
 */
export function actionGrants(action: Action, parse: SqlParser): string[] {
  const direction = /^\s*(GRANT|REVOKE)\b/i.exec(action.sql)?.[1]
  if (direction === undefined) return []
  const ids = [...action.produces, ...action.destroys, ...action.consumes]
  const roles = unique(
    ids.flatMap((id) => {
      if (id.startsWith("role:")) return [id.slice("role:".length)]
      const acl = /^acl:\(.*\)\.(?:grantee:)?([^.()]+)$/.exec(id)
      return acl === null ? [] : [acl[1]!.toLowerCase()]
    })
  )
  return unique(
    actionObjects(action, parse).flatMap((object) =>
      (roles.length > 0 ? roles : ["?"]).map(
        (role) => `${direction.toLowerCase()}|${object}|${role}`
      )
    )
  )
}

/** Objects of a catalog difference: a table, or the targets of a unit. */
export function differenceObjects(path: string): string[] {
  const table = /^tables\.([^.]+)\.([^.]+)(?:\.|$)/.exec(path)
  if (table !== null) return [unitIdentity("table", table[1]!, table[2]!)]
  if (!path.startsWith("units.")) return []
  const identity = path.slice("units.".length)
  if (!identity.startsWith("grant:")) return [identity]
  return unique(pairsOf(identity).map((pair) => pair.split("|")[1]!))
}

/** Grant pairs of a catalog difference (`units.grant:…`). */
export function differenceGrants(path: string): string[] {
  const identity = path.startsWith("units.") ? path.slice("units.".length) : ""
  return identity.startsWith("grant:") ? pairsOf(identity) : []
}

const unique = (values: readonly string[]) => [...new Set(values)].sort()

/**
 * Mismatch between the diff and the expected install, as data: actions and
 * differences that name no install object or one outside the set, grant
 * pairs outside the expectation, and install objects or grant pairs neither
 * the plan nor the differences name. All empty — exact.
 */
export function installMismatch(
  data: { plan: readonly Action[]; differences: readonly CatalogDifference[] },
  expected: InstallExpectation,
  parse: SqlParser
): {
  foreignActions: Action[]
  foreignDifferences: string[]
  foreignGrants: string[]
  unplanned: string[]
  undifferenced: string[]
} {
  const wanted = new Set([...expected.objects])
  const foreign = (objects: string[]) =>
    objects.length === 0 || objects.some((o) => !wanted.has(o))
  const plannedGrants = data.plan.flatMap((a) => actionGrants(a, parse))
  const differencedGrants = data.differences.flatMap((d) =>
    differenceGrants(d.path)
  )
  const planned = new Set([
    ...data.plan.flatMap((a) => actionObjects(a, parse)),
    ...plannedGrants,
  ])
  const differenced = new Set([
    ...data.differences.flatMap((d) => differenceObjects(d.path)),
    ...differencedGrants,
  ])
  const grants = new Set(expected.grants)
  const all = [...expected.objects, ...expected.grants]
  return {
    foreignActions: data.plan.filter((a) => foreign(actionObjects(a, parse))),
    foreignDifferences: data.differences
      .map((d) => d.path)
      .filter((path) => foreign(differenceObjects(path))),
    foreignGrants: unique(
      [...plannedGrants, ...differencedGrants].filter((g) => !grants.has(g))
    ),
    unplanned: all.filter((o) => !planned.has(o)),
    undifferenced: all.filter((o) => !differenced.has(o)),
  }
}
