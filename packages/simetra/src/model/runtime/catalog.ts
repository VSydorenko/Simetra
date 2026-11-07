import { z } from "zod"
import { elementIdSchema } from "../schemas/element-id"
import { metadataKindSchema } from "../schemas/metadata-kind"
import { metadataRefSchema } from "../schemas/metadata-ref"
import { DATABASE_PROVIDERS } from "../schemas/project"
import { LOGICAL_TYPES } from "../schemas/value-type"

/**
 * Base types a bound parameter is cast to. Без `character`: `$n::character`
 * — це `char(1)`, який мовчки обрізав би значення.
 */
export const CAST_TYPES = [
  "text",
  "uuid",
  "boolean",
  "smallint",
  "integer",
  "bigint",
  "numeric",
  "real",
  "double precision",
  "date",
  "timestamp with time zone",
  "timestamp without time zone",
  "time without time zone",
  "interval",
  "character varying",
  "bytea",
  "json",
  "jsonb",
] as const

// Тип приведення потрапляє в SQL без лапок, тож форма закрита: базовий тип
// з переліку, можливо масив.
const CAST_TYPE = new RegExp(`^(?:${CAST_TYPES.join("|")})(?:\\[\\])?$`)

export const castTypeSchema = z.string().regex(CAST_TYPE)

export const qualifiedNameSchema = z.strictObject({
  schema: z.string(),
  name: z.string(),
})

/**
 * An attribute of the shared catalog part: what both the runtime catalog and
 * the client catalog know about it (P4-B spec §3).
 */
export const catalogEntryAttributeSchema = z.strictObject({
  name: z.string(),
  column: z.string(),
  type: z.enum([...LOGICAL_TYPES, "Raw"]),
  array: z.literal(true).optional(),
  required: z.boolean(),
  maxLength: z.int().min(1).optional(),
  precision: z.int().min(1).optional(),
  scale: z.int().min(0).optional(),
  insert: z.boolean(),
  update: z.boolean(),
  generated: z.literal(true).optional(),
  /** Значення `Ref` на перерахування: логічне ім'я й мітка бази. */
  enumValues: z
    .array(z.strictObject({ name: z.string(), label: z.string() }))
    .optional(),
  pair: z
    .strictObject({
      typeColumn: z.string(),
      targets: z.array(
        z.strictObject({ object: metadataRefSchema, label: z.string() })
      ),
    })
    .optional(),
  /**
   * Ціль одноцільового `Ref` на об'єкт: id об'єкта моделі й ім'я FK, за яким
   * читання приєднує ціль (`include`). Перерахування, масив і пара FK не
   * мають, тож і `ref` теж.
   */
  ref: z
    .strictObject({ object: z.string(), constraint: z.string() })
    .optional(),
  /** Лише ефективно лінивий реквізит шапки (Рд25): списочне читання його не віддає. */
  load: z.literal("lazy").optional(),
  /**
   * The effective byte limit of a command input value (P4-B spec Рд26):
   * UTF-8 bytes of its JSON wire form; Text, Json, Bytes and arrays only.
   */
  maxBytes: z.int().positive().optional(),
})

/** A runtime attribute: the shared part plus the database types of T3. */
export const runtimeAttributeSchema = catalogEntryAttributeSchema.extend({
  /** Лише для `type` і декодування; у SQL не йде. */
  pgType: z.string(),
  castType: castTypeSchema,
})

export const runtimeConstraintSchema = z
  .strictObject({
    name: z.string(),
    kind: z.enum(["primaryKey", "unique", "check", "foreignKey"]),
    columns: z.array(z.string()),
    /** Колонки цілі FK у порядку `columns`; лише в `foreignKey`. */
    references: z.array(z.string()).optional(),
  })
  .refine(
    (c) =>
      c.references === undefined ||
      (c.kind === "foreignKey" && c.references.length === c.columns.length),
    {
      path: ["references"],
      message: "references belong to a foreign key, one per column",
    }
  )

/** A tabular section of the shared catalog part. */
export const catalogEntrySectionSchema = z.strictObject({
  /**
   * The section id as a model element: the UUID of a declared section or
   * the synthetic id of a standard one. The wire form names the section by it.
   */
  // Id, а не ім'я: ім'я змінюється перейменуванням, форма передачі — ні.
  id: elementIdSchema,
  name: z.string(),
  table: qualifiedNameSchema,
  key: z.string(),
  keyName: z.string(),
  parent: z.string(),
  parentName: z.string(),
  lineNumber: z.string(),
  lineNumberName: z.string(),
  /** FK рядка ТЧ на власника: за всіма його колонками ТЧ корелює з рядком власника. */
  parentConstraint: z.string(),
  attributes: z.array(catalogEntryAttributeSchema),
})

/** A runtime tabular section: the shared part plus its constraints. */
export const runtimeSectionSchema = catalogEntrySectionSchema
  .extend({
    attributes: z.array(runtimeAttributeSchema),
    constraints: z.array(runtimeConstraintSchema),
  })
  .refine(
    (section) =>
      section.constraints.some(
        (c) =>
          c.name === section.parentConstraint &&
          c.kind === "foreignKey" &&
          c.references !== undefined
      ),
    {
      path: ["parentConstraint"],
      message: "parentConstraint names no foreign key with references",
    }
  )

