import { z } from "zod"
import {
  elementNameSchema,
  objectNameSchema,
  physicalNameSchema,
} from "./identity"
import { localizedStringSchema } from "./localized-string"
import { metadataRefSchema } from "./metadata-ref"
import { objectHeaderShape } from "./object-header"
import type { SchemaRule } from "./rules"
import { LOGICAL_TYPES, refineValueType, valueTypeShape } from "./value-type"

const IDENTITY_TYPES: readonly string[] = ["SmallInt", "Integer", "BigInt"]

/**
 * Колонка описується рівно однією з трьох форм типу: логічний тип, посилання
 * на `PgEnum` або сирий PG-тип (`Raw` — єдине місце, де допустимий сирий тип).
 * Форму розрізняє `type`; поля всіх форм оголошені разом, щоб невалідна
 * комбінація давала правило `customTable.column-type` зі шляхом до
 * конкретного поля, а не загальну помилку об'єднання.
 */
export const customTableColumnSchema = z
  .strictObject({
    id: objectHeaderShape.id,
    name: elementNameSchema,
    physicalName: physicalNameSchema.optional(),
    title: localizedStringSchema.optional().meta({
      description: "Human-readable title of the column.",
    }),
    notNull: z
      .boolean()
      .default(false)
      .meta({ description: "Whether the column is NOT NULL." }),
    /** SQL-вираз значення за замовчуванням. */
    default: z.string().optional().meta({
      description: "SQL expression used as the column default.",
    }),
    identity: z.enum(["always", "byDefault"]).optional().meta({
      description:
        "Identity generation mode; requires SmallInt, Integer or BigInt type.",
    }),
    /**
     * `GENERATED ALWAYS AS (…) STORED`; вираз — у нормалізованій формі
     * Postgres (`pg_get_expr`). З `default` та `identity` несумісне — це
     * перевіряє стадія 4 (`customTable.generated-conflict`).
     */
    generated: z
      .strictObject({
        expression: z.string().min(1).meta({
          description: "SQL expression of the stored generated column.",
        }),
      })
      .optional()
      .meta({
        description:
          "Stored generated column; incompatible with default and identity.",
      }),
    collation: z.string().min(1).optional().meta({
      description:
        "Collation of the column; absent means the type default. Canonical spelling: the unquoted name as Postgres reports it in pg_collation, schema-qualified (schema.name) only when not in pg_catalog.",
    }),
    comment: z
      .string()
      .optional()
      .meta({ description: "Comment on the column." }),

    type: z.enum([...LOGICAL_TYPES, "PgEnum", "Raw"]).meta({
      description:
        "Logical type, PgEnum for an accepted enum, or Raw for a raw PostgreSQL type.",
    }),
    // FK колонок явні (`foreignKeys`), тож міжскоуповому прапорцю тут нема що
    // позначати: поля немає, і строга схема відкидає його як невідомий ключ.
    ...z.object(valueTypeShape).omit({ type: true, crossScope: true }).shape,
    enum: z
      .strictObject({
        kind: z.literal("PgEnum").meta({ description: "Always PgEnum." }),
        name: objectNameSchema.meta({
          description: "Logical name of the PgEnum object.",
        }),
      })
      .optional()
      .meta({ description: "Enum type of a PgEnum column." }),
    pgType: z.string().min(1).optional().meta({
      description: "Raw PostgreSQL type of a Raw column.",
    }),
  })
  .superRefine((column, ctx) => {
    const issue = (rule: SchemaRule, message: string, path: string[]) =>
      ctx.addIssue({ code: "custom", message, path, params: { rule } })

    const logicalFields = [
      "length",
      "precision",
      "scale",
      "ref",
      "allowedTypes",
    ] as const

    if (column.type === "PgEnum") {
      if (column.enum === undefined) {
        issue("customTable.column-type", "PgEnum column requires enum", [
          "enum",
        ])
      }
      if (column.pgType !== undefined) {
        issue("customTable.column-type", "PgEnum column cannot have pgType", [
          "pgType",
        ])
      }
      for (const field of logicalFields) {
        if (column[field] !== undefined) {
          issue(
            "customTable.column-type",
            `PgEnum column cannot have ${field}`,
            [field]
          )
        }
      }
    } else if (column.type === "Raw") {
      if (column.pgType === undefined) {
        issue("customTable.column-type", "Raw column requires pgType", [
          "pgType",
        ])
      }
      if (column.enum !== undefined) {
        issue("customTable.column-type", "Raw column cannot have enum", [
          "enum",
        ])
      }
      for (const field of [...logicalFields, "array"] as const) {
        if (column[field] !== undefined) {
          issue("customTable.column-type", `Raw column cannot have ${field}`, [
            field,
          ])
        }
      }
    } else {
      if (column.enum !== undefined) {
        issue(
          "customTable.column-type",
          "enum is only allowed for PgEnum columns",
          ["enum"]
        )
      }
      if (column.pgType !== undefined) {
        issue(
          "customTable.column-type",
          "pgType is only allowed for Raw columns",
          ["pgType"]
        )
      }
      refineValueType({ ...column, type: column.type }, ctx)
    }

    if (
      column.identity !== undefined &&
      !IDENTITY_TYPES.includes(column.type)
    ) {
      issue(
        "customTable.identity-type",
        "identity requires SmallInt, Integer or BigInt type",
        ["identity"]
      )
    }
  })

