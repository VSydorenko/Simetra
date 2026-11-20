// Єдиний вартовий запиту сервера шаблону (Р2 D5): `dataFn` і маршрути токенів
// сигналів проходять один і той самий порядок «походження → сесія → не анонім»,
// щоб правило не розійшлося між шляхами.
import { checkRequestOrigin, type RequestOrigin } from "simetra/server"
import { verifySession } from "./auth"
import { httpOrigin } from "./origin"

type Claims = NonNullable<Awaited<ReturnType<typeof verifySession>>>

export type GuardResult =
  | { ok: true; claims: Claims; origin: RequestOrigin }
  | {
      ok: false
      /** Яка перевірка відмовила: `dataFn` перекладає це у свою відповідь. */
      reason: "origin" | "unauthenticated"
      /** Готова відмова для HTTP-маршрутів: 403 походження, 401 без сесії. */
      response: Response
    }

function refused(reason: "origin" | "unauthenticated"): GuardResult {
  const status = reason === "origin" ? 403 : 401
  return { ok: false, reason, response: Response.json({ reason }, { status }) }
}

/**
 * @param envelope сирий запит для правила походження (`dataFn`); маршрути
 *   токенів його не мають, а HTTP-гілка правила його не читає.
 */
export async function guardRequest(
  request: Request,
  envelope?: unknown
): Promise<GuardResult> {
  // Походження — до `getSession`, яка може продовжити сесію записом у базу й
  // `Set-Cookie`, тож міжсайтовий запит не має до неї дійти.
  const origin = httpOrigin(request)
  if (checkRequestOrigin(origin, envelope) !== undefined) {
    return refused("origin")
  }
  const claims = await verifySession(request.headers)
  if (claims === null) {
    return refused("unauthenticated")
  }
  return { ok: true, claims, origin }
}
