// Фейковий канал сигналів (спайк 3 над справжнім ядром): кожен сигнал — це
// виклик Writer ядра в його commit з поточним токеном, як у
// real-core-adapter спайку 3 (origin/spike/t4-realtime@6498b629).
import type { Page } from "@playwright/test"

type Op =
  | {
      op: "patch"
      rows: { key: string; version: number; values: Record<string, unknown> }[]
    }
  | { op: "stale"; keys: string[]; minVersion?: number }
  | { op: "remove"; keys: string[] }
  | { op: "views"; flags: { hasNewRows?: boolean; needsRefresh?: boolean } }

export async function signal(page: Page, ...ops: Op[]) {
  await page.evaluate((ops) => {
    const core = (window as any).__t4Holder.core
    core.commit((w: any) => {
      for (const o of ops) {
        if (o.op === "patch") w.patch("Catalog.Item", o.rows)
        else if (o.op === "stale")
          w.markStale("Catalog.Item", o.keys, o.minVersion)
        else if (o.op === "remove") w.remove("Catalog.Item", o.keys)
        else w.markViews("Catalog.Item", o.flags)
      }
    }, core.token())
  }, ops)
}

/** Перепідписка після розриву: перечитати видимі ключі. */
export async function rejoin(page: Page, keys: string[]) {
  await page.evaluate(
    (keys) => (window as any).__t4Holder.core.refetchKeys("Catalog.Item", keys),
    keys
  )
}

/** Підтверджений рядок ядра (версія й значення) — для побудови сигналу. */
export async function confirmed(page: Page, key: string) {
  return page.evaluate((key) => {
    const core = (window as any).__t4Holder.core
    // Рядок уже показано у вікні списку: беремо його звідти (без нового вигляду).
    const h = core.view({
      kind: "window",
      object: "Catalog.Item",
      orderBy: [{ attribute: "num", direction: "asc" }],
      pageSize: 100,
    })
    const r = h.getSnapshot().rows.find((x: any) => x.key === key)
    return {
      version: core.confirmedVersion("Catalog.Item", key) as number,
      values: r?.values as Record<string, unknown>,
    }
  }, key)
}
