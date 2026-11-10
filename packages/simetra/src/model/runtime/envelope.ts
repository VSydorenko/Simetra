import { z } from "zod"
import { elementIdSchema } from "../schemas/element-id"
import { kernelHashSchema } from "./catalog"
import { COMMAND_ERROR_CODES, LIMIT_REASONS } from "./errors"
import {
  BATCH_MAX,
  lengthLimited,
  OBJECT_OPERATIONS,
  operationSchema,
  updateOperationObjectSchema,
} from "./operation"
import {
  knownFormAllowed,
  knownSchema,
  queryFormSchema,
  READ_BATCH_MAX,
  readQuerySchema,
  TABULAR_LINES_MAX,
  versionEpochSchema,
} from "./read"
import { INTEGER_TEXT, isPlainObject } from "./values"

/**
 * Схеми форми передачі (спека П4-B §4.0): та сама операція, помилка й зміна,
 * що й у логічній формі, але об'єкт — UUID, ТЧ — id елемента, а імена —
 * фізичні колонки. Імена в даних перевіряє мапінг за каталогом, а не схема:
 * схема знає лише форму. Конверт — B1b-2.
 */

const wireObjectSchema = z.guid()

// Рядок ТЧ — фізичні колонки; ключ запису ТЧ — її id (рішення В4, В12), бо
// ім'я ТЧ змінює перейменування.
// Межу рядків ставить `lengthLimited`, як і в логічній формі: шлях відмови —
// `<id ТЧ>` (обробник прибирає префікс), причина — `tabular-too-large`.
const wireTabularSectionsSchema = z.record(
  elementIdSchema,
  lengthLimited(
    z.array(z.record(z.string(), z.unknown())),
    TABULAR_LINES_MAX,
    LIMIT_REASONS.tabularTooLarge
  )
)

// Варіанти беруться з логічної схеми, щоб дві форми не розійшлися полями:
// змінюються лише `object` і ключі ТЧ. `update` — без уточнення й без
// `deleteIds`: форма передачі шле повні масиви ТЧ (фасад, `fullTabularArrays`),
// а схему з уточненням Zod 4 розширити не дає.
const [createSchema, , markDeletionSchema, deleteSchema] =
  operationSchema.options

/** One operation of a command in wire form: object by UUID, physical columns. */
export const wireOperationSchema = z.discriminatedUnion("action", [
  createSchema.extend({
    object: wireObjectSchema,
    tabularSections: wireTabularSectionsSchema.optional(),
  }),
  updateOperationObjectSchema.omit({ deleteIds: true }).extend({
    object: wireObjectSchema,
    tabularSections: wireTabularSectionsSchema.optional(),
  }),
  markDeletionSchema.extend({ object: wireObjectSchema }),
  deleteSchema.extend({ object: wireObjectSchema }),
])

export type WireOperation = z.infer<typeof wireOperationSchema>

/**
 * A command error in wire form: `object` by UUID; `path` and `attributes`
 * physical (`<column>` of the header, `<section id>.<column>` of a section,
 * a pair by its id column).
 */
export const wireCommandErrorSchema = z.strictObject({
  code: z.enum(COMMAND_ERROR_CODES),
  reason: z.string().optional(),
  object: wireObjectSchema.optional(),
  operation: z.enum(OBJECT_OPERATIONS).optional(),
  path: z.string().optional(),
  detail: z.string().optional(),
  currentVersion: z.int().optional(),
  kind: z.enum(["notNull", "unique", "check"]).optional(),
  attributes: z.array(z.string()).optional(),
  hashes: z
    .strictObject({ catalog: z.string(), applied: z.string().nullable() })
    .optional(),
  role: z.string().optional(),
})

export type WireCommandError = z.infer<typeof wireCommandErrorSchema>

/** One changed row in wire form: object by UUID. */
export const wireChangeSchema = z.strictObject({
  object: wireObjectSchema,
  scopeKind: z.string().optional(),
  scope: z.string().optional(),
  id: z.string(),
  version: z.int(),
  operation: z.enum(OBJECT_OPERATIONS),
})

export type WireChange = z.infer<typeof wireChangeSchema>

// Форми беруться з логічної схеми, як і варіанти операції: змінюються лише
// `object` і поля ТЧ, а імена у фільтрі, сортуванні й `include` — ті самі
// рядки, тепер фізичні колонки.
const [card, list, count, ownerLines, sectionList, sectionCount] =
  readQuerySchema.out.options

// Повтор id тут не перевіряється: після мапінгу його відхиляє логічна схема
// зі шляхом на дублі.
const wireSectionIdsSchema = z.array(elementIdSchema).min(1)

/**
 * A read query in wire form: the logical forms with the object by UUID,
 * physical columns in `where`, `orderBy` and `include`, and section ids in
 * `tabularSection` and `tabularSections`. A list and a card without
 * `tabularSections` and `include` may carry `known` (a conditional read);
 * any other form with `known` is refused with `reason: "known-form"`.
 */
// Форму з `known` перевіряє препроцесор до розбору форми: суворий об'єкт
// інших форм відхилив би `known` як зайвий ключ без причини, а
// `queryFormSchema` переносить лише шлях і текст відмови форми.
export const wireReadQuerySchema = z.preprocess(
  (value, ctx) => {
    if (
      isPlainObject(value) &&
      Object.hasOwn(value, "known") &&
      !knownFormAllowed(value)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["known"],
        message:
          "known is allowed only on a list or a card without tabularSections and include",
        params: { reason: "known-form" },
      })
    }
    return value
  },
  queryFormSchema([
    card.extend({
      object: wireObjectSchema,
      tabularSections: z
        .union([z.literal(true), wireSectionIdsSchema])
        .optional(),
      known: knownSchema.optional(),
    }),
    list.extend({ object: wireObjectSchema, known: knownSchema.optional() }),
    count.extend({ object: wireObjectSchema }),
    ownerLines.extend({
      object: wireObjectSchema,
      tabularSection: elementIdSchema,
    }),
    sectionList.extend({
      object: wireObjectSchema,
      tabularSection: elementIdSchema,
    }),
    sectionCount.extend({
      object: wireObjectSchema,
      tabularSection: elementIdSchema,
    }),
  ])
)

