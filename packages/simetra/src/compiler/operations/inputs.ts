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
// Дискримінатор `kind`, а не `z.union`: так CLI і MCP отримують Zod-шлях аж до
// поля (`target.kind`), а не безликий `target`.
export const elementTarget = z.discriminatedUnion("kind", [
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
export const containerTarget = z.discriminatedUnion("kind", [
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
      "Other fields of the new object file; ids, physicalName and $schema are assigned by the operation, and an id anywhere in the input is refused.",
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
      "The new element; ids and physicalName are assigned by the operation, and an id anywhere in the input is refused.",
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

export const deleteInput = z.strictObject({
  target: elementTarget,
})
export type DeleteInput = z.infer<typeof deleteInput>

// Схеми імен у T0 несуть опис для `rename`/`add`; у вході `promote` вони
// повторюються понад десять разів, і кожен повтор лягає в `tools/list`. Ім'я
// поля тут уже каже, що це ім'я, а правило стилю — у відмові компіляції.
const promoteObjectName = objectNameSchema.meta({ description: undefined })
const promoteElementName = elementNameSchema.meta({ description: undefined })

/**
 * Клас конверсії прийнятого елемента, що не мапиться колонкою (спека
 * промоції §8, §9.1): клас іде в запис промоції, а сам елемент знімається з
 * файлів.
 */
export const conversionClass = z.enum([
  "platform",
  "property",
  "rowRule",
  "metadata",
  "applicationCode",
  "removed",
])
export type ConversionClass = z.infer<typeof conversionClass>

/**
 * Тіло нового реквізиту. Id і `physicalName` дає операція (рішення плану
 * 10: фізичні імена завжди канонічні), тож `physicalName` відхиляє схема, а
 * `id` — `refuseSuppliedId` з тим самим кодом, що в інших мутаціях.
 */
const promotedElement = z
  .record(z.string(), z.unknown())
  .refine((element) => promoteElementName.safeParse(element.name).success, {
    message: "The element needs a logical name",
    path: ["name"],
  })
  .refine((element) => !Object.hasOwn(element, "physicalName"), {
    message: "Physical names are assigned by the operation",
    path: ["physicalName"],
  })

/** Шлях до першого `physicalName` на будь-якій глибині значення. */
function physicalNamePath(
  value: unknown,
  path: (string | number)[]
): (string | number)[] | undefined {
  if (typeof value !== "object" || value === null) return undefined
  for (const [key, item] of Object.entries(value)) {
    const at = [...path, Array.isArray(value) ? Number(key) : key]
    if (key === "physicalName" && !Array.isArray(value)) return at
    const found = physicalNamePath(item, at)
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * Дані нового об'єкта чи ТЧ промоції. Фізичні імена призначає операція
 * (рішення 10), а `assigned` — поля, які дає прийнята таблиця чи сама
 * операція: ідентичність, схема, скоуп і мітка призначені раз (Пр18). Мовчки
 * відкинуте поле сховало б від автора, що його не застосовано.
 */
const promotedData = (assigned: readonly string[]) =>
  z
    .record(z.string(), z.unknown())
    .superRefine((data, ctx) => {
      for (const key of assigned) {
        if (Object.hasOwn(data, key)) {
          ctx.addIssue({
            code: "custom",
            message: `${key} is set by the promotion, not by the input`,
            path: [key],
          })
        }
      }
      const at = physicalNamePath(data, [])
      if (at !== undefined && !assigned.includes(String(at[0]))) {
        ctx.addIssue({
          code: "custom",
          message: "Physical names are assigned by the operation",
          path: at,
        })
      }
    })
    .optional()

/**
 * Куди йде одна колонка прийнятої таблиці (спека промоції §4): рівно одна
 * доля на колонку, без евристик — нерозміщена колонка є відмовою.
 */
const columnMapping = z
  .discriminatedUnion("to", [
    z.strictObject({
      to: z.literal("standard"),
      // Канонічне camelCase-ім'я незалежно від стилю проєкту (рішення 11).
      name: z.string().min(1),
    }),
    z.strictObject({ to: z.literal("scope") }),
    z.strictObject({
      to: z.literal("attribute"),
      collection: z
        .enum(["attributes", "dimensions", "resources"])
        .default("attributes"),
      element: promotedElement,
    }),
    z.strictObject({ to: z.literal("retire") }),
  ])
  .meta({
    description:
      "Where one column goes: a standard attribute of the kind, the scope carrier, an own attribute or retired.",
  })

// Ключ — логічне ім'я колонки прийнятої таблиці. Опис не тут: схема розгортається
// і в корені, і в кожній ТЧ, тож опис ліг би в `tools/list` двічі.
const columnMappings = z.record(promoteElementName, columnMapping)

const fillStep = z.strictObject({
  table: promoteObjectName.optional(),
  target: z.discriminatedUnion("to", [
    z.strictObject({
      to: z.literal("standard"),
      name: z.string().min(1),
    }),
    z.strictObject({
      to: z.literal("attribute"),
      name: promoteElementName,
    }),
  ]),
  expression: z.string().min(1).meta({
    description:
      "SQL expression in the old physical names; runs before the renames.",
  }),
})

export const promoteInput = z.strictObject({
  target: z.strictObject({ name: promoteObjectName }),
  into: z.strictObject({
    kind: z.enum(["Catalog", "Document", "InformationRegister"]),
    name: promoteObjectName,
    data: promotedData([
      "kind",
      "name",
      "physicalName",
      "schema",
      "scope",
      "kindLabel",
    ]),
  }),
  columns: columnMappings,
  tabularSections: z
    .array(
      z.strictObject({
        table: promoteObjectName,
        name: promoteElementName,
        data: promotedData(["name", "physicalName"]),
        columns: columnMappings,
      })
    )
    .default([]),
  fill: z.array(fillStep).default([]),
  // Ключ — ідентичність SQL-одиниці або "<CustomTable>#<collection>/<name|index>"
  // чи "<CustomTable>#default/<колонка>".
  conversions: z.record(z.string().min(1), conversionClass).default({}).meta({
    description:
      'Key: a SQL unit identity, "<CustomTable>#uniques|checks|indexes/<name or index>" or "<CustomTable>#default/<column>".',
  }),
  sharedFunctions: z.array(z.string().min(1)).default([]),
  consumerLabels: z.array(z.string().min(1)).default([]),
})
export type PromoteInput = z.infer<typeof promoteInput>
