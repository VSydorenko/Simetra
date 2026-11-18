import type { PlatformInstall } from "simetra/compiler"
import type { CatalogDifference } from "simetra/model"
import type { EngineAction } from "simetra/schema"

/**
 * The exact set of platform-install objects that `diff` of a database without
 * the apply state shows (fork (b) of the outbox: the first apply installs the
 * platform part, and `diff` lists that install). The set is derived from
 * `platformInstall` — the compiled empty project — so a new platform table or
 * unit changes the expectation by itself, and the comparison is exact: every
 * plan action and every difference names install objects only, and together
 * they name every one of them. Pure: its own unit test pins the mapping on
 * the engine's real output shape.
 */

type Action = Pick<EngineAction, "produces" | "consumes" | "destroys">

/** Objects the install creates, without those of the apply state. */
export function installObjects(
  install: PlatformInstall,
  ownedByState: (identity: string) => boolean
): string[] {
  return [
    ...install.tables.map((t) => `table:${t.schema}.${t.name}`),
    // Грант — не об'єкт: він належить своїй цілі, а форму гранту каталог
    // тримає свою (по колонці, злиті привілеї)
    ...install.units.filter((u) => u.class !== "grant").map((u) => u.identity),
  ]
    .filter((id) => !ownedByState(id))
    .sort()
}

/**
 * The object an engine identity is about: a member of a table (column,
 * constraint, default) is its table, an ACL or a comment is its object; a
 * role or a schema is a dependency, not an install object.
 */
function objectOf(id: string): string | undefined {
  const wrapped = /^(?:comment|acl|securityLabel):\((.*)\)/.exec(id)
  if (wrapped !== null) return objectOf(wrapped[1]!)
  const member = /^(?:column|constraint|default):(.+)\.[^.]+$/.exec(id)
  if (member !== null) return `table:${member[1]}`
  if (/^(?:role|schema):/.test(id)) return undefined
  return id
}

/** Objects of a plan action: what it creates or drops, else what it changes. */
export function actionObjects(action: Action): string[] {
  const own = [...action.produces, ...action.destroys]
  const ids = own.length > 0 ? own : action.consumes
  return unique(ids.flatMap((id) => objectOf(id) ?? []))
}

/** Objects of a catalog difference: a table, or the targets of a unit. */
export function differenceObjects(path: string): string[] {
  const table = /^tables\.([^.]+\.[^.]+)(?:\.|$)/.exec(path)
  if (table !== null) return [`table:${table[1]}`]
  if (!path.startsWith("units.")) return []
  const identity = path.slice("units.".length)
  // Ідентичність гранту: `grant:<grant|revoke>:<клас>:<об'єкти>:<ролі>:…`
  const grant = /^grant:(?:grant|revoke):([^:]+):([^:]+):/.exec(identity)
  if (grant === null) return [identity]
  return splitObjects(grant[2]!).map((name) => `${grant[1]}:${name}`)
}

/** Objects of a grant joined by commas; a comma inside `(…)` does not split. */
function splitObjects(text: string): string[] {
  const names: string[] = []
  let depth = 0
  let current = ""
  for (const char of text) {
    if (char === "(") depth += 1
    if (char === ")") depth -= 1
    if (depth === 0 && char === ",") {
      names.push(current)
      current = ""
    } else current += char
  }
  return [...names, current]
}

const unique = (values: readonly string[]) => [...new Set(values)].sort()

/**
 * Mismatch between the diff and the expected install objects, as data:
 * actions and differences that name no install object or an object outside
 * the set, and install objects neither of them names. All empty — exact.
 */
export function installMismatch(
  data: { plan: readonly Action[]; differences: readonly CatalogDifference[] },
  expected: readonly string[]
): {
  foreignActions: Action[]
  foreignDifferences: string[]
  unplanned: string[]
  undifferenced: string[]
} {
  const wanted = new Set(expected)
  const foreign = (objects: string[]) =>
    objects.length === 0 || objects.some((o) => !wanted.has(o))
  const planned = new Set(data.plan.flatMap(actionObjects))
  const differenced = new Set(
    data.differences.flatMap((d) => differenceObjects(d.path))
  )
  return {
    foreignActions: data.plan.filter((a) => foreign(actionObjects(a))),
    foreignDifferences: data.differences
      .map((d) => d.path)
      .filter((path) => foreign(differenceObjects(path))),
    unplanned: expected.filter((o) => !planned.has(o)),
    undifferenced: expected.filter((o) => !differenced.has(o)),
  }
}
