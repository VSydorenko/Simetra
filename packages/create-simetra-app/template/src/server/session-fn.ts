import { createServerFn } from "@tanstack/react-start"
import { getRequest } from "@tanstack/react-start/server"
import { checkRequestOrigin } from "simetra/server"
import { verifySession, type AppClaims } from "./auth"
import { httpOrigin } from "./origin"

// Виклик з браузера йде HTTP-запитом на базу Server Function; на SSR функція
// викликається в процесі, а запит — це сама навігація, у якої `Sec-Fetch-Site`
// законно `none` чи `cross-site` (перехід за посиланням). Значення — з
// build-define Start; без нього шлях рахується HTTP (відмова замість пропуску).
function isServerFnRequest(request: Request): boolean {
  const base = process.env.TSS_SERVER_FN_BASE
  if (base === undefined || base === "") return true
  return new URL(request.url).pathname.startsWith(base)
}

/**
 * Claims не анонімної сесії чи `null`. Збій (хост бази, роль) клієнту не
 * віддається: функція ловить виняток і повертає лише `null`.
 */
export async function readSessionClaims(
  request: Request
): Promise<AppClaims | null> {
  try {
    // Першим — походження, до `getSession` (вона може писати в базу й ставити
    // cookie); лише на HTTP-шляху, див. `isServerFnRequest`
    if (
      isServerFnRequest(request) &&
      checkRequestOrigin(httpOrigin(request), undefined) !== undefined
    ) {
      return null
    }
    const claims = await verifySession(request.headers)
    if (claims === null || claims.is_anonymous !== false) return null
    return claims
  } catch (error) {
    console.error("[simetra] session function", error)
    return null
  }
}

export const getSessionClaims = createServerFn({ method: "GET" }).handler(() =>
  readSessionClaims(getRequest())
)
