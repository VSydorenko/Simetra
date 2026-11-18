import { createFileRoute } from "@tanstack/react-router"
import { entityListRoute } from "simetra/shell"
import { Client } from "../../app"

export const Route = createFileRoute("/clients/")(
  entityListRoute(Client, {
    orderBy: [{ attribute: "description", direction: "asc" }],
  })
)
