import { createFileRoute } from "@tanstack/react-router"
import { StubPanel } from "@simetra-spike/p0a-stub/client"
import { getOurs } from "@simetra-spike/p0a-stub/server/ours"

export const Route = createFileRoute("/")({
  loader: () => getOurs(),
  component: function OursPage() {
    return <StubPanel data={Route.useLoaderData()} />
  },
})
