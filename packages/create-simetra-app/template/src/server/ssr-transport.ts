import { createServerOnlyFn } from "@tanstack/react-start"
import type { DataTransport, SessionClaims } from "simetra/model"
import { getDataHandler } from "./runtime"

/**
 * Транспорт серверного рантайму під час SSR (Дх7): обробник кличеться в процесі
 * з `{ inProcess: true }`. `createServerOnlyFn`, а не `createServerFn`: виклик
 * на клієнті кидає виняток, і форма в процесі не стає HTTP-маршрутом, яким
 * чужий сайт обминув би правило походження.
 */
export const ssrTransport = createServerOnlyFn(
  (claims: SessionClaims): DataTransport =>
    async (request) =>
      (await getDataHandler())(claims, request, { inProcess: true })
)
