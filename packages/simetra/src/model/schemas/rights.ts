import { z } from "zod"
import { STANDARD_ACTIONS } from "../kinds/actions"
import { elementNameSchema, metadataIdSchema } from "./identity"
import { metadataRefSchema } from "./metadata-ref"
import { objectHeaderShape } from "./object-header"
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

/**
 * Рівень призначення (спека прав §4.1, §4.7): глобальний, вид скоупу чи
 * об'єкт-контейнер. Одна форма для ролі й джерела призначень, тож рівень
 * джерела порівнюється з рівнем ролі без перекладу.
 */
export const assignedOnSchema = z
  .union([
    z.literal("global"),
    z.strictObject({
      scopeKind: elementNameSchema.meta({
        description: "Name of the project scope kind of the level.",
      }),
    }),
    z.strictObject({
      container: metadataRefSchema.meta({
        description: "Rights container object of the level.",
      }),
    }),
  ])
  .meta({
    description:
      "Level of the assignment: global, a scope kind or a rights container.",
  })

export type AssignedOn = z.infer<typeof assignedOnSchema>

/**
 * Кон'юнкт умови рядків прийнятого джерела (спека прав §4.7, Р2d1-15):
 * рівність колонки літералу чи перевірка на `NULL`. Умова лише звужує рядки
 * джерела — рядок, що їй не відповідає, не належить джерелу (наприклад, рядок
 * іншого рівня поліморфної таблиці). Тип літерала звіряє з типом колонки
 * стадія 4.
 */
export const sourceConditionSchema = z
  .union([
    z.strictObject({
      column: elementNameSchema.meta({
        description: "Logical name of a column of the table.",
      }),
      equals: z.union([z.string(), z.boolean(), z.number().int()]).meta({
        description:
          "Literal the column must equal: a string for a text or uuid column, a boolean, or an integer.",
      }),
    }),
    z.strictObject({
      column: elementNameSchema.meta({
        description: "Logical name of a column of the table.",
      }),
      isNull: z.boolean().meta({
        description: "true: the column must be NULL; false: must not be NULL.",
      }),
    }),
  ])
  .meta({
    description:
      "Condition on a row of the table: a column equals a literal or is (not) NULL.",
  })

export type SourceCondition = z.infer<typeof sourceConditionSchema>

/** Умова рядків джерела: кон'юнкція; порожня — кожен рядок. */
const sourceWhereSchema = z.array(sourceConditionSchema).default([]).meta({
  description:
    "Conditions every row of the source must meet (a conjunction); rows that fail them are not part of the source.",
})

/**
 * Прийняте джерело членства (спека прав §4.7): `CustomTable`, чиї рядки
 * пов'язують користувача зі значенням виду скоупу. Колонки — логічні імена
 * колонок таблиці, тож перейменування колонки переписує мапінг.
 */
export const membershipSourceSchema = z.strictObject({
  // Як у виду скоупу: обов'язковість id дає стадія 2.
  id: metadataIdSchema.optional(),
  name: elementNameSchema.meta({
    description:
      "Logical name of the membership source, unique among all named elements of the project.",
  }),
  scopeKind: elementNameSchema.meta({
    description:
      "Name of the project scope kind whose membership the table holds.",
  }),
  table: metadataRefSchema.meta({
    description: "Adopted table (CustomTable) with the membership rows.",
  }),
  columns: z
    .strictObject({
      scope: elementNameSchema.meta({
        description: "Column with the scope value.",
      }),
      user: elementNameSchema.meta({
        description: "Column with the user id.",
      }),
      active: elementNameSchema.optional().meta({
        description: "Boolean column; only active rows count as membership.",
      }),
    })
    .meta({ description: "Logical names of the table columns." }),
  where: sourceWhereSchema,
})

export type MembershipSource = z.infer<typeof membershipSourceSchema>

/**
 * Прийняте джерело призначень (спека прав §4.7): `CustomTable`, чиї рядки
 * дають учаснику роль на одному рівні. Рівень — стала джерела (Р1a-16).
 */
