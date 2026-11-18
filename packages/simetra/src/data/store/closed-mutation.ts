import { LIMIT_REASONS, type CommandError } from "simetra/model"
import type { CloseReason, Mutation, MutationResult } from "./types"

// Окремий модуль, а не `overlay.ts`: закриту мутацію будує й React-міст
// (`useWriter` без рантайму), і лічильник id мусить бути один на обидва входи
// `simetra/data` — без копії журналу в спільному чанку.
let mutationSeq = 0

/** The id of a new mutation, unique across every runtime of the page. */
export const nextMutationId = (): string => `m${++mutationSeq}`

/**
 * The refusal a mutation settles with once its runtime is closed: the same
 * error the transport wrapper gives a request after the close.
 */
export function closedError(reason: CloseReason): CommandError {
  return reason === "session-changed"
    ? {
        code: "command.unauthenticated",
        reason: LIMIT_REASONS.sessionChanged,
      }
    : { code: "command.unavailable", reason: LIMIT_REASONS.disposed }
}

/** A mutation of a closed runtime: settled with the close, never sent. */
export function closedMutation(reason: CloseReason): Mutation {
  return Object.freeze({
    id: nextMutationId(),
    settled: Promise.resolve<MutationResult>({
      ok: false,
      error: closedError(reason),
    }),
  })
}