export type CustomTableColumn = z.infer<typeof customTableColumnSchema>

const constraintName = z.string().min(1).optional().meta({
  description:
    "Constraint name; when absent the PostgreSQL default name is used.",
})
const columnList = z.array(elementNameSchema).min(1).meta({
  description: "Logical names of columns of this table.",
})

/** `DEFERRABLE` / `INITIALLY DEFERRED` обмеження — спільне для FK, PK і UNIQUE. */
const deferrableSchema = z
  .enum(["no", "deferrable", "initiallyDeferred"])
  .default("no")
  .meta({ description: "Whether the constraint check can be deferred." })

export type Deferrable = z.infer<typeof deferrableSchema>

export const fkActionSchema = z
  .enum(["noAction", "restrict", "cascade", "setNull", "setDefault"])
  .meta({ description: "Referential action of a foreign key." })

export type FkAction = z.infer<typeof fkActionSchema>

/** `forced` — RLS діє і для власника таблиці (`FORCE ROW LEVEL SECURITY`). */
export const rowLevelSecuritySchema = z
  .enum(["off", "enabled", "forced"])
  .meta({
    description:
      "Row-level security of the table: off, enabled, or forced (applies to the table owner too).",
  })

export type RowLevelSecurity = z.infer<typeof rowLevelSecuritySchema>

const foreignKeySchema = z
  .strictObject({
    name: constraintName,
    columns: columnList,
    references: z
      .union([
        z.strictObject({
          object: metadataRefSchema.meta({
            description: "Referenced metadata object.",
          }),
          columns: columnList.meta({
            description: "Logical names of columns of the referenced object.",
          }),
        }),
        z.strictObject({
          external: z
            .strictObject({
              schema: z.string().min(1).meta({
                description: "PostgreSQL schema of the external table.",
              }),
              table: z.string().min(1).meta({
                description: "Physical name of the external table.",
              }),
              // Колонки зовнішньої таблиці — фізичні імена, не логічні.
              columns: z.array(z.string().min(1)).min(1).meta({
                description: "Physical column names of the external table.",
              }),
            })
            .meta({ description: "Referenced table outside the metadata." }),
        }),
      ])
      .meta({
        description:
          "Referenced target: a metadata object or an external table.",
      }),
    onDelete: fkActionSchema
      .default("noAction")
      .meta({ description: "Action on delete of the referenced row." }),
    onUpdate: fkActionSchema
      .default("noAction")
      .meta({ description: "Action on update of the referenced key." }),
    deferrable: deferrableSchema,
  })
  .meta({ description: "Foreign key of the table." })

/**
 * Параметри елемента ключа індексу — однакові для колонки й виразу. Відсутнє
 * поле — значення Postgres за замовчуванням (`ASC`, розташування `NULL` за
 * порядком, клас операторів і колляція типу); прийом пише лише те, що є в
 * `pg_index`.
 */
