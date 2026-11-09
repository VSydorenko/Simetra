import type { CatalogEntry, CatalogIndex } from "simetra/model"
import { readKeys, type CoreSource } from "./source"
import type { Key, ObjectName, RowView, ServerRow, Values } from "./types"

/*
 * Етап `include` вигляду (спека П4-B §6.2): ключі цілей одноцільового `Ref`
 * з рядків вигляду стають підмножиною `keys` цілі, власник якої — вигляд.
 * Цілі читає `readKeys` — єдиний шлях перечитування за ключем — тож частини
 * по `keysPerRequest` проходять спільний обмежувач джерела.
 */

/** One included attribute and its target object. */
export interface IncludeStep {
  readonly attribute: string
  readonly target: ObjectName
  readonly entry: CatalogEntry
}

/**
 * Resolves the `include` attributes of a view: each must be a single-target
 * `Ref` of the object; anything else is a developer error (`TypeError`),
 * thrown before any request.
 */
export function includeSteps(
  object: ObjectName,
  entry: CatalogEntry,
  index: CatalogIndex,
  include: readonly string[] | undefined
): readonly IncludeStep[] {
  if (include === undefined) return []
  return [...new Set(include)].map((attribute) => {
    const ref = entry.attributes.find((a) => a.name === attribute)?.ref
    const target = ref === undefined ? undefined : index.byId.get(ref.object)
    if (target === undefined) {
      throw new TypeError(
        `${object}: include ${attribute} is not a single-target Ref`
      )
    }
    return {
      attribute,
      target: `${target.kind}.${target.name}`,
      entry: target,
    }
  })
}

/** The deduplicated target keys of `rows`, by target object. */
export function includeKeys(
  steps: readonly IncludeStep[],
  rows: Iterable<Values>
): Map<ObjectName, Key[]> {
  const wanted = new Map<ObjectName, Set<Key>>()
  for (const step of steps) wanted.set(step.target, new Set())
  for (const values of rows) {
    for (const step of steps) {
      const value = values[step.attribute]
      if (typeof value === "string") wanted.get(step.target)!.add(value)
    }
  }
  return new Map([...wanted].map(([object, keys]) => [object, [...keys]]))
}

/** The target rows read for a view, by target object. */
export type Included = Map<
  ObjectName,
  { readonly keys: readonly Key[]; readonly rows: readonly ServerRow[] }
>

/**
 * Reads the target keys of every step through `readKeys` — every object in
 * parallel, the source limiter bounds the reads in flight.
 */
export async function readIncluded(
  source: CoreSource,
  steps: readonly IncludeStep[],
  wanted: ReadonlyMap<ObjectName, readonly Key[]>,
  keysPerRequest: number
): Promise<Included> {
  const entries = new Map(steps.map((s) => [s.target, s.entry]))
  const results = await Promise.all(
    [...wanted].map(async ([object, keys]) => {
      const rows =
        keys.length === 0
          ? []
          : await readKeys(source, entries.get(object)!, keys, {
              keysPerRequest,
            })
      return [object, { keys, rows }] as const
    })
  )
  return new Map(results)
}

/**
 * The `refs` of a row: the target view, or `null` for an empty reference, a
 * target outside the store and a removed target (§6.2 rule 5).
 */
export function refsOf(
  steps: readonly IncludeStep[],
  values: Values,
  viewOf: (object: ObjectName, key: Key) => RowView | undefined
): Record<string, RowView | null> {
  const refs: Record<string, RowView | null> = {}
  for (const step of steps) {
    const value = values[step.attribute]
    const target =
      typeof value === "string" ? viewOf(step.target, value) : undefined
    refs[step.attribute] =
      target === undefined || target.state === "removed" ? null : target
  }
  return refs
}
