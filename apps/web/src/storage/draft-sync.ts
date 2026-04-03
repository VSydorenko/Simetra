import { useMetadataStore } from "@/stores/metadata-store"
import { saveDraft, clearDraft } from "@/storage/session-db"

const DRAFT_DEBOUNCE_MS = 3000

let debounceTimer: ReturnType<typeof setTimeout> | null = null
let paused = false

/** Тимчасово призупинити draft sync (під час load/reset/new) */
export function pauseDraftSync(): void {
  paused = true
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
}

/** Відновити draft sync після паузи */
export function resumeDraftSync(): void {
  paused = false
}

/** Підписка на зміни metadata-store для автоматичного збереження draft в IndexedDB.
 * Виклик за межами React lifecycle — працює навіть без mounted компонентів. */
export function startDraftSync(): () => void {
  const unsubscribe = useMetadataStore.subscribe((state, prevState) => {
    if (paused) return
    // Зберігати draft тільки коли model змінився
    if (state.version === prevState.version) return

    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      if (!paused) {
        void saveDraft(state.model, state.version)
      }
    }, DRAFT_DEBOUNCE_MS)
  })

  return () => {
    if (debounceTimer) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }
    unsubscribe()
  }
}

/** Очистити draft (викликається після save на диск або new project) */
export function stopAndClearDraft(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  void clearDraft()
}
