// Окремо від `data-fn.ts`: файл Server Function потрапляє в клієнтський граф
// (через `dataTransport`), і експортована тут функція тягла б у клієнтську
// збірку `auth`, пул і каталог рантайму. Компілятор Start прибирає з клієнта
// лише те, що не експортується.
import { LIMIT_REASONS, type DataResponse } from "simetra/model"
import { onDataResponse } from "#instrument"
import { guardRequest } from "./request-guard"
import { getDataHandler, serverHash } from "./runtime"

function refusal(error: Extract<DataResponse, { ok: false }>["error"]) {
  return { ok: false, error, serverHash } satisfies DataResponse
}

async function respond(
  request: Request,
  envelope: unknown
): Promise<DataResponse> {
  try {
    // Походження й сесія — спільний вартовий (Р2 D5)
    const guard = await guardRequest(request, envelope)
    if (!guard.ok) {
      return refusal(
        guard.reason === "origin"
          ? { code: "command.forbidden", reason: LIMIT_REASONS.origin }
          : { code: "command.unauthenticated" }
      )
    }
    // Обробник ще раз застосує правило походження першим кроком
    return await (
      await getDataHandler()
    )(guard.claims, envelope, guard.origin)
  } catch (error) {
    // Текст винятку клієнту не йде
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
