import { createServerFn } from "@tanstack/react-start"
import { getRequest } from "@tanstack/react-start/server"
import { handleDataRequest } from "./data-request"

type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

/** Транспорт клієнтського рантайму: завжди HTTP, тож завжди з фактами запиту. */
export const dataFn = createServerFn({ method: "POST" })
  .validator((envelope: unknown) => envelope)
  // Конверт відповіді — JSON за побудовою (`value` проходить `JSON.stringify` у
  // бюджеті відповіді), але `unknown` типізація серіалізації Start не знає
  .handler(
    async ({ data }) =>
      (await handleDataRequest(getRequest(), data)) as JsonValue
  )
