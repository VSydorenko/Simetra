import { createFileRoute } from "@tanstack/react-router"
import { entityListRoute } from "simetra/shell"
import { Country } from "../../app"

export const Route = createFileRoute("/countries/")(entityListRoute(Country))
