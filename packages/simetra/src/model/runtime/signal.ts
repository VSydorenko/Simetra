import { z } from "zod"

/** A signal channel: object changes in a scope, rights in a scope, or one user. */
export type Channel =
  | { kind: "changes"; scopeKindId: string; scope: string; object: string }
  | { kind: "rights"; scopeKindId: string; scope: string }
  | { kind: "user"; userId: string }

/**
 * The channel name on the wire. An unscoped application uses `ZERO_UUID` for
 * the scope kind and the scope, so the segment count never varies.
 */
export function channelTopic(channel: Channel): string {
  switch (channel.kind) {
    case "changes":
      return `simetra:${channel.scopeKindId}:${channel.scope}:${channel.object}`
    case "rights":
      return `simetra-rights:${channel.scopeKindId}:${channel.scope}`
    case "user":
      return `simetra-user:${channel.userId}`
  }
}

// Нижній регістр і фіксована кількість сегментів: топік чужого формату
// (інший реалтайм-канал у тій самій шині) не має проходити за свій.
const UUID_LOWER =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * Parses a topic back to a channel. Strict: the exact segment count, every
 * segment a lowercase UUID; anything else is `undefined`.
 */
export function parseTopic(topic: string): Channel | undefined {
  const [prefix, ...segments] = topic.split(":")
  if (!segments.every((segment) => UUID_LOWER.test(segment))) return undefined
  if (prefix === "simetra" && segments.length === 3) {
    const [scopeKindId, scope, object] = segments as [string, string, string]
    return { kind: "changes", scopeKindId, scope, object }
  }
  if (prefix === "simetra-rights" && segments.length === 2) {
    const [scopeKindId, scope] = segments as [string, string]
    return { kind: "rights", scopeKindId, scope }
  }
  if (prefix === "simetra-user" && segments.length === 1) {
    return { kind: "user", userId: segments[0] as string }
  }
  return undefined
}

const uuid = z.guid()

// Рівно один ключ `<колонка>: <UUID>`: сигнал несе лише ідентифікатор рядка,
// а не його вміст — решту клієнт дочитує звичайним читанням.
const keysSchema = z
  .record(z.string(), uuid)
  .refine((keys) => Object.keys(keys).length === 1, "keys must hold one entry")

/** A row change signal: which object, what happened, which row, at what version. */
export const changeSignalSchema = z.strictObject({
  object: uuid,
  op: z.enum(["create", "update", "markDeletion", "delete"]),
  keys: keysSchema,
  row_ver: z.int(),
})

/** Tells the client to drop its cache of one object and read again. */
export const invalidateSignalSchema = z.strictObject({
  object: uuid,
  op: z.literal("invalidate"),
})

/** Tells the client that its rights changed. */
export const rightsSignalSchema = z.strictObject({
  op: z.literal("rights"),
  row_ver: z.int(),
})

// Транспорт додає `id` повідомлення при отриманні; надсилається сигнал без нього.
export const receivedChangeSchema = changeSignalSchema.extend({ id: uuid })
export const receivedInvalidateSchema = invalidateSignalSchema.extend({
  id: uuid,
})
export const receivedRightsSchema = rightsSignalSchema.extend({ id: uuid })

export type ChangeSignal = z.infer<typeof changeSignalSchema>
export type InvalidateSignal = z.infer<typeof invalidateSignalSchema>
export type RightsSignal = z.infer<typeof rightsSignalSchema>