export type WireReadQuery = z.infer<typeof wireReadQuerySchema>

const wireRowSchema = z.record(z.string(), z.unknown())

/**
 * A read result in wire form: rows keyed by physical columns (or markers
 * of rows the client holds, see `readResultFromWire`), `included` keyed by
 * the target object's UUID, `ownerVersion` as integer text (a version, like
 * the version column); or a count.
 */
export const wireReadResultSchema = z.union([
  z.strictObject({
    // Рядок, маркер незмінного рядка (позиція в `known`) чи частковий
    // маркер `{ $known, <колонки copy> }`. Частковий маркер від рядка
    // відрізняє відсутність колонки ключа, а її знає лише каталог, тож
    // об'єкт тут — будь-який; індекс `$known` перевіряє декодер.
    rows: z.array(z.union([z.int().min(0), wireRowSchema])),
    included: z.record(wireObjectSchema, z.array(wireRowSchema)).optional(),
    ownerVersion: z.string().regex(INTEGER_TEXT).optional(),
    // Сторінку обрізано за бюджетом відповіді: є ще рядки. Що `more` буває
    // лише на сторінці, тримає обробник, а не схема.
    more: z.literal(true).optional(),
  }),
  z.strictObject({
    count: z.int().min(0),
    capped: z.literal(true).optional(),
  }),
])

export type WireReadResult = z.infer<typeof wireReadResultSchema>

// Хеші ядер за UUID об'єкта: клієнт каже, з якими контрактами він збирав
// команду, і сервер відмовляє `stale-client`, якщо вони застаріли.
const kernelsSchema = z.record(wireObjectSchema, kernelHashSchema).optional()

// Рівно один з `operation`/`batch`: дві суворі гілки, тож обидва разом чи жодне
// відхиляє кожна гілка, а `z.infer` дає тип, де TypeScript вимагає рівно одне.
// Причину межі з вкладених помилок гілок бере `decidingIssue`. `type: "rights"`
// — B5.
const runRequestSchema = z.union([
  z.strictObject({
    type: z.literal("run"),
    operation: wireOperationSchema,
    // `never` лише для типу: без нього TypeScript пропустить обидва поля разом.
    batch: z.never().optional(),
    kernels: kernelsSchema,
  }),
  z.strictObject({
    type: z.literal("run"),
    operation: z.never().optional(),
    batch: lengthLimited(
      z.array(wireOperationSchema).min(1),
      BATCH_MAX,
      LIMIT_REASONS.batchTooLarge
    ),
    kernels: kernelsSchema,
  }),
])

/** The catalog version a `version` part returns. */
export const versionValueSchema = z.strictObject({
  snapshotHash: z.string(),
  objects: z.record(wireObjectSchema, kernelHashSchema),
})

export type VersionValue = z.infer<typeof versionValueSchema>

/**
 * One part of a `read` request: a read query (with `known`, where its form
 * allows) or the catalog version. `rights` comes with B5.
 */
export const wireReadPartSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("query"), query: wireReadQuerySchema }),
  z.strictObject({ type: z.literal("version") }),
])

export type WireReadPart = z.infer<typeof wireReadPartSchema>

/**
 * The value of a `read` request: the row version epoch of its transaction
 * (`null` without a transaction or an epoch) and an outcome per part, in
 * request order.
 */
export const wireReadPartsResultSchema = z.strictObject({
  epoch: versionEpochSchema.nullable(),
  items: z
    .array(
      z.union([
        z.strictObject({
          ok: z.literal(true),
          value: z.union([wireReadResultSchema, versionValueSchema]),
        }),
        z.strictObject({ ok: z.literal(false), error: wireCommandErrorSchema }),
      ])
    )
    .min(1)
    .max(READ_BATCH_MAX),
})

export type WireReadParts = z.infer<typeof wireReadPartsResultSchema>

/** A request to the data transport: the session subject and one request. */
// Частини конверт бере будь-якими: кожну перевіряє `wireReadPartSchema` в
// обробнику, тож хибна чи невідома частина відмовляє лише собі, а новіший
// клієнт на старішому сервері не перезавантажується. Межа — до розбору.
export const dataRequestSchema = z.strictObject({
  subject: z.string(),
  request: z.union([
    z.strictObject({
      type: z.literal("read"),
      items: lengthLimited(
        z.array(z.unknown()).min(1),
        READ_BATCH_MAX,
        LIMIT_REASONS.batchTooLarge
      ),
    }),
    runRequestSchema,
  ]),
})

export type DataRequest = z.infer<typeof dataRequestSchema>

/** A response of the data transport; `serverHash` is the server's catalog hash. */
export const dataResponseSchema = z.union([
  z.strictObject({
    ok: z.literal(true),
    value: z.unknown(),
    serverHash: z.string(),
  }),
  z.strictObject({
    ok: z.literal(false),
    error: wireCommandErrorSchema,
    serverHash: z.string(),
  }),
])

export type DataResponse = z.infer<typeof dataResponseSchema>
