import { z } from "zod"
import { elementNameSchema, metadataIdSchema } from "./identity"
import { metadataRefSchema } from "./metadata-ref"
import { appSchemaNameSchema } from "./pg-schema"

/**
 * Кастомна дія об'єкта (спека прав §3): елемент з `id` і `name`, але без
 * `physicalName` — у даних дію називає її UUID, а не ім'я. `dml` не
 * оголошується: компілятор виводить його з того, чи є що писати, тож
 * оголошення не може розійтися з ефектами. `title`/`description` відкладено
 * до плану зі споживачем (Р1a-23).
 */
export const customActionSchema = z.strictObject({
  // Як у реквізиту: обов'язковість id дає стадія 2.
  id: metadataIdSchema.optional(),
  name: elementNameSchema.meta({
    description:
      "Logical name of the custom action, camelCase like the standard action words; must not repeat a standard action of the kind.",
  }),
  requires: z.array(elementNameSchema).default([]).meta({
    description:
      "Actions a holder of this action must also hold: standard action words of the kind or names of custom actions of the same object.",
  }),
  effects: z
    .strictObject({
      header: z
        .union([z.literal("all"), z.array(elementNameSchema)])
        .optional()
        .meta({
          description:
            "Header columns the action writes: all, or logical names of attributes and standard attributes of the object.",
        }),
      tabularSections: z.boolean().optional().meta({
        description: "Whether the action writes the tabular section rows.",
      }),
    })
    .default({})
    .meta({
      description:
        "What the action writes itself; an action that writes anything is an update.",
    }),
})

export type CustomAction = z.infer<typeof customActionSchema>

/** Кастомні дії об'єкта — поле видів з контрактом прав. */
export const customActionsSchema = z
  .array(customActionSchema)
  .default([])
  .meta({
    description:
      "Custom actions of the object beyond the standard actions of its kind.",
  })

/**
 * Носій прав (Рх21): реквізит самого об'єкта або шлях з двох кроків —
 * посилання в межах скоупу й реквізит його цілі. Довших шляхів немає:
 * кожен крок — це з'єднання в політиці рядка, а один крок покриває
 * «коментар задачі належить виконавцю задачі».
 */
export const rightsCarrierSchema = z
  .union([elementNameSchema, z.tuple([elementNameSchema, elementNameSchema])])
  .meta({
    description:
      "An attribute of this object, or a path [attribute, attribute of its target]",
  })

export type RightsCarrier = z.infer<typeof rightsCarrierSchema>

/** Власники рядка (спека прав §4.2): порожній перелік — це відсутність поля. */
export const ownershipSchema = z.array(rightsCarrierSchema).min(1)

/**
 * Вимір доступу проєкту (спека прав §4.4): скоуплений довідник значень і
 * джерело значень користувача — таблиця зв'язку чи дослівна функція. Вимір —
 * елемент проєкту з UUID, бо обсяг гранту називає його id, а ім'я може
 * змінитися. `title`/`description` відкладено до плану зі споживачем (Р1a-23).
 */
export const accessDimensionSchema = z.strictObject({
  // Як у виду скоупу: обов'язковість id дає стадія 2.
  id: metadataIdSchema.optional(),
  name: elementNameSchema.meta({
    description:
      "Logical name of the access dimension, unique among all named elements of the project.",
  }),
  target: metadataRefSchema.meta({
    description:
      "Catalog of the dimension values; scoped when the project has scope kinds.",
  }),
  values: z
    .union([
      z.strictObject({
        relation: z
          .strictObject({
            object: metadataRefSchema.meta({
              description:
                "Object whose rows link a user or a member to a value of the dimension.",
            }),
            subject: elementNameSchema.meta({
              description:
                "Reference of the relation object to the users catalog or to the membership catalog.",
            }),
            value: elementNameSchema.meta({
              description:
                "Reference of the relation object to the target catalog.",
            }),
          })
          .meta({ description: "Values of a user read from a relation." }),
      }),
      z.strictObject({
        function: z
          .strictObject({
            schema: appSchemaNameSchema.min(1).optional().meta({
              description:
                "PostgreSQL schema of the function; the project default schema when omitted.",
            }),
            name: z.string().min(1).meta({
              description:
                "Name of a verbatim SQL function that returns the value ids of the current user.",
            }),
          })
          .meta({ description: "Values of a user returned by a function." }),
      }),
    ])
    .meta({ description: "Where the values of the current user come from." }),
})

export type AccessDimension = z.infer<typeof accessDimensionSchema>

/**
 * Мапінг об'єкта на вимір: реквізит або шлях з двох кроків (як носій прав,
 * Рх21), чий кінцевий `Ref` — на довідник значень виміру.
 */
export const accessMappingSchema = z.union([
  z.strictObject({
    attribute: elementNameSchema.meta({
      description:
        "Attribute of this object that references the dimension target.",
    }),
    dimension: elementNameSchema.meta({
      description: "Name of a project access dimension.",
    }),
  }),
  z.strictObject({
    ref: z.tuple([elementNameSchema, elementNameSchema]).meta({
      description:
        "Path [attribute, attribute of its target] whose last reference is to the dimension target.",
    }),
    dimension: elementNameSchema.meta({
      description: "Name of a project access dimension.",
    }),
  }),
])

export type AccessMapping = z.infer<typeof accessMappingSchema>

/** Мапінги `access` об'єкта: порожній перелік — це відсутність поля. */
export const accessSchema = z.array(accessMappingSchema).min(1).meta({
  description:
    "Access dimensions that restrict the rows of this object, each with its carrier.",
})