const indexKeyOptions = {
  order: z.enum(["asc", "desc"]).optional().meta({
    description: "Sort order of the key; absent means ascending.",
  }),
  nulls: z.enum(["first", "last"]).optional().meta({
    description: "NULLS FIRST or NULLS LAST; absent means the order default.",
  }),
  opclass: z.string().min(1).optional().meta({
    description:
      "Operator class of the key; absent means the type default. Canonical spelling: the unquoted name as Postgres reports it in pg_opclass, schema-qualified (schema.name) only when not in pg_catalog.",
  }),
  collation: z.string().min(1).optional().meta({
    description:
      "Collation of the key; absent means the column default. Canonical spelling: the unquoted name as Postgres reports it in pg_collation, schema-qualified (schema.name) only when not in pg_catalog.",
  }),
}

const indexSchema = z
  .strictObject({
    name: constraintName,
    unique: z
      .boolean()
      .default(false)
      .meta({ description: "Whether the index is unique." }),
    method: z.string().min(1).default("btree").meta({
      description: "Index access method.",
    }),
    keys: z
      .array(
        z.union([
          z.strictObject({
            column: elementNameSchema.meta({
              description: "Logical name of the indexed column.",
            }),
            ...indexKeyOptions,
          }),
          z.strictObject({
            expression: z
              .string()
              .min(1)
              .meta({ description: "SQL expression of the index key." }),
            ...indexKeyOptions,
          }),
        ])
      )
      .min(1)
      .meta({ description: "Index keys: columns or expressions." }),
    include: z.array(elementNameSchema).default([]).meta({
      description: "Logical names of non-key columns stored in the index.",
    }),
    where: z.string().optional().meta({
      description: "SQL predicate of a partial index.",
    }),
    nullsNotDistinct: z.boolean().default(false).meta({
      description: "Whether NULLs are treated as equal in a unique index.",
    }),
  })
  .meta({ description: "Index of the table." })

/**
 * Довільна таблиця з повним фізичним описом. Колонки в обмеженнях і індексах
 * — логічні імена; ім'я обмеження необов'язкове (відсутнє — ім'я за
 * алгоритмом Postgres), зворотний генератор записує імена явно.
 */
export const customTableSchema = z.strictObject({
  ...objectHeaderShape,
  kind: z
    .literal("CustomTable")
    .meta({ description: "Metadata kind; always CustomTable." }),
  comment: z.string().optional().meta({ description: "Comment on the table." }),
  columns: z
    .array(customTableColumnSchema)
    .min(1)
    .meta({ description: "Columns of the table." }),
  primaryKey: z
    .strictObject({
      name: constraintName,
      columns: columnList,
      deferrable: deferrableSchema,
    })
    .optional()
    .meta({ description: "Primary key of the table." }),
  uniques: z
    .array(
      z
        .strictObject({
          name: constraintName,
          columns: columnList,
          nullsNotDistinct: z.boolean().default(false).meta({
            description: "Whether NULLs are treated as equal.",
          }),
          deferrable: deferrableSchema,
        })
        .meta({ description: "Unique constraint." })
    )
    .default([])
    .meta({ description: "Unique constraints of the table." }),
  checks: z
    .array(
      z
        .strictObject({
          name: constraintName,
          expression: z
            .string()
            .min(1)
            .meta({ description: "SQL boolean expression of the check." }),
        })
        .meta({ description: "Check constraint." })
    )
    .default([])
    .meta({ description: "Check constraints of the table." }),
  foreignKeys: z
    .array(foreignKeySchema)
    .default([])
    .meta({ description: "Foreign keys of the table." }),
  indexes: z
    .array(indexSchema)
    .default([])
    .meta({ description: "Indexes of the table." }),
  /** Логічне ім'я власної колонки таблиці, що несе скоуп. */
  scopeColumn: elementNameSchema.optional().meta({
    description: "Logical name of the own column that carries the scope.",
  }),
  /**
   * RLS таблиці — властивість метаданих, а не `ALTER TABLE` у `.sql`: стан
   * таблиці описує одне місце. Прийнята таблиця за замовчуванням без RLS.
   */
  rowLevelSecurity: rowLevelSecuritySchema.default("off").meta({
    description:
      "Row-level security of the table: off, enabled, or forced (applies to the table owner too).",
  }),
})

export type CustomTable = z.infer<typeof customTableSchema>
