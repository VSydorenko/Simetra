import { useUiStore } from "../../stores/ui-store"
import { FloatingWindow } from "./floating-window"

/**
 * Контейнер для floating windows — має бути position: relative,
 * щоб Rnd bounds="parent" обмежував вікна центральною панеллю.
 */
export function FloatingWindowContainer() {
  const floatingWindows = useUiStore((s) => s.floatingWindows)

  // Рендеримо тільки не-мінімізовані вікна
  const visibleWindows = floatingWindows.filter((w) => !w.isMinimized)

  if (visibleWindows.length === 0) return null

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      <div className="pointer-events-auto relative h-full w-full">
        {visibleWindows.map((win) => (
          <FloatingWindow key={win.id} window={win} />
        ))}
      </div>
    </div>
  )
}
