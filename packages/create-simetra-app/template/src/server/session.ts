import { createServerOnlyFn } from "@tanstack/react-start"
import { checkRequestOrigin } from "simetra/server"
import { verifySession, type AppClaims } from "./auth"
import { httpOrigin } from "./origin"

// Окремо від `session-fn.ts`: файл Server Function потрапляє в клієнтський граф
// (`sessionClaims` кличе `beforeLoad` кореня), а все, що імпортує `auth` і `pg`,
// там зайвим не лишається. Компілятор Start прибирає з клієнтської збірки лише
// те, що не експортується: експортована функція тягла б за собою `auth` і драйвер.

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
