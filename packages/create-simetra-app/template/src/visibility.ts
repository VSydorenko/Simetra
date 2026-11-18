import type { RuntimeHolder } from "simetra/data"

type Target = Pick<EventTarget, "addEventListener" | "removeEventListener">

/**
 * `suspend()` і `resume()` кличе host, бо T4 не читає `document` (§4.6).
 * Пар не рахуємо: подія може загубитися чи повторитися, рантайм це витримує
 * (`suspend` ідемпотентний, повтор `resume` протягом 1 с зливається). Кожного
 * разу береться поточний рантайм тримача: після заміни події йдуть новому.
 */
export function watchVisibility(
  holder: RuntimeHolder,
  doc: Target & { readonly hidden: boolean },
  win: Target
): () => void {
  const onVisibility = () => {
    const runtime = holder.current()
    if (doc.hidden) runtime?.suspend()
    else runtime?.resume()
  }
  const onFocus = () => holder.current()?.resume()
  doc.addEventListener("visibilitychange", onVisibility)
  win.addEventListener("focus", onFocus)
  return () => {
    doc.removeEventListener("visibilitychange", onVisibility)
    win.removeEventListener("focus", onFocus)
  }
}

/**
 * Ефект кореня, один раз на гідратацію: звірка з сервером, ознака для e2e
 * (Д-8) і підписка на видимість. Повертає відписку.
 */
export function startClient(
  scope: {
    holder: RuntimeHolder
    hydrated: boolean
    hydrationEnded: boolean
    markHydrated(): void
  },
  doc: Target & {
    readonly hidden: boolean
    readonly documentElement: {
      setAttribute(name: string, value: string): void
    }
  },
  win: Target
): () => void {
  if (!scope.hydrationEnded) {
    scope.hydrationEnded = true
    // Без знімка гідратувати нічого: рантайм клієнтської навігації порожній
    if (scope.hydrated) scope.holder.current()?.endHydration()
    scope.markHydrated()
    doc.documentElement.setAttribute("data-hydrated", "true")
  }
  return watchVisibility(scope.holder, doc, win)
}
