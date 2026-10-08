import { z } from "zod"
import { publicReadSchema } from "./public-read"
import { localizedStringSchema } from "./localized-string"
import { catalogAttributeSchema } from "./attribute"
import { compositeIndexesSchema } from "./composite-index"
import { tabularSectionSchema } from "./tabular-section"
import {
  metadataIdSchema,
  objectNameSchema,
  physicalNameSchema,
} from "./identity"
import { metadataRefSchema } from "./metadata-ref"
import {
  objectHeaderShape,
  standardAttributeOverridesSchema,
} from "./object-header"

/** Довідник. */
export const catalogSchema = z.strictObject({
  ...objectHeaderShape,
  kind: z
    .literal("Catalog")
    .meta({ description: "Metadata kind; always Catalog." }),
  // Мітка виду — дискримінатор поліморфних пар і ідентифікатор об'єкта в
  // контракті прав; призначається раз, тож перейменування її не змінює.
  kindLabel: physicalNameSchema.optional().meta({
    description:
      "Physical kind label of the object. Assigned once at creation and never changed, so a rename keeps it.",
  }),

  // Роль, а не ім'я, позначає системний довідник: платформний шар (провізія,
  // поточний користувач, авторство) знаходить «Користувачів» за нею, тож
  // перейменування довідника шар не ламає.
  role: z.literal("users").optional().meta({
    description:
      "System role of the catalog: users marks the users catalog that the platform layer provisions and references; at most one per project, unscoped.",
  }),

  // Нуль означає, що реквізиту (коду чи найменування) в довідника немає.
  codeLength: z.number().int().nonnegative().default(9).meta({
    description:
      "Length of the code attribute; 0 means the catalog has no code.",
  }),
  codeType: z
    .enum(["String", "Number"])
    .default("String")
    .meta({ description: "Value type of the code attribute." }),
  descriptionLength: z.number().int().nonnegative().default(150).meta({
    description:
      "Length of the description attribute; 0 means the catalog has no description.",
  }),
  hierarchyType: z
    .enum(["None", "FoldersAndItems", "ItemsOnly"])
    .default("None")
    .meta({
      description:
        "Hierarchy mode: none, folders and items, or items nested under items.",
    }),
  owners: z.array(metadataRefSchema).default([]).meta({
    description: "Objects that own items of this catalog (subordination).",
  }),
  autonumber: z
    .boolean()
    .default(true)
    .meta({ description: "Whether the code is generated automatically." }),
  codeUnique: z
    .boolean()
    .default(true)
    .meta({ description: "Whether the code must be unique." }),
  mainPresentation: z
    .enum(["Code", "Description"])
    .default("Description")
    .meta({
      description:
        "Which standard attribute represents an item in lists and references.",
    }),
  predefinedItems: z
    .array(
      z.strictObject({
        // Як у attributeSchema: обов'язковість id і physicalName дає стадія 2.
        id: metadataIdSchema.optional(),
        name: objectNameSchema.meta({
          description: "Logical name of the predefined item.",
        }),
        // Мітка — значення `predefined_name` рядка; як мітка значення
        // перерахування, призначається раз і не змінюється при перейменуванні.
        physicalName: physicalNameSchema.optional().meta({
          description:
            "Physical label of the item stored in predefined_name. Assigned once at creation and never changed, so a rename keeps it.",
        }),
        description: localizedStringSchema.optional().meta({
          description: "Description of the predefined item.",
        }),
      })
    )
    .default([])
    .meta({
      description:
        "Items that exist in every deployment and are referenced by name.",
    }),

  // Авторство посилається на «Користувачі», тож без довідника з роллю users
  // компілятор його відхиляє (`users.catalog-missing`).
  trackAuthor: z.boolean().default(false).meta({
    description:
      "Adds the standard createdBy and updatedBy attributes referencing the users catalog; requires a catalog with role users.",
  }),

  publicRead: publicReadSchema,

  standardAttributeOverrides: standardAttributeOverridesSchema,

  attributes: z
    .array(catalogAttributeSchema)
    .default([])
    .meta({ description: "Custom attributes of the catalog." }),
  tabularSections: z
    .array(tabularSectionSchema)
    .default([])
    .meta({ description: "Tabular sections of the catalog." }),
  indexes: compositeIndexesSchema.meta({
    description: "Composite indexes over the catalog attributes.",
  }),
})

export type Catalog = z.infer<typeof catalogSchema>
