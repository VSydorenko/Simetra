import { z } from "zod"
import {
  elementNameSchema,
  metadataKindSchema,
  objectNameSchema,
} from "simetra/model"

/**
 * Входи операцій (спека П2 §8.6: «ті самі Zod-входи» в API, CLI й MCP). Тут
 * лише поля самої операції: обгортки (MCP — `dryRun`, `confirm`) розширюють
 * ці схеми власними полями, тож схеми строгі — чуже поле не губиться мовчки.
 */

const PROJECT = "Project"

/** Ланцюжок логічних імен від об'єкта (рішення плану 3). */
const elementChain = z.array(elementNameSchema).meta({
  description:
    'Chain of logical element names from the object, e.g. ["services", "amount"] for an attribute of a tabular section.',
})

const objectTarget = z.strictObject({
  kind: metadataKindSchema,
  name: objectNameSchema,
  element: elementChain.optional(),
})

/**
 * Ціль перейменування, видалення й адресації: об'єкт або вкладений іменований
 * елемент. `Project` — лише корінь пошуку (видів скоупу), тож без `element`
 * ціллю він бути не може: корінь не перейменовують і не видаляють.
 */
export const elementTarget = z.union([
  objectTarget,
  z.strictObject({
    kind: z.literal(PROJECT),
    element: z.tuple([elementNameSchema], elementNameSchema),
  }),
])
export type ElementTarget = z.infer<typeof elementTarget>

/**
 * Контейнер, у колекцію якого додають елемент: об'єкт, вкладений елемент або
 * корінь проєкту (рішення архітектора R12 — новий вид скоупу додається в
 * колекцію кореня, якого `ElementTarget` навмисно не адресує).
 */
export const containerTarget = z.union([
  objectTarget,
  z.strictObject({ kind: z.literal(PROJECT) }),
])
export type ContainerTarget = z.infer<typeof containerTarget>

export const createObjectInput = z.strictObject({
  kind: metadataKindSchema,
  // Ім'я стає текою й файлом (`<тека виду>/<Name>/<Name>.meta.json`), тож
  // схема імені об'єкта заразом не пускає сегментів шляху.
  name: objectNameSchema,
  data: z.record(z.string(), z.unknown()).optional().meta({
    description:
      "Other fields of the new object file; id, physicalName and $schema are assigned by the operation.",
  }),
})
export type CreateObjectInput = z.infer<typeof createObjectInput>

export const addElementInput = z.strictObject({
  target: containerTarget,
  collection: z.string().min(1).meta({
    description:
      "Key of the array of named elements in the target, e.g. attributes, tabularSections, values, scopeKinds.",
  }),
  element: z.record(z.string(), z.unknown()).meta({
    description:
      "The new element; id and physicalName are assigned by the operation.",
  }),
})
export type AddElementInput = z.infer<typeof addElementInput>

export const renameInput = z.strictObject({
  target: elementTarget,
  // Ім'я об'єкта стає текою й файлом, тож схема заразом не пускає сегментів
  // шляху; стиль, унікальність і зарезервованість перевіряє компіляція
  // результату — ті самі правила стадії 2, що й для імені, набраного руками.
  newName: elementNameSchema.meta({
    description:
      "New logical name; ids and physical names never change, references to the element are rewritten.",
  }),
})
export type RenameInput = z.infer<typeof renameInput>
