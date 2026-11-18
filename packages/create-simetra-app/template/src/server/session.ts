import { createServerOnlyFn } from "@tanstack/react-start"
import { getRequest } from "@tanstack/react-start/server"
import { verifySession, type AppClaims } from "./auth"

// Усе, що імпортує `auth` і `pg`, не має потрапити в клієнтський граф: корінь
// кличе `sessionClaims` з `beforeLoad`. Компілятор Start прибирає з клієнтської
// збірки лише тіло `createServerOnlyFn`, тож експорт лише такої обгортки не тягне
// за собою `auth` і драйвер.

async function sessionOrNull(request: Request): Promise<AppClaims | null> {
  const claims = await verifySession(request.headers)
  if (claims === null || claims.is_anonymous !== false) return null
  return claims
}

/**
 * Читання сесії в процесі (SSR): запит — сама навігація, у якої `Sec-Fetch-Site`
 * законно `none` чи `cross-site` (перехід за посиланням), тож правило
 * походження тут не застосовується. HTTP-шляху до сесії немає: клієнт її не
 * опитує, claims він бере з серверного знімка.
 */
const readSessionClaimsInProcess = createServerOnlyFn(
  async (request: Request): Promise<AppClaims | null> => {
    try {
      return await sessionOrNull(request)
    } catch (error) {
      console.error("[simetra] session function", error)
      return null
    }
  }
)

/** Те, що кличе серверна гілка `beforeLoad` кореня: claims поточного запиту. */
export const sessionClaims = createServerOnlyFn(() =>
  readSessionClaimsInProcess(getRequest())
)
