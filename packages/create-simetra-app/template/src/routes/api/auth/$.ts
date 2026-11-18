import { createFileRoute } from "@tanstack/react-router"
import { getAuth } from "../../../server/auth"

// Better Auth сам розбирає шлях `/api/auth/*`; маршрут лише передає запит.
const handle = ({ request }: { request: Request }) => getAuth().handler(request)

export const Route = createFileRoute("/api/auth/$")({
  server: { handlers: { GET: handle, POST: handle } },
})
