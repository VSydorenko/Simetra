import { type CommandError, LIMIT_REASONS } from "simetra/model"

/**
 * Facts about the request origin that the host passes to the data handler.
 * An HTTP call carries the `Sec-Fetch-Site` and `Origin` header values (absent
 * header = absent field) and the origin the host serves from; a call inside
 * the server process (SSR) is `{ inProcess: true }`.
 */
export type RequestOrigin =
  | { secFetchSite?: string; origin?: string; expectedOrigin: string }
  | { inProcess: true }

const REFUSED: CommandError = {
  code: "command.forbidden",
  reason: LIMIT_REASONS.origin,
}

/** In-process calls may only read: `run` needs the facts of an HTTP request. */
const IN_PROCESS_TYPES: ReadonlySet<string> = new Set(["read", "version"])

/**
 * Step 0 of the data handler: refuses a request that could be forged by
 * another site. Runs before the envelope is parsed, so it touches nothing but
 * the origin facts (and, for `inProcess`, the raw request type).
 *
 * @returns the refusal, or `undefined` when the request may proceed.
 */
export function checkRequestOrigin(
  origin: RequestOrigin,
  rawRequest: unknown
): CommandError | undefined {
  if (isInProcess(origin)) {
    return inProcessAllowed(rawRequest) ? undefined : REFUSED
  }
  return httpAllowed(origin) ? undefined : REFUSED
}

// Лише буквальне `true`: присутність ключа не рахується, бо нетипізований
// виклик з `inProcess: false` інакше обійшов би перевірку заголовків.
function isInProcess(origin: RequestOrigin): origin is { inProcess: true } {
  return (origin as { inProcess?: unknown }).inProcess === true
}

function httpAllowed(origin: {
  secFetchSite?: string
  origin?: string
  expectedOrigin: string
}): boolean {
  // Неканонічне власне походження (зокрема "null") не можна порівнювати:
  // таке порівняння пропустило б чужий `Origin: null`.
  if (!isCanonicalOrigin(origin.expectedOrigin)) return false
  if (
    origin.secFetchSite !== undefined &&
    origin.secFetchSite !== "same-origin"
  ) {
    return false
  }
  if (origin.origin !== undefined)
    return origin.origin === origin.expectedOrigin
  // Без `Origin` лишається довіряти лише `Sec-Fetch-Site: same-origin`;
  // без обох заголовків запит відхиляється (fail-closed).
  return origin.secFetchSite === "same-origin"
}

function isCanonicalOrigin(value: string): boolean {
  try {
    return new URL(value).origin === value
  } catch {
    return false
  }
}

// Сирий вхід ще не розібраний і може кидати (геттер, Proxy): будь-який виняток
// — відмова, а тип читається один раз, щоб підміна між читаннями не діяла.
function inProcessAllowed(rawRequest: unknown): boolean {
  try {
    const type = (rawRequest as { request: { type: unknown } }).request.type
    return typeof type === "string" && IN_PROCESS_TYPES.has(type)
  } catch {
    return false
  }
}
