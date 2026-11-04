import { createFileRoute } from "@tanstack/react-router"
import { afterLog } from "../tx"

export const Route = createFileRoute("/after")({
  loader: () => afterLog(),
  component: function After() {
    return <pre data-after="p0a">{JSON.stringify(Route.useLoaderData())}</pre>
  },
})
