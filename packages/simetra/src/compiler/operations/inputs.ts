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

/**
 * Клас конверсії прийнятого елемента, що не мапиться колонкою (спека
 * промоції §8, §9.1): клас іде в запис промоції, а сам елемент знімається з
 * файлів.
 */
export const conversionClass = z
  .enum([
    "platform",
    "property",
    "rowRule",
    "metadata",
    "applicationCode",
    "removed",
  ])
  .meta({
    description:
      "Conversion class of an adopted element that no column carries: platform, property, rowRule, metadata, applicationCode or removed.",
  })
export type ConversionClass = z.infer<typeof conversionClass>

/**
 * Тіло нового реквізиту. Id і `physicalName` дає операція (рішення плану
 * 10: фізичні імена завжди канонічні), тож `physicalName` відхиляє схема, а
 * `id` — `refuseSuppliedId` з тим самим кодом, що в інших мутаціях.
 */
const promotedElement = z
  .record(z.string(), z.unknown())
  .refine((element) => elementNameSchema.safeParse(element.name).success, {
    message: "The element needs a logical name",
    path: ["name"],
  })
  .refine((element) => !Object.hasOwn(element, "physicalName"), {
    message: "Physical names are assigned by the operation",
    path: ["physicalName"],
  })
  .meta({
    description:
      "The attribute the column becomes: name is required; the column's type, required flag, title and comment are carried over unless set here; no id or physicalName.",
  })

/**
 * Куди йде одна колонка прийнятої таблиці (спека промоції §4): рівно одна
 * доля на колонку, без евристик — нерозміщена колонка є відмовою.
 */
const columnMapping = z
  .discriminatedUnion("to", [
    z.strictObject({
      to: z.literal("standard"),
      // Канонічне camelCase-ім'я незалежно від стилю проєкту (рішення 11).
      name: z.string().min(1).meta({
        description:
          "Canonical camelCase name of the standard attribute of the kind (ref, description, deletionMark, parent, owner, number, date, …), whatever the project's attribute case.",
      }),
    }),
    z.strictObject({ to: z.literal("scope") }),
    z.strictObject({
      to: z.literal("attribute"),
      collection: z
        .enum(["attributes", "dimensions", "resources"])
        .default("attributes")
        .meta({
          description:
            "Collection of the kind the attribute goes to; dimensions and resources exist only in registers.",
        }),
      element: promotedElement,
    }),
    z.strictObject({ to: z.literal("retire") }),
  ])
  .meta({
    description:
      "Fate of one column: a standard attribute of the kind, the scope carrier, an own attribute, or retired explicitly.",
  })

// Ключ — логічне ім'я колонки прийнятої таблиці.
const columnMappings = z.record(elementNameSchema, columnMapping).meta({
  description:
    "Mapping of every column of the adopted table, keyed by the column's logical name.",
})

const fillStep = z
  .strictObject({
    table: objectNameSchema.optional().meta({
      description:
        "Adopted table of a tabular section the step fills; absent means the main table.",
    }),
    target: z.discriminatedUnion("to", [
      z.strictObject({
        to: z.literal("standard"),
        name: z.string().min(1).meta({
          description:
            "Canonical camelCase name of the standard attribute to fill.",
        }),
      }),
      z.strictObject({
        to: z.literal("attribute"),
        name: elementNameSchema.meta({
          description: "Logical name of the attribute to fill.",
        }),
      }),
    ]),
    expression: z.string().min(1).meta({
      description:
        "One scalar SQL expression over the columns of its own table, written in the old physical names; it runs before the renames.",
    }),
  })
  .meta({
    description:
      "Data step: computes a column of the kind from a row of the adopted table (conversion, split, backfill or repair).",
  })

export const promoteInput = z.strictObject({
  target: z.strictObject({
    name: objectNameSchema.meta({
      description: "Logical name of the adopted CustomTable to promote.",
    }),
  }),
  into: z.strictObject({
    kind: z
      .enum(["Catalog", "Document", "InformationRegister"])
      .meta({ description: "Kind the table is promoted into." }),
    name: objectNameSchema.meta({
      description: "Logical name of the new object.",
    }),
    data: z.record(z.string(), z.unknown()).optional().meta({
      description:
        "Settings and declarative properties of the kind (e.g. codeLength, descriptionLength); no ids or physical names.",
    }),
  }),
  columns: columnMappings,
  tabularSections: z
    .array(
      z.strictObject({
        table: objectNameSchema.meta({
          description:
            "Logical name of the adopted CustomTable that becomes the tabular section.",
        }),
        name: elementNameSchema.meta({
          description: "Logical name of the tabular section.",
        }),
        data: z.record(z.string(), z.unknown()).optional().meta({
          description: "Other fields of the tabular section; no ids.",
        }),
        columns: columnMappings,
      })
    )
    .default([])
    .meta({
      description:
        "Adopted tables promoted together as tabular sections of the new object.",
    }),
  fill: z.array(fillStep).default([]).meta({
    description:
      "Data steps for columns of the kind that no column carries as is.",
  }),
  // Ключ — ідентичність SQL-одиниці або "<CustomTable>#<collection>/<name|index>"
  // чи "<CustomTable>#default/<колонка>".
  conversions: z.record(z.string().min(1), conversionClass).default({}).meta({
    description:
      'Class of every adopted element that no column carries: a SQL unit identity, "<CustomTable>#uniques|checks|indexes/<name, or index when unnamed>" or "<CustomTable>#default/<column>".',
  }),
  sharedFunctions: z.array(z.string().min(1)).default([]).meta({
    description:
      "Identities of module functions that move to sql/<schema>/ instead of the kind module.",
  }),
  consumerLabels: z.array(z.string().min(1)).default([]).meta({
    description:
      "Values by which the consumer's data encodes this object; the promotion record carries their translation to the kind label.",
  }),
})
export type PromoteInput = z.infer<typeof promoteInput>
