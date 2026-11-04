import { createCollection, localOnlyCollectionOptions } from "@tanstack/db"
import { useLiveQuery } from "@tanstack/react-db"
import { useQueryClient } from "@tanstack/react-query"
import { z } from "zod"

// Клієнтська точка входу пакета. Вона імпортує ті самі бібліотеки зі станом
// на рівні модуля, що й host (react-query, TanStack DB, zod): крок 6 рахує,
// чи не з'явиться їхня друга фізична копія при лінкуванні.
const itemSchema = z.object({ id: z.string(), label: z.string() })

const items = createCollection(
  localOnlyCollectionOptions({
    id: "p0a-items",
    getKey: (item: z.infer<typeof itemSchema>) => item.id,
    initialData: [{ id: "1", label: "stub-item" }],
  })
)

export function StubPanel(props: { data: unknown }) {
  const client = useQueryClient()
  const { data } = useLiveQuery((q) => q.from({ item: items }))
  return (
    <section data-stub="p0a">
      <pre>{JSON.stringify(props.data)}</pre>
      <p data-libs="p0a">
        {String(Boolean(client))}:{data.length}
      </p>
    </section>
  )
}
