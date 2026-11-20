import { createFileRoute } from "@tanstack/react-router"
import { handleConnectionToken } from "../../../server/signal-routes"

export const Route = createFileRoute("/simetra/signals/connection-token")({
  server: {
    handlers: { POST: ({ request }) => handleConnectionToken(request) },
  },
})
