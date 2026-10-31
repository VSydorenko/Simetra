import { z } from "zod"

/**
 * Claims of the verified session (P4 spec Рт19). Решта claims іде в базу як
 * є, тож схема їх не відкидає.
 */
export const sessionClaimsSchema = z.looseObject({
  sub: z.string().min(1),
  act: z.looseObject({ sub: z.string().min(1) }).optional(),
})

export type SessionClaims = z.infer<typeof sessionClaimsSchema>

/** Read access to request headers, whatever the host framework. */
export interface HeaderSource {
  get(name: string): string | null
}

/** The identity port the host supplies: `null` means no valid session. */
export type VerifySession = (
  headers: HeaderSource
) => Promise<SessionClaims | null>
