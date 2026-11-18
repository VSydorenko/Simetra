// Окремо від `data-fn.ts`: файл Server Function потрапляє в клієнтський граф
// (через `dataTransport`), і експортована тут функція тягла б у клієнтську
// збірку `auth`, пул і каталог рантайму. Компілятор Start прибирає з клієнта
// лише те, що не експортується.
import { LIMIT_REASONS, type DataResponse } from "simetra/model"
import { checkRequestOrigin } from "simetra/server"
import { onDataResponse } from "#instrument"
import { verifySession } from "./auth"
import { httpOrigin } from "./origin"
import { getDataHandler, serverHash } from "./runtime"

function refusal(error: Extract<DataResponse, { ok: false }>["error"]) {
  return { ok: false, error, serverHash } satisfies DataResponse
}

async function respond(
  request: Request,
  envelope: unknown
): Promise<DataResponse> {
  try {
    // Крок 1: походження — до `getSession`, яка може продовжити сесію записом
    // у базу й `Set-Cookie`, тож міжсайтовий запит не має до неї дійти.
    const origin = httpOrigin(request)
    if (checkRequestOrigin(origin, envelope) !== undefined) {
      return refusal({
        code: "command.forbidden",
        reason: LIMIT_REASONS.origin,
      })
    }
    // Крок 2
    const claims = await verifySession(request.headers)
    if (claims === null || claims.is_anonymous !== false) {
      return refusal({ code: "command.unauthenticated" })
    }
    // Крок 3: обробник ще раз застосує правило походження першим кроком
    return await (
      await getDataHandler()
    )(claims, envelope, origin)
  } catch (error) {
    // Крок 4: текст винятку клієнту не йде
    console.error("[simetra] data function", error)
    return refusal({ code: "command.internal" })
  }
}

/** Відповідь Server Function даних; виділено для тесту без рантайму Start. */
export async function handleDataRequest(
  request: Request,
  envelope: unknown
): Promise<DataResponse> {
  const response = await respond(request, envelope)
  onDataResponse(response)
  return response
}
