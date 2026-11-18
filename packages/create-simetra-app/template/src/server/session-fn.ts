import { createIsomorphicFn, createServerFn } from "@tanstack/react-start"
import { getRequest } from "@tanstack/react-start/server"
import { isStartRefusal } from "../start-refusal"
import { readSessionClaims, readSessionClaimsInProcess } from "./session"

export const getSessionClaims = createServerFn({ method: "GET" }).handler(() =>
  readSessionClaims(getRequest())
)

/**
 * Те, що кличе `beforeLoad` кореня (лише цей шлях кличе `sessionClaims` на
 * сервері: він без правила походження): на сервері (SSR) — читання сесії в процесі,
 * на клієнті — Server Function, яка завжди застосовує правило походження
 * (відмова Start 403 на цьому шляху теж дає `null`).
 * Розрізнення будовою (`createIsomorphicFn`), а не висновком зі шляху запиту.
 */
export const sessionClaims = createIsomorphicFn()
  .server(() => readSessionClaimsInProcess(getRequest()))
  .client(async () => {
    try {
      return await getSessionClaims()
    } catch (error) {
      // Голий 403 від Start (`Sec-Fetch-Site` не `same-origin`) — та сама
      // відмова походження, що й `null` від другого шару; решта — справжній збій
      if (isStartRefusal(error)) return null
      throw error
    }
  })
