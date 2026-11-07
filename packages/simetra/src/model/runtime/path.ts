import type { CatalogEntry, CatalogEntryAttribute } from "./catalog"
import type { CatalogIndex } from "./mapping"

/**
 * `path` помилки між логічною формою і формою передачі (спека П4-B §4.0).
 * Граматика — форми, які видають `server/values.ts`, `server/errors.ts`,
 * `server/read.ts` і `ctx.reject`; сегменти через крапку:
 *
 * - ТЧ: `<ТЧ>[.<i>][.<реквізит | keyName ТЧ>[.<j>]]` ↔
 *   `<id ТЧ>[.<i>][.<колонка>[.<j>]]`; сегмент лише з цифр — індекс;
 * - `creatorMember[.<реквізит | keyName>]` — записом довідника членства;
 * - `<реквізит шапки>[.<i>]`, `keyName`, `versionName` ↔ колонка;
 * - решта (структурні слова, довільний шлях застосунку) — без змін.
 *
 * Перший сегмент шукається спершу серед ТЧ, далі `creatorMember`, далі серед
 * реквізитів, ключа й версії: імена ТЧ і реквізитів — один простір імен
 * об'єкта (`identity.name-duplicate`), тож збіг однозначний, а ім'я каталогу
 * виграє в структурного слова. Пошук — лише перебором масивів каталогу, тож
 * `__proto__` чи `constructor` не збігаються ні з чим і лишаються як є.
 */

/** Сегмент — індекс масиву: ні ім'я, ні колонка не складаються лише з цифр. */
const INDEX = /^\d+$/

const MEMBER = "creatorMember"

type Direction = "toWire" | "fromWire"

/** Одне ім'я ↔ одна колонка; пара — за колонкою id (`attributes` помилки). */
type Field = { name: string; column: string }

const attributeFields = (attributes: readonly CatalogEntryAttribute[]) =>
  attributes.map((a): Field => ({ name: a.name, column: a.column }))

function headerFields(entry: CatalogEntry): Field[] {
  return [
    { name: entry.keyName, column: entry.key },
    { name: entry.versionName, column: entry.versionColumn },
    ...attributeFields(entry.attributes),
  ]
}

function mapField(
  fields: readonly Field[],
  segment: string,
  direction: Direction
): string | undefined {
  return direction === "toWire"
    ? fields.find((f) => f.name === segment)?.column
    : fields.find((f) => f.column === segment)?.name
}

function mapPath(
  index: CatalogIndex,
  objectId: string,
  path: string,
  direction: Direction
): string {
  const entry = index.byId.get(objectId)
  if (entry === undefined) return path
  const [head = "", ...rest] = path.split(".")
  const toWire = direction === "toWire"

  const section = entry.tabularSections.find((s) =>
    toWire ? s.name === head : s.id === head
  )
  if (section !== undefined) {
    const fields: Field[] = [
      { name: section.keyName, column: section.key },
      ...attributeFields(section.attributes),
    ]
    // Ім'я — одразу після ТЧ (`tablesOf` помилок) чи після індексу рядка.
    const at = rest[0] !== undefined && INDEX.test(rest[0]) ? 1 : 0
    const tail = [...rest]
    const name = tail[at]
    if (name !== undefined) {
      tail[at] = mapField(fields, name, direction) ?? name
    }
    return [toWire ? section.id : section.name, ...tail].join(".")
  }

  if (head === MEMBER && entry.creatorMembership !== undefined) {
    const membership = index.byId.get(entry.creatorMembership)
    const [name, ...tail] = rest
    if (membership === undefined || name === undefined) return path
    const mapped = mapField(headerFields(membership), name, direction) ?? name
    return [MEMBER, mapped, ...tail].join(".")
  }

  const mapped = mapField(headerFields(entry), head, direction)
  return mapped === undefined ? path : [mapped, ...rest].join(".")
}

/**
 * Maps a logical error path of the object `objectId` to its wire form:
 * sections become section ids, attributes, the key and the version become
 * physical columns, `creatorMember.<name>` maps through the membership
 * catalog. Structural segments and unknown names pass unchanged, so a path
 * is never lost.
 */
export function pathToWire(
  index: CatalogIndex,
  objectId: string,
  path: string
): string {
  return mapPath(index, objectId, path, "toWire")
}

/** The inverse of {@link pathToWire}. */
export function pathFromWire(
  index: CatalogIndex,
  objectId: string,
  path: string
): string {
  return mapPath(index, objectId, path, "fromWire")
}
