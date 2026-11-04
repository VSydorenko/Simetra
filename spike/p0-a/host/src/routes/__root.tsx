import { createCollection, localOnlyCollectionOptions } from "@tanstack/db"
import { useLiveQuery } from "@tanstack/react-db"
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query"
import {
  createRootRouteWithContext,
  HeadContent,
  Outlet,
  Scripts,
} from "@tanstack/react-router"
import { z } from "zod"

// Host сам користується тими ж бібліотеками, що й пакет: так виглядає
// застосунок, і саме тоді лінкування може дати дві копії (крок 6).
const noteSchema = z.object({ id: z.string() })
const notes = createCollection(
  localOnlyCollectionOptions({
    id: "p0a-host-notes",
    getKey: (note: z.infer<typeof noteSchema>) => note.id,
    initialData: [noteSchema.parse({ id: "host" })],
  })
)

function HostNotes() {
  const { data } = useLiveQuery((q) => q.from({ note: notes }))
  return <meta name="p0a-host-notes" content={String(data.length)} />
}

// Провайдер react-query — у host-і; пакет читає клієнт через контекст, тож
// друга копія react-query зламала б рендер, а не лише розмір бандла.
export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()(
  {
    component: function Root() {
      const { queryClient } = Route.useRouteContext()
      return (
        <html>
          <head>
            <HeadContent />
            <HostNotes />
          </head>
          <body>
            <QueryClientProvider client={queryClient}>
              <Outlet />
            </QueryClientProvider>
            <Scripts />
          </body>
        </html>
      )
    },
  }
)
