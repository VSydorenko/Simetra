import {
  CommandFailure,
  type CatalogEntry,
  type CatalogIndex,
} from "simetra/model"
import {
  readKeys,
  serverRow,
  type BoundSource,
  type ReadKeysOptions,
} from "./source"
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

/**
 * The target rows read for a view, by target object. `keys` — the targets the
 * read answered for (a requested key without a row is `removed`); `rows` are
 * written as they come, also those outside `keys` (a held target the view no
 * longer refers to is written and let go).
 */
export type Included = Map<
  ObjectName,
  { readonly keys: readonly Key[]; readonly rows: readonly ServerRow[] }
>

/**
 * The targets a read with `include` answered (§6.7): the keys the rows of the
 * page refer to, for every target the answer carries. A target the answer
 * lacks (no `included` at all — an adapter without the capability — or a
 * target the core stripped as incompatible) is not answered: no keys.
 */
export function includedFrom(
  steps: readonly IncludeStep[],
  rows: Iterable<Values>,
  raw: Record<string, Record<string, unknown>[]> | undefined,
  epoch: string | null
): Included {
  const wanted = includeKeys(steps, rows)
  const entries = new Map(steps.map((s) => [s.target, s.entry]))
  return new Map(
    [...wanted].map(([object, keys]) => {
      const answered = raw?.[object]
      return [
        object,
        answered === undefined
          ? { keys: [], rows: [] }
          : {
              keys,
              rows: answered.map((values) =>
                serverRow(entries.get(object)!, values, epoch)
              ),
            },
      ]
    })
  )
}

/** Both reads of a target together: keys and rows united, the first row of a key stays. */
export function mergeIncluded(a: Included, b: Included): Included {
  const out: Included = new Map()
  for (const object of new Set([...a.keys(), ...b.keys()])) {
    const parts = [a.get(object), b.get(object)]
    const seen = new Set<Key>()
    out.set(object, {
      keys: [...new Set(parts.flatMap((part) => part?.keys ?? []))],
      rows: parts
        .flatMap((part) => part?.rows ?? [])
        .filter((row) => !seen.has(row.key) && seen.add(row.key)),
    })
  }
  return out
}

/**
 * Completes the targets a read already answered (`covered`) to `wanted`: only
 * the keys it did not answer for are read, by keys, in the next request; the
 * result answers for `wanted` keys it covers (the rows stay as they came).
 */
export async function completeIncluded(
  source: BoundSource,
  steps: readonly IncludeStep[],
  wanted: ReadonlyMap<ObjectName, readonly Key[]>,
  covered: Included,
  keysPerRequest: number
): Promise<Included> {
  const rest = new Map(
    [...wanted].map(([object, keys]) => {
      const done = new Set(covered.get(object)?.keys)
      return [object, keys.filter((key) => !done.has(key))] as const
    })
  )
  const merged = mergeIncluded(
    covered,
    await readIncluded(source, steps, rest, keysPerRequest)
  )
  return new Map(
    [...merged].map(([object, { keys, rows }]) => {
      const want = new Set(wanted.get(object))
      return [object, { keys: keys.filter((key) => want.has(key)), rows }]
    })
  )
}

/**
 * Reads the target keys of every step through `readKeys` — every object in
 * parallel, the source limiter bounds the reads in flight. `known` — the
 * `known` of a read of the keys of a target (§6.7, held targets of a system
 * re-read).
 */
export async function readIncluded(
  source: BoundSource,
  steps: readonly IncludeStep[],
  wanted: ReadonlyMap<ObjectName, readonly Key[]>,
  keysPerRequest: number,
  known?: (object: ObjectName) => ReadKeysOptions["known"]
): Promise<Included> {
  const entries = new Map(steps.map((s) => [s.target, s.entry]))
  const results = await Promise.all(
    [...wanted].map(
      async ([object, keys]): Promise<
        readonly [
          ObjectName,
          { keys: readonly Key[]; rows: readonly ServerRow[] },
        ]
      > => {
        if (keys.length === 0) return [object, { keys, rows: [] }] as const
        try {
          const rows = await readKeys(source, entries.get(object)!, keys, {
            keysPerRequest,
            ...(known === undefined ? {} : { known: known(object) }),
          })
          return [object, { keys, rows }] as const
        } catch (error) {
          // Ціль несумісна (`stale-client`, §10): її значень немає й не буде, а
          // вигляд власника лишається живим. Без ключів ціль не «зникає»:
          // відсутні ключі стали б `removed`.
          if (
            error instanceof CommandFailure &&
            error.error.code === "command.stale-client"
          )
            return [object, { keys: [], rows: [] }] as const
          throw error
        }
      }
    )
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
