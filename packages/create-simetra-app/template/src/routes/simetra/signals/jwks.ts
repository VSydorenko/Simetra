import { createFileRoute } from "@tanstack/react-router"
import { handleJwks } from "../../../server/signal-routes"

// Шлях збігається з `SIGNALS_JWKS_PATH` (T3): його читає Centrifugo.
export const Route = createFileRoute("/simetra/signals/jwks")({
  server: { handlers: { GET: () => handleJwks() } },
})
