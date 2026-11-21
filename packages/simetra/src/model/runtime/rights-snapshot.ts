import { z } from "zod"
import { versionEpochSchema } from "./read"

/**
 * Рядок `rights_mine()` у camelCase (P4-B spec §9.1). `level` і `extent` —
 * рядки без переліку: новий рівень чи обсяг не валить схему на клієнті.
 */
export const rightsRowSchema = z.strictObject({
  level: z.string(),
  levelId: z.guid().nullable(),
  scope: z.guid().nullable(),
  container: z.guid().nullable(),
  object: z.string(),
  action: z.string(),
  extent: z.string(),
  dimensionId: z.guid().nullable(),
})

export type RightsRow = z.infer<typeof rightsRowSchema>

/**
 * Скільки значень одного виміру несе знімок (P4-B spec §9.1). Знімок
 * повертається цілим на кожну зміну моїх фактів, тож його розмір має межу;
 * понад неї — перші за порядком, `truncated` і `digest`.
 */
export const RIGHTS_DIMENSION_VALUES_MAX = 1000

/** Рядок `rights_my_scopes()`: мій учасник `member` у скоупі `scope` виду. */
export const rightsMemberSchema = z.strictObject({
  scopeKind: z.string(),
  scope: z.guid(),
  member: z.guid(),
})

/**
 * Мої значення виміру (`rights_dimension_values`), упорядковані. Понад
 * `RIGHTS_DIMENSION_VALUES_MAX` — рівно межа перших значень, `truncated: true`
 * і `digest`: sha-256 (hex) повного впорядкованого набору, значення через
 * кому, тож зміна значення за межею змінює `rightsVersion`.
 */
export const rightsDimensionValuesSchema = z
  .strictObject({
    dimension: z.guid(),
    values: z.array(z.guid()).max(RIGHTS_DIMENSION_VALUES_MAX),
    truncated: z.literal(true).optional(),
    digest: versionEpochSchema.optional(),
  })
  .refine(
    (d) =>
      d.truncated === undefined
        ? d.digest === undefined
        : d.digest !== undefined &&
          d.values.length === RIGHTS_DIMENSION_VALUES_MAX,
    { message: "truncated carries a digest and exactly the cap of values" }
  )

export type RightsDimensionValues = z.infer<typeof rightsDimensionValuesSchema>

/**
 * Знімок прав поточного користувача (P4-B spec §9.1): лише його факти.
 * Анонім і недійсний користувач — усі масиви порожні, `userId: null`.
 */
export const rightsSnapshotSchema = z.strictObject({
  userId: z.guid().nullable(),
  scopeSets: z.array(
    z.strictObject({ scopeKind: z.string(), scope: z.guid() })
  ),
  rights: z.array(rightsRowSchema),
  members: z.array(rightsMemberSchema),
  dimensionValues: z.array(rightsDimensionValuesSchema),
})

export type RightsSnapshot = z.infer<typeof rightsSnapshotSchema>

/** `rightsVersion`: sha-256 канонічного JSON знімка, 64 hex. */
export const rightsVersionSchema = versionEpochSchema

/** The value of a `rights` part in wire form. */
export const rightsValueSchema = z.strictObject({
  rightsVersion: rightsVersionSchema,
  snapshot: rightsSnapshotSchema.optional(),
})

export type RightsValue = z.infer<typeof rightsValueSchema>

/**
 * Ім'я функції знімка в схемі `simetra` (P4-B spec §9.1): T1 її генерує, T3
 * кличе, а імпортує лише `simetra/model`.
 */
export const RIGHTS_CLIENT_SNAPSHOT_FUNCTION_NAME = "rights_client_snapshot"