export const runtimeOperationTargetSchema = z.strictObject({
  function: qualifiedNameSchema,
  context: z.string(),
})

/**
 * `create` кореня виду скоупу (спека П4 §6.13): T3 генерує id і відхиляє `id` і
 * `tabularSections`; `membership` — id довідника членства каталогу, коли вид
 * має роль з `rootCreator`: тоді `creatorMember` дозволений.
 */
export const runtimeRootCreateSchema = z.strictObject({
  membership: z.string().optional(),
})

/** A catalog object of the shared catalog part. */
export const catalogEntrySchema = z.strictObject({
  id: z.guid(),
  name: z.string(),
  kind: metadataKindSchema,
  kindLabel: z.string(),
  table: qualifiedNameSchema,
  key: z.string(),
  keyName: z.string(),
  versionColumn: z.string(),
  versionName: z.string(),
  scopeKindId: z.string().optional(),
  scopeColumn: z.string().optional(),
  /**
   * The membership catalog of a scope root with a creator: `creatorMember`
   * maps through it (P4-B spec §3). Equals `operations.create.root.membership`.
   */
  creatorMembership: z.guid().optional(),
  /**
   * The kernel contract hash (P4-B spec Рд12): SHA-256 of the canonical form
   * of the entry's operations.
   */
  kernelHash: z.string().regex(/^[0-9a-f]{64}$/),
  /**
   * Whether the object takes a change signal (P4-B spec §8.3): a single
   * `uuid` key and no read boundary but the tenant one.
   */
  signal: z.boolean(),
  attributes: z.array(catalogEntryAttributeSchema),
  tabularSections: z.array(catalogEntrySectionSchema),
})

/**
 * A runtime catalog object: the shared part plus what only T3 needs —
 * constraints, command functions and membership facts.
 */
export const runtimeObjectSchema = catalogEntrySchema
  .extend({
    /**
     * Лише на довіднику членства: колонка користувача, яку разом із ключем і
     * скоупом примушує платформа (`creatorMember`, спека П4 §6.13).
     */
    membership: z.strictObject({ userColumn: z.string() }).optional(),
    attributes: z.array(runtimeAttributeSchema),
    tabularSections: z.array(runtimeSectionSchema),
    operations: z
      .strictObject({
        create: runtimeOperationTargetSchema
          .extend({ root: runtimeRootCreateSchema.optional() })
          .optional(),
        update: runtimeOperationTargetSchema.optional(),
        markDeletion: runtimeOperationTargetSchema.optional(),
        delete: runtimeOperationTargetSchema.optional(),
      })
      .optional(),
    constraints: z.array(runtimeConstraintSchema),
  })
  .superRefine((object, ctx) => {
    // Спільна частина несе довідник членства без `operations` (клієнтський
    // каталог), тож обидва факти мусять збігатися, інакше клієнт мапив би
    // `creatorMember` не тим довідником, що його перевіряє ядро.
    if (
      object.creatorMembership !== object.operations?.create?.root?.membership
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["creatorMembership"],
        message:
          "creatorMembership differs from operations.create.root.membership",
      })
    }
  })

/** The runtime catalog: a projection of the compiled model (P4 spec §6.3). */
export const runtimeCatalogSchema = z
  .strictObject({
    format: z.literal(1),
    snapshotHash: z.string(),
    provider: z.enum(DATABASE_PROVIDERS),
    objects: z.array(runtimeObjectSchema),
  })
  .superRefine((catalog, ctx) => {
    // Довідник членства кореня — об'єкт цього каталогу з фактами членства:
    // інакше T3 не мав би, за чим перевірити `creatorMember`.
    catalog.objects.forEach((object, index) => {
      const membership = object.operations?.create?.root?.membership
      if (membership === undefined) return
      const target = catalog.objects.find((o) => o.id === membership)
      if (
        target?.membership === undefined ||
        target.scopeColumn === undefined
      ) {
        ctx.addIssue({
          code: "custom",
          path: [
            "objects",
            index,
            "operations",
            "create",
            "root",
            "membership",
          ],
          message: "membership is not a membership catalog of this catalog",
        })
      }
    })
  })

/** A base cast type; `castTypeSchema` also accepts its array form. */
export type BaseCastType = (typeof CAST_TYPES)[number]
export type QualifiedName = z.infer<typeof qualifiedNameSchema>
export type CatalogEntryAttribute = z.infer<typeof catalogEntryAttributeSchema>
export type CatalogEntrySection = z.infer<typeof catalogEntrySectionSchema>
export type CatalogEntry = z.infer<typeof catalogEntrySchema>
export type RuntimeAttribute = z.infer<typeof runtimeAttributeSchema>
export type RuntimeConstraint = z.infer<typeof runtimeConstraintSchema>
export type RuntimeSection = z.infer<typeof runtimeSectionSchema>
export type RuntimeOperationTarget = z.infer<
  typeof runtimeOperationTargetSchema
>
export type RuntimeRootCreate = z.infer<typeof runtimeRootCreateSchema>
export type RuntimeObject = z.infer<typeof runtimeObjectSchema>
export type RuntimeCatalog = z.infer<typeof runtimeCatalogSchema>
