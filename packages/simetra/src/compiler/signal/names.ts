import { PLATFORM_SCHEMA } from "simetra/model"

/**
 * Signal functions of the schema `simetra` (P4-B spec §8.2, §8.3). A module
 * of its own: the command core calls `signal` and the signal generator calls
 * `bodyRequires` of the core, so the names live outside both.
 */
export const SIGNAL_FUNCTIONS = {
  signal: { schema: PLATFORM_SCHEMA, name: "signal" },
  invalidate: { schema: PLATFORM_SCHEMA, name: "signal_invalidate" },
  topicAllowed: { schema: PLATFORM_SCHEMA, name: "signal_topic_allowed" },
  payloadAllowed: { schema: PLATFORM_SCHEMA, name: "signal_payload_allowed" },
} as const
