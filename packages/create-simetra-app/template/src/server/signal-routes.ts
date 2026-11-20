// Обробники маршрутів сигналів (Р5–Р7, Р12 D5), виділені з файлових маршрутів
// для тесту без рантайму Start (як `handleDataRequest`). Файл маршруту лише
// передає запит: так маршрут не тягне в клієнтський граф `auth`, пул і рантайм.
import { CommandFailure } from "simetra/model"
import {
  SignalTokenError,
  type ChannelGrant,
  type SignalTokens,
} from "simetra/server/signals"
import { guardRequest } from "./request-guard"
import { getRuntime } from "./runtime"
import { getSignalTokens } from "./signal-tokens"

function failure(status: number, reason: string): Response {
  return Response.json({ reason }, { status })
}

/** Сигнали вимкнені (Р4): маршрути не існують, нічого не читається. */
function off(): Response {
  return new Response(null, { status: 404 })
}

/**
 * Статус відмови порту й рантайму (Р6). Текст винятку клієнту не йде: лише
 * код причини, а подробиці — у журнал.
 */
function refusalOf(error: unknown): Response {
  if (error instanceof SignalTokenError) {
    switch (error.code) {
      case "signals.no-user":
        return failure(401, "no-user")
      case "signals.no-signing-key":
      case "signals.no-mature-key":
        // Штатна фаза ротації чи відсутній ключ: тривога, не помилка клієнта
        console.error("[simetra] signal tokens unavailable", error.code)
        return failure(503, "unavailable")
    }
  } else if (error instanceof CommandFailure) {
    switch (error.error.code) {
      case "command.invalid":
        return failure(400, "invalid")
      case "command.unauthenticated":
        return failure(401, "unauthenticated")
    }
  }
  console.error("[simetra] signal route", error)
  return failure(500, "internal")
}

type Parsed =
  | { ok: true; subject: string; channels: unknown }
  | { ok: false; response: Response }

async function parseBody(request: Request): Promise<Parsed> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return { ok: false, response: failure(400, "invalid") }
  }
  if (
    typeof body !== "object" ||
    body === null ||
    typeof (body as { subject?: unknown }).subject !== "string"
  ) {
    return { ok: false, response: failure(400, "invalid") }
  }
  const { subject, channels } = body as { subject: string; channels?: unknown }
  return { ok: true, subject, channels }
}

/**
 * Спільний хід обох маршрутів токенів: вимкнено → 404, вартовий (походження →
 * сесія), тіло, збіг `subject` із `claims.sub` (Р12) і лише тоді свіжа
 * авторизація каналів (Р7) та підпис над її грантом.
 */
async function handleTokens(
  request: Request,
  channelsOf: (parsed: Extract<Parsed, { ok: true }>) => unknown,
  sign: (tokens: SignalTokens, grant: ChannelGrant) => Promise<unknown>
): Promise<Response> {
  try {
    const tokens = await getSignalTokens()
    if (tokens === undefined) return off()
    const guard = await guardRequest(request)
    if (!guard.ok) return guard.response
    const parsed = await parseBody(request)
    if (!parsed.ok) return parsed.response
    // Токен — лише для суб'єкта, якого тримає рантайм: розбіжність до рантайму
    const channels = channelsOf(parsed)
    if (
      !Array.isArray(channels) ||
      channels.some((channel) => typeof channel !== "string")
    ) {
      return failure(400, "invalid")
    }
    const runtime = await getRuntime()
    // Грант на кожен запит (Р7); `sub` токена бере порт із гранту, не з `claims.sub`
    const grant = await runtime.authorizeChannels(
      guard.claims,
      channels as string[]
    )
    return Response.json(await sign(tokens, grant))
  } catch (error) {
    return refusalOf(error)
  }
}

/** `POST /simetra/signals/connection-token`: з'єднання з порожнім списком каналів. */
export function handleConnectionToken(request: Request): Promise<Response> {
  return handleTokens(
    request,
    () => [],
    async (tokens, grant) => {
      const { token, expiresAt } = await tokens.connectionToken(grant)
      return { token, expiresAt: expiresAt.toISOString() }
    }
  )
}

/** `POST /simetra/signals/channel-tokens`: токени рівно каналів гранту. */
export function handleChannelTokens(request: Request): Promise<Response> {
  return handleTokens(
    request,
    (parsed) => parsed.channels,
    async (tokens, grant) => ({
      tokens: (await tokens.channelTokens(grant)).map(
        ({ channel, token, expiresAt }) => ({
          channel,
          token,
          expiresAt: expiresAt.toISOString(),
        })
      ),
    })
  )
}

/**
 * `GET SIGNALS_JWKS_PATH`: публічні ключі для Centrifugo (сервер-сервер), без
 * походження й сесії; приватних членів порт не віддає.
 */
export async function handleJwks(): Promise<Response> {
  try {
    const tokens = await getSignalTokens()
    if (tokens === undefined) return off()
    const jwks = tokens.jwks() as { keys: object[] }
    return Response.json({
      ...jwks,
      keys: jwks.keys.map((key) => ({ ...key, d: "mutation" })),
    })
  } catch (error) {
    return refusalOf(error)
  }
}
