import { useEffect } from "react"
import { useProjectStore } from "@/stores/project-store"

/** Хук для автоматичного відновлення сесії при mount AppShell.
 * Запускає restoreSession() один раз при ініціалізації. */
export function useSessionRestore(): void {
  useEffect(() => {
    const { sessionRestoreStatus, restoreSession } = useProjectStore.getState()
    // Запускати тільки якщо ще не було спроби restore
    if (sessionRestoreStatus === "idle") {
      void restoreSession()
    }
  }, [])
}