export const assignmentSourceSchema = z.strictObject({
  id: metadataIdSchema.optional(),
  name: elementNameSchema.meta({
    description:
      "Logical name of the assignment source, unique among all named elements of the project.",
  }),
  assignedOn: assignedOnSchema,
  table: metadataRefSchema.meta({
    description: "Adopted table (CustomTable) with the assignment rows.",
  }),
  columns: z
    .strictObject({
      member: elementNameSchema.meta({
        description: "Column with the member (a user for the global level).",
      }),
      // Роль — ключ у колонці джерела або посилання на прийняту таблицю
      // ролей (Р2d1-17): ключ системної ролі споживач тоді тримає в таблиці
      // ролей, і `where` ролі відсікає кастомні ролі з тим самим ключем.
      role: z
        .union([
          elementNameSchema,
          z.strictObject({
            column: elementNameSchema.meta({
              description:
                "Column of the source table with the uuid reference to the role table.",
            }),
            references: metadataRefSchema.meta({
              description:
                "Adopted role table (CustomTable) with a single-column uuid key.",
            }),
            key: elementNameSchema.meta({
              description:
                "Column of the role table with the role key declared by a role in sourceKeys.",
            }),
            where: z.array(sourceConditionSchema).default([]).meta({
              description:
                "Conditions every row of the role table must meet (a conjunction); required unless the key column is unique on its own.",
            }),
          }),
        ])
        .meta({
          description:
            "Column with the role key declared by a role in sourceKeys, or a reference to an adopted role table with the key column.",
        }),
      // Три стани (Р2d1-19): колонка, `null` — скоуп з учасника, пропуск
      // — `scopeColumn` таблиці; без нього пропуск — помилка стадії 4.
      scope: elementNameSchema.nullable().optional().meta({
        description:
          "Scope level only: column with the scope of the row, which must equal the scope of the member; null takes the scope from the member; omitted means the scopeColumn of the table.",
      }),
      container: elementNameSchema.optional().meta({
        description:
          "Column with the container; required for the container level only.",
      }),
      active: elementNameSchema.optional().meta({
        description: "Boolean column; only active rows count as assignments.",
      }),
    })
    .meta({ description: "Logical names of the table columns." }),
  where: sourceWhereSchema,
})

export type AssignmentSource = z.infer<typeof assignmentSourceSchema>

/**
 * Рівень ролі (спека прав §4.1, Рх7): рівні джерела плюс «кожен дійсний
 * користувач» — без рядків призначень, тож джерелам ця форма не потрібна
 * (Р1b-3).
 */
export const roleAssignedOnSchema = z
  .union([
    assignedOnSchema,
    z.literal("everyUser").meta({
      description: "Every authenticated user, with no assignment rows.",
    }),
  ])
  .meta({
    description:
      "Level of the role: global, every user, a scope kind or a rights container.",
  })

export type RoleAssignedOn = z.infer<typeof roleAssignedOnSchema>

/**
 * Шапка декларацій прав: без PG-схеми, скоупу й фізичного імені — у базі
 * набір і роль живуть лише в згенерованій проєкції, а в даних їх називає
 * UUID (Р1b-9). `title`/`description` відкладено до плану зі споживачем
 * (Р1b-14).
 */
const rightsDeclarationHeader = z.object(objectHeaderShape).omit({
  schema: true,
  scope: true,
  physicalName: true,
  title: true,
  description: true,
}).shape

const includeSchema = z.array(metadataRefSchema).default([]).meta({
  description: "Rights sets whose grants this declaration includes.",
})

/**
 * Обсяг гранту (спека прав §3): усі рядки, власні рядки чи рядки зі значенням
 * виміру доступу користувача. Вимір названо іменем елемента проєкту, тож
 * перейменування виміру переписує грант.
 */
export const extentSchema = z
  .union([
    z.literal("any"),
    z.literal("own"),
    z.strictObject({
      dimension: elementNameSchema.meta({
        description: "Name of a project access dimension.",
      }),
    }),
  ])
  .meta({
    description:
      "Rows the grant opens: any row, own rows, or rows with a value of an access dimension of the user.",
  })

export type Extent = z.infer<typeof extentSchema>

/**
 * Об'єкти гранту (Р1b-6): явний перелік або «усі об'єкти рівня ролі, чиї
 * дії мають цю» — щоб роль не перелічувала кожен документ заради `post`.
 */
export const objectSelectorSchema = z
  .union([
    z.array(metadataRefSchema).min(1),
    z.strictObject({
      // Лише слово словника: кастомна дія в різних об'єктах — різні UUID
      // (Р1b-10), тож описка тут — помилка схеми, а не тихий порожній вибір.
      withAction: z
        .enum(
          STANDARD_ACTIONS.filter((action) => action !== "administerRights")
        )
        .meta({
          description:
            "Standard action word; selects every object of the role level that has it.",
        }),
    }),
  ])
  .meta({
    description:
      "Objects of the grant: a list, or every object of the role level with an action.",
  })

