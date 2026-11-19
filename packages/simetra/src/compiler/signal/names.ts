import {
  PLATFORM_SCHEMA,
  SIGNAL_INVALIDATE_FUNCTION_NAME,
  SIGNAL_TOPIC_ALLOWED_FUNCTION_NAME,
} from "simetra/model"

/**
 * Signal functions of the schema `simetra` (P4-B spec §8.2, §8.3). A module
 * of its own: the command core calls `signal` and the signal generator calls
 * `bodyRequires` of the core, so the names live outside both.
 */
export const SIGNAL_FUNCTIONS = {
  signal: { schema: PLATFORM_SCHEMA, name: "signal" },
  // Ім'я — у T0: T3 кличе її в режимі злиття, а імпортує лише `simetra/model`.
  invalidate: {
    schema: PLATFORM_SCHEMA,
    name: SIGNAL_INVALIDATE_FUNCTION_NAME,
  },
  // Ім'я — у T0: T3 питає оракул в `authorizeChannels`.
  topicAllowed: {
    schema: PLATFORM_SCHEMA,
    name: SIGNAL_TOPIC_ALLOWED_FUNCTION_NAME,
  },
  payloadAllowed: { schema: PLATFORM_SCHEMA, name: "signal_payload_allowed" },
} as const
