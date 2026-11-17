import {
  LIMIT_REASONS,
  type DataResponse,
  type DataTransport,
} from "simetra/model"
import { dataFn } from "./server/data-fn"

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
      if (error instanceof Error && error.message === "Forbidden") {
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
