import {
  createIsomorphicFn,
  createServerFn,
  createServerOnlyFn,
} from "@tanstack/react-start"
import { getRequest } from "@tanstack/react-start/server"
import { checkRequestOrigin } from "simetra/server"
import { verifySession, type AppClaims } from "./auth"
import { isStartRefusal } from "../start-refusal"
import { httpOrigin } from "./origin"

async function sessionOrNull(request: Request): Promise<AppClaims | null> {
  const claims = await verifySession(request.headers)
  if (claims === null || claims.is_anonymous !== false) return null
  return claims
}

/**
 * HTTP-шлях: claims не анонімної сесії чи `null`. Походження перевіряється
 * ЗАВЖДИ й першим, без огляду на шлях запиту: Start декодує відсотки в шляху
 * перед маршрутизацією, тож висновок «це не Server Function» з сирого шляху
 * можна обійти. Збій (хост бази, роль) клієнту не віддається — лише `null`.
 */
export async function readSessionClaims(
  request: Request
): Promise<AppClaims | null> {
  try {
    // До `getSession`: вона може продовжити сесію записом і `Set-Cookie`
    if (checkRequestOrigin(httpOrigin(request), undefined) !== undefined) {
      return null
    }
    return await sessionOrNull(request)
  } catch (error) {
    console.error("[simetra] session function", error)
    return null
  }
}

/**
 * Шлях SSR (в процесі): запит — сама навігація, у якої `Sec-Fetch-Site`
 * законно `none` чи `cross-site` (перехід за посиланням), тож правило
 * походження тут не застосовується. Лише серверна гілка ізоморфної функції.
 */
export const readSessionClaimsInProcess = createServerOnlyFn(
  async (request: Request): Promise<AppClaims | null> => {
    try {
      return await sessionOrNull(request)
    } catch (error) {
      console.error("[simetra] session function", error)
      return null
    }
  }
)

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
