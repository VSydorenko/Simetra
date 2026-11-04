import { createFileRoute } from "@tanstack/react-router"
import { StubPanel } from "@simetra-spike/p0a-stub/client"
import { getSynth } from "@simetra-spike/p0a-stub/server/synth"

export const Route = createFileRoute("/")({
  loader: () => getSynth(),
  component: function SynthPage() {
    return <StubPanel data={Route.useLoaderData()} />
  },
})
