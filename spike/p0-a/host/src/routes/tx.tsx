import { createFileRoute } from "@tanstack/react-router"
import { runProbe } from "../tx"

type Search = { user: string; org: string; delay?: number; after?: number }

export const Route = createFileRoute("/tx")({
  validateSearch: (s: Record<string, unknown>): Search => ({
    user: String(s.user ?? ""),
    org: String(s.org ?? ""),
    delay: Number(s.delay ?? 0),
    after: Number(s.after ?? 0),
  }),
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) => runProbe({ data: deps }),
  component: function Tx() {
    return <pre data-tx="p0a">{JSON.stringify(Route.useLoaderData())}</pre>
  },
})
