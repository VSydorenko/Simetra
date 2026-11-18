import type { RequestOrigin } from "simetra/server"
import { appOrigin } from "./config"

/**
 * Факти походження HTTP-запиту для `checkRequestOrigin`. Власне походження —
 * лише з `SIMETRA_APP_ORIGIN`: `Host` і `X-Forwarded-*` підробляє клієнт або
 * проксі, тож порівняння з ними нічого не доводить.
 */
export function httpOrigin(request: Request): RequestOrigin {
  const facts: {
    secFetchSite?: string
    origin?: string
    expectedOrigin: string
  } = { expectedOrigin: appOrigin() }
  const secFetchSite = request.headers.get("sec-fetch-site")
  if (secFetchSite !== null) facts.secFetchSite = secFetchSite
  const origin = request.headers.get("origin")
  if (origin !== null) facts.origin = origin
  return facts
}
