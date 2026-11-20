import { createFileRoute } from "@tanstack/react-router"
import { handleChannelTokens } from "../../../server/signal-routes"

export const Route = createFileRoute("/simetra/signals/channel-tokens")({
  server: {
    handlers: { POST: ({ request }) => handleChannelTokens(request) },
  },
})
