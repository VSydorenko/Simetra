import { createFileRoute } from "@tanstack/react-router"
import { deferProbe } from "../defer"

export const Route = createFileRoute("/defer")({
  loader: () => deferProbe(),
  component: function Defer() {
    return <pre data-defer="p0a">{JSON.stringify(Route.useLoaderData())}</pre>
  },
})