export type ObjectSelector = z.infer<typeof objectSelectorSchema>

const grantActionsSchema = z.array(elementNameSchema).min(1).meta({
  description:
    "Standard action words, or names of custom actions of the single object of the grant.",
})

const grantSchema = z
  .strictObject({
    objects: objectSelectorSchema,
    actions: grantActionsSchema,
    extent: extentSchema,
  })
  .meta({ description: "Grant the actions on the objects within the extent." })

const grantAllSchema = z.strictObject({ extent: extentSchema }).meta({
  description:
    "Grant every action the role level allows on every object of the level that supports the extent.",
})

const denySchema = z
  .strictObject({
    objects: objectSelectorSchema,
    actions: grantActionsSchema,
    extent: extentSchema.optional().meta({
      description:
        "Extent to remove; every extent of the actions when omitted.",
    }),
  })
  .meta({
    description:
      "Remove the actions from what the grants of the role and its sets give.",
  })

/** Запис гранту набору: без `deny` — віднімання належить ролі (Р1b-5). */
export const setGrantEntrySchema = z.union([
  z.strictObject({ grantAll: grantAllSchema }),
  z.strictObject({ grant: grantSchema }),
])

export type SetGrantEntry = z.infer<typeof setGrantEntrySchema>

/** Запис гранту ролі: `deny` віднімає з архетипу після розгортання (Р1b-5). */
export const grantEntrySchema = z.union([
  z.strictObject({ grantAll: grantAllSchema }),
  z.strictObject({ grant: grantSchema }),
  z.strictObject({ deny: denySchema }),
])

export type GrantEntry = z.infer<typeof grantEntrySchema>

/** Form of a grant entry (`grantAll`, `grant` or `deny`) and its body. */
export function grantEntryForm(entry: GrantEntry) {
  // Одне розрізнення форми для індексу посилань (T0) і компілятора (T1):
  // інакше нова форма запису розійшлася б у їхніх вказівниках.
  if ("grantAll" in entry) {
    return { form: "grantAll" as const, body: entry.grantAll }
  }
  if ("grant" in entry) return { form: "grant" as const, body: entry.grant }
  return { form: "deny" as const, body: entry.deny }
}

/**
 * Набір прав (спека прав §4.1, Рх16): іменована група грантів, яку
 * включають ролі й інші набори. Цикл включень — помилка компілятора.
 */
export const rightsSetSchema = z.strictObject({
  ...rightsDeclarationHeader,
  kind: z
    .literal("RightsSet")
    .meta({ description: "Metadata kind; always RightsSet." }),
  include: includeSchema,
  grants: z.array(setGrantEntrySchema).default([]).meta({
    description: "Grants of the set; a set has no level and cannot deny.",
  }),
})

export type RightsSet = z.infer<typeof rightsSetSchema>

/**
 * Роль (спека прав §4.1): рівень призначення, повні права, включені набори.
 * `assignedOn` призначається раз (Рх20); `sourceKeys` — ключі ролі в даних
 * прийнятих джерел призначень (§4.7).
 */
export const roleSchema = z.strictObject({
  ...rightsDeclarationHeader,
  kind: z.literal("Role").meta({ description: "Metadata kind; always Role." }),
  assignedOn: roleAssignedOnSchema,
  fullAccess: z.boolean().default(false).meta({
    description:
      "Bypass the rights checks on the objects of the role level; not on a container role or every user.",
  }),
  order: z.number().int().nonnegative().optional().meta({
    description: "Position of the role in the rights matrix.",
  }),
  assignable: z.boolean().default(true).meta({
    description:
      "Whether administrators assign the role; an owner role is handed over by its own command.",
  }),
  maxHolders: z.number().int().positive().optional().meta({
    description: "Most holders of the role on one level value.",
  }),
  rootCreator: z.boolean().default(false).meta({
    description:
      "Scope level only: the command that creates a scope root assigns this role to its creator.",
  }),
  sourceKeys: z
    .array(
      z.strictObject({
        source: elementNameSchema.meta({
          description: "Name of a project assignment source of the same level.",
        }),
        key: z.string().min(1).meta({
          description: "Role key in the role column of the source.",
        }),
      })
    )
    .default([])
    .meta({
      description: "Keys that name this role in adopted assignment sources.",
    }),
  include: includeSchema,
  grants: z.array(grantEntrySchema).default([]).meta({
    description:
      "Grants of the role; deny entries remove from what the grants and the included sets give.",
  }),
})

export type Role = z.infer<typeof roleSchema>
