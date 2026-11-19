import { z } from "zod"
import { PLATFORM_SCHEMA } from "../schemas/pg-schema"

/**
 * The outbox the Centrifugo consumer reads (postgres profile spec §5.1): a
 * platform table of the schema `simetra` in every project.
 */
export const SIGNAL_OUTBOX = {
  schema: PLATFORM_SCHEMA,
  name: "signal_outbox",
} as const

/** The `NOTIFY` channel the consumer listens on (postgres profile spec §5.3). */
export const SIGNAL_NOTIFY_CHANNEL = "simetra_signal_outbox"

/**
 * Upper bound of one outbox `payload` in octets of its text form: a signal
 * carries ids, not row contents, so a larger payload is a defect.
 */
export const SIGNAL_PAYLOAD_MAX_BYTES = 1024

/**
 * The transaction setting that switches a command from per-row signals to the
 * merged `invalidate` per (scope, object); only the exact merge value counts.
 */
export const SIGNAL_MODE_SETTING = "simetra.signal_mode"
export const SIGNAL_MERGE_MODE = "merge"

/**
 * The function (schema `PLATFORM_SCHEMA`) that writes the merged `invalidate`
 * of one (scope, object) pair; the command runtime calls it in merge mode.
 */
export const SIGNAL_INVALIDATE_FUNCTION_NAME = "signal_invalidate"

/**
 * The channel oracle (schema `PLATFORM_SCHEMA`), `(p_topic text, p_send
 * boolean) → boolean`; the command runtime asks it in subscribe mode for
 * `authorizeChannels`.
 */
export const SIGNAL_TOPIC_ALLOWED_FUNCTION_NAME = "signal_topic_allowed"

/**
 * The default signal merge threshold of the command runtime (P4-B spec §8.2),
 * set by the `bench:signals` benchmark. The threshold + 1 (the `invalidate`)
 * must fit the history of the Centrifugo namespace `simetra` (postgres
 * profile spec §6.1); the config generator of `@simetrajs/designer` is tested
 * against it.
 */
export const SIGNAL_MERGE_THRESHOLD = 90

/** Centrifugo's channel name length limit (`channel_max_length`, octets). */
export const CENTRIFUGO_CHANNEL_MAX = 255

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

/**
 * One topic segment: a lowercase UUID. The one pattern for `parseTopic` and
 * the SQL check of a topic, so the two parsers never disagree.
 */
export const TOPIC_UUID_PATTERN =
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"

// Нижній регістр і фіксована кількість сегментів: топік чужого формату
// (інший реалтайм-канал у тій самій шині) не має проходити за свій.
const UUID_LOWER = new RegExp(`^${TOPIC_UUID_PATTERN}$`)

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

// Десятковий рядок id рядка outbox: `bigint` понад 2^53 у JS губить точність.
const signalId = z.string().regex(/^[1-9][0-9]{0,18}$/)

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
export const receivedChangeSchema = changeSignalSchema.extend({ id: signalId })
export const receivedInvalidateSchema = invalidateSignalSchema.extend({
  id: signalId,
})
export const receivedRightsSchema = rightsSignalSchema.extend({ id: signalId })

export type ChangeSignal = z.infer<typeof changeSignalSchema>
export type InvalidateSignal = z.infer<typeof invalidateSignalSchema>
export type RightsSignal = z.infer<typeof rightsSignalSchema>
