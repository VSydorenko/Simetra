import { z } from "zod"

/** Separator of a synthetic element id: `<owner UUID>#<canonical name>`. */
export const ELEMENT_ID_SEPARATOR = "#"

/**
 * The synthetic id of a standard element (an attribute or a tabular
 * section): `<owner UUID>#<canonical name>`.
 */
// Стандартний елемент не має власного UUID, а індекс посилань і форма
// передачі мусять називати його так само, як оголошений. Канонічне ім'я, а
// не стильове: зміна стилю проєкту id не міняє.
export function standardElementId(
  ownerId: string,
  element: { logicalName: string }
): string {
  return `${ownerId}${ELEMENT_ID_SEPARATOR}${element.logicalName}`
}

const ownerIdSchema = z.guid()

/**
 * Parses a synthetic id built by {@link standardElementId}; `undefined` for a
 * declared element's UUID or a malformed id.
 */
// Розбір тим самим форматом, що будує `standardElementId`: рівно один
// роздільник, власник — UUID, ім'я непорожнє й без крапки (крапка ділить
// `path` форми передачі). Одне місце розбору — інакше кожен викликач тримав
// би власне уявлення про роздільник.
export function parseStandardElementId(
  id: string
): { ownerId: string; name: string } | undefined {
  const parts = id.split(ELEMENT_ID_SEPARATOR)
  if (parts.length !== 2) return undefined
  const [ownerId, name] = parts as [string, string]
  return ownerIdSchema.safeParse(ownerId).success &&
    name.length > 0 &&
    !name.includes(".")
    ? { ownerId, name }
    : undefined
}

const syntheticElementIdSchema = z
  .string()
  .refine((id) => parseStandardElementId(id) !== undefined, {
    message: "not a synthetic element id",
  })

/**
 * The id of a model element: the UUID of a declared element or the synthetic
 * id of a standard one (see {@link standardElementId}).
 */
export const elementIdSchema = z.union([z.guid(), syntheticElementIdSchema])
