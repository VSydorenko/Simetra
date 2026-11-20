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
 * Знімок прав поточного користувача (P4-B spec §9.1): лише його факти.
 * Анонім і недійсний користувач — `{ userId: null, scopeSets: [], rights: [] }`.
 */
export const rightsSnapshotSchema = z.strictObject({
  userId: z.guid().nullable(),
  scopeSets: z.array(
    z.strictObject({ scopeKind: z.string(), scope: z.guid() })
  ),
  rights: z.array(rightsRowSchema),
})

export type RightsSnapshot = z.infer<typeof rightsSnapshotSchema>

/** `rightsVersion`: sha-256 канонічного JSON знімка, 64 hex. */
export const rightsVersionSchema = versionEpochSchema

/**
 * A `rights` part of a `read` request: the `rightsVersion` the client holds,
 * if any (P4-B spec §4.5).
 */
export interface RightsPart {
  type: "rights"
  known?: string
}

/** The value of a `rights` part; `snapshot` is absent iff `known` is current. */
export interface RightsValue {
  rightsVersion: string
  snapshot?: RightsSnapshot
}

/** The value of a `rights` part in wire form. */
export const rightsValueSchema = z.strictObject({
  rightsVersion: rightsVersionSchema,
  snapshot: rightsSnapshotSchema.optional(),
})
