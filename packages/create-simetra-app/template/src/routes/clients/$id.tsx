import { createFileRoute } from "@tanstack/react-router"
import { entityCardRoute } from "simetra/shell"
import { Client } from "../../app"

export const Route = createFileRoute("/clients/$id")(entityCardRoute(Client))
