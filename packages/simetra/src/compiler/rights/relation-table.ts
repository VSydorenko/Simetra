import {
  KIND_REGISTRY,
  isObjectTable,
  type ObjectTable,
  type PhysicalSnapshot,
} from "simetra/model"
import type { AccessDimensionContract } from "../contracts"
import type { ParsedObject } from "../stages/files"

type Relation = Extract<
  AccessDimensionContract["values"],
  { relation: unknown }
>["relation"]

/**
 * Таблиця зв'язку виміру, на яку платформа ставить тригери: основна таблиця
 * об'єкта виду без `declared` у `KIND_REGISTRY`. Прийнята `CustomTable`
 * (`declared`) тригерів не має (спека прав §4.7). Одна умова для запобіжника
 * зв'язку, тригера сигналу прав і `access[].fresh` каталогу: `fresh: true`
 * обіцяє клієнту сигнал прав, тож розійтися з генераторами вона не може.
 */
export function triggeredRelationTable(
  relation: Relation,
  physical: Pick<PhysicalSnapshot, "tables">,
  objects: readonly Pick<ParsedObject, "id" | "kind">[]
): ObjectTable | undefined {
  const table = physical.tables.find(
    (candidate): candidate is ObjectTable =>
      isObjectTable(candidate) &&
      candidate.schema === relation.table.schema &&
      candidate.name === relation.table.name &&
      candidate.origin.objectId === relation.objectId &&
      candidate.origin.part === undefined
  )
  if (
    table === undefined ||
    !objects.some(
      (object) =>
        object.id === relation.objectId && !KIND_REGISTRY[object.kind].declared
    )
  )
    return undefined
  return table
}
