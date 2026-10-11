import { describe, expect, it } from "vitest"
import { compile, type CompiledModel } from "simetra/compiler"
import { KIND_REGISTRY, METADATA_KINDS } from "simetra/model"
import { kitchenSink } from "./fixtures/kitchen-sink"

/**
 * Інваріант пари для кожного виду реєстру: посилання з `pair: true` (шар
 * ідентичності) і пара `_type`/`_id` фізичної моделі — один факт. Тест не
 * знає ролей: носія пари він бачить за формою місця, а фізичну пару — за
 * сусідством колонок, тож новий вид чи поле, де шари розійшлися, тут
 * червоніє в будь-який бік.
 */

/** Носії пар одного об'єкта: id елементів і число стандартних колонок-пар. */
interface Carriers {
  elements: string[]
  standard: number
}

const empty = (): Carriers => ({ elements: [], standard: 0 })

function normalize(map: Map<string, Carriers>): Record<string, Carriers> {
  return Object.fromEntries(
    [...map]
      .map(([key, value]): [string, Carriers] => [
        key,
        { elements: [...value.elements].sort(), standard: value.standard },
      ])
      .sort(([a], [b]) => a.localeCompare(b))
  )
}

/** Значення за JSON Pointer без екранування: фікстура його не потребує. */
function at(value: unknown, pointer: string): unknown {
  if (pointer === "") return value
  return pointer
    .slice(1)
    .split("/")
    .reduce<unknown>(
      (current, segment) =>
        typeof current === "object" && current !== null
          ? (current as Record<string, unknown>)[segment]
          : undefined,
      value
    )
}

/**
 * Пари з боку ідентичності. Перелік цілей у елементі — пара елемента; на
 * корені об'єкта — пара стандартної колонки, по одній на поле-перелік.
 */
function identityPairs(model: CompiledModel): Map<string, Carriers> {
  const found = new Map<string, Carriers>()
  for (const object of model.objects) {
    const elements = new Set<string>()
    const standard = new Set<string>()
    for (const { pointer, pair } of KIND_REGISTRY[object.kind].references(
      object.data
    )) {
      if (!pair) continue
      const carrier = pointer.split("/").slice(0, -2).join("/")
      if (carrier === "") {
        standard.add(pointer.split("/")[1]!)
      } else {
        elements.add((at(object.data, carrier) as { id: string }).id)
      }
    }
    if (elements.size + standard.size > 0) {
      found.set(object.id!, {
        elements: [...elements],
        standard: standard.size,
      })
    }
  }
  return found
}

/**
 * Пари з боку фізики: `<основа>_type` поруч з `<основа>_id` того самого
 * походження. Похідні таблиці регістра повторюють пару виміру, тож носій
 * рахується один раз.
 */
function physicalPairs(model: CompiledModel): Map<string, Carriers> {
  const found = new Map<string, Carriers>()
  const standardSeen = new Set<string>()
  for (const table of model.physical.tables) {
    for (const column of table.columns) {
      if (!column.name.endsWith("_type")) continue
      const base = column.name.slice(0, -"_type".length)
      const sibling = table.columns.find(
        (c) =>
          c.name === `${base}_id` &&
          c.origin.elementId === column.origin.elementId &&
          c.origin.standard === column.origin.standard
      )
      if (sibling === undefined) continue
      const objectId = table.origin.objectId ?? "(no object)"
      const carriers = found.get(objectId) ?? empty()
      found.set(objectId, carriers)
      if (column.origin.elementId !== undefined) {
        if (!carriers.elements.includes(column.origin.elementId)) {
          carriers.elements.push(column.origin.elementId)
        }
      } else {
        const key = `${objectId}:${column.origin.standard}`
        if (!standardSeen.has(key)) {
          standardSeen.add(key)
          carriers.standard += 1
        }
      }
    }
  }
  return found
}

async function compiled(files: Map<string, string>): Promise<CompiledModel> {
  const result = await compile(files)
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
  return result.model!
}

/** Kitchen-sink, де довідник `Item` має кількох власників — пару `owner`. */
function manyOwners(): Map<string, string> {
  const files = kitchenSink()
  const path = "catalogs/Item/Item.meta.json"
  const item = JSON.parse(files.get(path)!) as Record<string, unknown>
  item.owners = [
    { kind: "Catalog", name: "Partner" },
    { kind: "Catalog", name: "Item" },
  ]
  files.set(path, JSON.stringify(item))
  return files
}

describe("polymorphic pair invariant", () => {
  it("the kitchen sink covers every kind of the registry", async () => {
    const model = await compiled(kitchenSink())
    const kinds = new Set(model.objects.map((o) => o.kind))
    expect(METADATA_KINDS.filter((kind) => !kinds.has(kind))).toEqual([])
  })

  it.each([
    ["kitchen sink (one owner, no owner pair)", kitchenSink],
    ["many owners (owner pair)", manyOwners],
  ])(
    "every reference pair has a physical pair and back: %s",
    async (_, files) => {
      const model = await compiled(files())
      const identity = identityPairs(model)
      // Не порожній інваріант: обидві форми носія присутні.
      const all = [...identity.values()]
      expect(all.some((c) => c.elements.length > 0)).toBe(true)
      expect(all.some((c) => c.standard > 0)).toBe(true)
      expect(normalize(identity)).toEqual(normalize(physicalPairs(model)))
    }
  )

  it("many owners add the owner pair, one owner does not", async () => {
    const itemId = (model: CompiledModel) =>
      model.objects.find((o) => o.kind === "Catalog" && o.name === "Item")!.id!
    const one = await compiled(kitchenSink())
    const many = await compiled(manyOwners())
    expect(identityPairs(one).get(itemId(one))?.standard ?? 0).toBe(0)
    expect(identityPairs(many).get(itemId(many))?.standard).toBe(1)
  })
})
