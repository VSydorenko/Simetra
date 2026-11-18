import type { RuntimeHolder } from "simetra/data"
import {
  LIMIT_REASONS,
  type DataResponse,
  type DataTransport,
} from "simetra/model"
import { wrapTransport } from "#instrument"
import { clientHash } from "./app"
import { dataFn } from "./server/data-fn"
import { isStartRefusal } from "./start-refusal"

/**
 * Перший шар походження — CSRF-фільтр Start: запит без `Sec-Fetch-Site:
 * same-origin` він відхиляє голим текстом `403 Forbidden` ще до `dataFn`, а
 * клієнт Start перетворює таку відповідь на `Error("Forbidden")`. Інтерфейс
 * мусить бачити ту саму відмову, що й від другого шару (`checkRequestOrigin`):
 * код `command.forbidden` з `reason: origin`, а не необроблений виняток.
 */
export function withStartRefusal(
  call: DataTransport,
  serverHash: string
): DataTransport {
  return async (request) => {
    try {
      return await call(request)
    } catch (error) {
      if (isStartRefusal(error)) {
        return {
          ok: false,
          error: { code: "command.forbidden", reason: LIMIT_REASONS.origin },
          serverHash,
        }
      }
      throw error
    }
  }
}

/** Транспорт клієнтського рантайму: завжди HTTP через `dataFn`. */
export function dataTransport(serverHash: string): DataTransport {
  return withStartRefusal(
    // Відповідь — JSON за побудовою; `dataFn` типізує її як JSON-значення
    async (request) => (await dataFn({ data: request })) as DataResponse,
    serverHash
  )
}

/**
 * Транспорт клієнтського рантайму шаблону. `unauthenticated` без `reason` —
 * розрив сесії поза цим рантаймом (вихід в іншій вкладці, Дх14): тримач
 * замінюється одразу, без значень попереднього користувача, і вкладка йде на
 * вхід. З `reason: session-changed` обгортка нічого не робить: цей шлях веде
 * сам рантайм (`onSessionChanged`), і друга заміна була б подвійною.
 *
 * Заміна лише якщо відповідь стосується того, що тримач тримає зараз: пізня
 * відповідь рантайму іншого суб'єкта (вхід B, поки запит A ще в польоті) не
 * має закрити живий рантайм B.
 */
export function clientTransport(
  holder: RuntimeHolder,
  navigateToLogin: () => void
): DataTransport {
  const call = dataTransport(clientHash)
  return wrapTransport(async (request) => {
    const response = await call(request)
    if (
      !response.ok &&
      response.error.code === "command.unauthenticated" &&
      response.error.reason === undefined &&
      holder.current()?.subject === request.subject
    ) {
      holder.replace(undefined, "signed-out")
      navigateToLogin()
    }
    return response
  })
}
