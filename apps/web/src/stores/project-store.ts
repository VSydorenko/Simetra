import { create } from "zustand"
import { useMetadataStore } from "./metadata-store"
import { WebStorage } from "@/storage/web-storage"
import type { FileValidationError } from "@/storage/storage-provider"
import {
  saveSession,
  clearSession,
  loadSession,
  loadDraft,
} from "@/storage/session-db"
import {
  pauseDraftSync,
  resumeDraftSync,
  stopAndClearDraft,
} from "@/storage/draft-sync"

const storage = new WebStorage()

export type SessionRestoreStatus =
  | "idle"
  | "restoring"
  | "awaiting-permission"
  | "restored"
  | "failed"
  | "recovery-available"
  | "draft-available"

export type ProjectOrigin =
  | "new"
  | "directory"
  | "zip-import"
  | "draft-recovery"
  | null

export interface ProjectState {
  // Шлях або handle до директорії проєкту (File System Access API)
  projectHandle: FileSystemDirectoryHandle | null
  // Обчислене з handle?.name — назва директорії проєкту
  projectDirectoryName: string | null
  // Назва директорії до отримання дозволу (awaiting-permission)
  pendingDirectoryName: string | null
  // Чи це новий (ще не збережений) проєкт
  isNewProject: boolean
  // Версія model на момент останнього збереження — для порівняння isDirty
  lastSavedVersion: number | null
  // Per-object versions на момент останнього збереження
  lastSavedObjectVersions: Record<string, number>
  // Статус операції
  isSaving: boolean
  isLoading: boolean
  // Помилка останньої операції
  lastError: string | null
  // Попередження при відкритті проєкту (невалідні файли)
  openWarnings: FileValidationError[]
  // Статус відновлення сесії
  sessionRestoreStatus: SessionRestoreStatus
  // Походження поточного проєкту (як він був завантажений, не змінюється при save)
  projectOrigin: ProjectOrigin
  // Інформація про новіший draft для RecoveryBanner
  pendingRecovery: { savedAt: number } | null
  // Чи є draft-fallback при denied permission
  hasDraftFallback: boolean
}

export interface ProjectActions {
  /** Створити новий порожній проєкт */
  newProject: (name: string) => void
  /** Позначити проєкт як збережений */
  markSaved: (handle?: FileSystemDirectoryHandle) => void
  /** Зберегти handle директорії */
  setProjectHandle: (handle: FileSystemDirectoryHandle | null) => void
  /** Перевірити чи є незбережені зміни */
  getIsDirty: () => boolean
  /** Встановити стан завантаження */
  setLoading: (loading: boolean) => void
  /** Встановити стан збереження */
  setSaving: (saving: boolean) => void
  /** Встановити помилку */
  setError: (error: string | null) => void

  /** Зберегти проєкт (File System Access API або ZIP fallback) */
  saveProject: () => Promise<void>
  /** Відкрити проєкт із каталогу або ZIP */
  openProject: () => Promise<void>
  /** Експортувати проєкт як ZIP */
  exportProject: () => Promise<void>
  /** Імпортувати проєкт із ZIP */
  importProject: () => Promise<void>
  /** Відновити сесію з IndexedDB */
  restoreSession: () => Promise<void>
  /** Запросити дозвіл на директорію (для кнопки з Welcome Screen) */
  requestDirectoryPermission: () => Promise<void>
  /** Відновити draft з IndexedDB (crash recovery) */
  restoreDraft: () => Promise<void>
}

export type ProjectStore = ProjectState & ProjectActions

export const useProjectStore = create<ProjectStore>()((set, get) => {
  // Інваріант: projectHandle і projectDirectoryName завжди синхронізовані
  const withHandle = (handle: FileSystemDirectoryHandle | null) => ({
    projectHandle: handle,
    projectDirectoryName: handle?.name ?? null,
  })

  return {
    projectHandle: null,
    projectDirectoryName: null,
    pendingDirectoryName: null,
    isNewProject: true,
    lastSavedVersion: null,
    lastSavedObjectVersions: {},
    isSaving: false,
    isLoading: false,
    lastError: null,
    openWarnings: [],
    sessionRestoreStatus: "idle" as SessionRestoreStatus,
    projectOrigin: null as ProjectOrigin,
    pendingRecovery: null,
    hasDraftFallback: false,

    newProject: (name) => {
      pauseDraftSync()
      useMetadataStore.getState().resetModel(name)
      // Очистити undo-стек після reset
      useMetadataStore.temporal.getState().clear()

      set({
        ...withHandle(null),
        pendingDirectoryName: null,
        isNewProject: true,
        lastSavedVersion: useMetadataStore.getState().version,
        lastSavedObjectVersions: {
          ...useMetadataStore.getState().objectVersions,
        },
        isSaving: false,
        isLoading: false,
        lastError: null,
        openWarnings: [],
        sessionRestoreStatus: "restored",
        projectOrigin: "new",
        pendingRecovery: null,
        hasDraftFallback: false,
      })

      // Очистити session і draft в IndexedDB
      void clearSession()
      stopAndClearDraft()
      resumeDraftSync()
    },

    markSaved: (handle) => {
      set((state) => ({
        lastSavedVersion: useMetadataStore.getState().version,
        lastSavedObjectVersions: {
          ...useMetadataStore.getState().objectVersions,
        },
        isNewProject: false,
        ...(handle
          ? withHandle(handle)
          : { projectHandle: state.projectHandle }),
      }))
    },

    setProjectHandle: (handle) => {
      set(withHandle(handle))
    },

    getIsDirty: () => {
      const { lastSavedVersion } = get()
      if (lastSavedVersion === null) return true
      const { version } = useMetadataStore.getState()
      return version !== lastSavedVersion
    },

    setLoading: (loading) => {
      set({ isLoading: loading })
    },

    setSaving: (saving) => {
      set({ isSaving: saving })
    },

    setError: (error) => {
      set({ lastError: error })
    },

    saveProject: async () => {
      const { isSaving, projectHandle } = get()
      if (isSaving) return

      set({ isSaving: true, lastError: null })
      try {
        // Зафіксувати model і version з одного snapshot до await
        const {
          model,
          version: snapshotVersion,
          objectVersions: snapshotObjVersions,
        } = useMetadataStore.getState()
        const result = await storage.saveProject(
          model,
          projectHandle ?? undefined
        )
        const newHandle = result.handle ?? get().projectHandle
        set({
          isSaving: false,
          isNewProject: false,
          lastSavedVersion: snapshotVersion,
          lastSavedObjectVersions: { ...snapshotObjVersions },
          ...withHandle(newHandle),
        })

        // Оновити session в IndexedDB, очистити draft
        void saveSession(newHandle, model, snapshotVersion, 'directory')
        stopAndClearDraft()
      } catch (e) {
        set({
          isSaving: false,
          lastError: e instanceof Error ? e.message : String(e),
        })
      }
    },

    openProject: async () => {
      const { isLoading } = get()
      if (isLoading) return

      set({ isLoading: true, lastError: null })
      try {
        const result = await storage.openProject()
        pauseDraftSync()
        useMetadataStore.getState().loadModel(result.model)
        useMetadataStore.temporal.getState().clear()

        const handle = result.handle ?? null
        const origin = handle ? 'directory' : 'zip-import'
        const version = useMetadataStore.getState().version
        set({
          isLoading: false,
          isNewProject: false,
          lastSavedVersion: version,
          lastSavedObjectVersions: {
            ...useMetadataStore.getState().objectVersions,
          },
          ...withHandle(handle),
          openWarnings: result.warnings ?? [],
          sessionRestoreStatus: "restored",
          projectOrigin: origin,
          pendingDirectoryName: null,
          pendingRecovery: null,
          hasDraftFallback: false,
        })

        // Оновити session, очистити draft
        void saveSession(handle, result.model, version, origin)
        stopAndClearDraft()
        resumeDraftSync()
      } catch (e) {
        set({
          isLoading: false,
          lastError: e instanceof Error ? e.message : String(e),
        })
      }
    },

    exportProject: async () => {
      const { isSaving } = get()
      if (isSaving) return

      set({ isSaving: true, lastError: null })
      try {
        const model = useMetadataStore.getState().model
        await storage.exportProject(model)
        set({ isSaving: false })
      } catch (e) {
        set({
          isSaving: false,
          lastError: e instanceof Error ? e.message : String(e),
        })
      }
    },

    importProject: async () => {
      const { isLoading } = get()
      if (isLoading) return

      set({ isLoading: true, lastError: null })
      try {
        const result = await storage.importProject()
        pauseDraftSync()
        useMetadataStore.getState().loadModel(result.model)
        useMetadataStore.temporal.getState().clear()

        const version = useMetadataStore.getState().version
        set({
          isLoading: false,
          isNewProject: false,
          lastSavedVersion: version,
          lastSavedObjectVersions: {
            ...useMetadataStore.getState().objectVersions,
          },
          ...withHandle(null),
          openWarnings: result.warnings ?? [],
          sessionRestoreStatus: "restored",
          projectOrigin: "zip-import",
          pendingDirectoryName: null,
          pendingRecovery: null,
          hasDraftFallback: false,
        })

        // Зберегти повноцінну session з handle: null (для restore flow після reload)
        void saveSession(null, result.model, version, 'zip-import')
        resumeDraftSync()
      } catch (e) {
        set({
          isLoading: false,
          lastError: e instanceof Error ? e.message : String(e),
        })
      }
    },

    restoreSession: async () => {
      set({ sessionRestoreStatus: "restoring", lastError: null })
      try {
        const session = await loadSession()
        if (!session) {
          // Перевірити, чи є draft для draft-only recovery
          const draft = await loadDraft()
          if (draft) {
            set({
              sessionRestoreStatus: "draft-available",
              hasDraftFallback: true,
            })
            return
          }
          set({ sessionRestoreStatus: "idle" })
          return
        }

        const { projectHandle: handle } = session

        if (handle) {
          // Перевірити дозвіл на доступ до директорії
          const permission = await handle.queryPermission({ mode: "readwrite" })

          if (permission === "granted") {
            // Тихий auto-restore: читаємо з FS
            pauseDraftSync()
            const result = await storage.openFromHandle(handle)
            useMetadataStore.getState().loadModel(result.model)
            useMetadataStore.temporal.getState().clear()

            const version = useMetadataStore.getState().version
            set({
              ...withHandle(handle),
              isNewProject: false,
              lastSavedVersion: version,
              lastSavedObjectVersions: {
                ...useMetadataStore.getState().objectVersions,
              },
              openWarnings: result.warnings ?? [],
              projectOrigin: "directory",
              pendingDirectoryName: null,
              hasDraftFallback: false,
            })

            // Порівняння draft vs FS через timestamp (стабільний між сесіями)
            const draft = await loadDraft()
            if (draft && draft.savedAt > session.savedAt) {
              // Draft новіший — показати RecoveryBanner, не оновлювати session.savedAt
              set({
                sessionRestoreStatus: "recovery-available",
                pendingRecovery: { savedAt: draft.savedAt },
              })
            } else {
              set({
                sessionRestoreStatus: "restored",
                pendingRecovery: null,
              })
              stopAndClearDraft()
              // Оновити session тільки коли draft не новіший (щоб зберегти baseline для порівняння)
              void saveSession(handle, result.model, version, 'directory')
            }
            resumeDraftSync()
            return
          }

          if (permission === "prompt") {
            // Потрібен user gesture — перевірити чи є draft fallback
            const draft = await loadDraft()
            set({
              sessionRestoreStatus: "awaiting-permission",
              pendingDirectoryName: handle.name,
              hasDraftFallback: !!draft,
            })
            return
          }

          // denied — перевірити draft fallback
          const draft = await loadDraft()
          set({
            sessionRestoreStatus: "awaiting-permission",
            pendingDirectoryName: handle.name,
            hasDraftFallback: !!draft,
          })
          return
        }

        // Session без handle (ZIP import) — відновити з session.projectModel
        pauseDraftSync()
        useMetadataStore.getState().loadModel(session.projectModel)
        useMetadataStore.temporal.getState().clear()

        set({
          ...withHandle(null),
          isNewProject: false,
          lastSavedVersion: useMetadataStore.getState().version,
          lastSavedObjectVersions: {
            ...useMetadataStore.getState().objectVersions,
          },
          sessionRestoreStatus: "restored",
          projectOrigin: (session.origin as ProjectOrigin) ?? "zip-import",
          pendingDirectoryName: null,
          pendingRecovery: null,
          hasDraftFallback: false,
        })
        resumeDraftSync()
      } catch (e) {
        resumeDraftSync()
        set({
          sessionRestoreStatus: "failed",
          pendingDirectoryName: null,
          lastError: e instanceof Error ? e.message : String(e),
        })
      }
    },

    requestDirectoryPermission: async () => {
      set({ sessionRestoreStatus: "restoring", lastError: null })
      try {
        const session = await loadSession()
        if (!session?.projectHandle) {
          set({ sessionRestoreStatus: "failed" })
          return
        }

        const handle = session.projectHandle
        const permission = await handle.requestPermission({ mode: "readwrite" })

        if (permission !== "granted") {
          // Denied — перевірити чи є draft fallback
          const draft = await loadDraft()
          set({
            sessionRestoreStatus: "awaiting-permission",
            hasDraftFallback: !!draft,
          })
          return
        }

        pauseDraftSync()
        const result = await storage.openFromHandle(handle)
        useMetadataStore.getState().loadModel(result.model)
        useMetadataStore.temporal.getState().clear()

        const version = useMetadataStore.getState().version
        set({
          ...withHandle(handle),
          isNewProject: false,
          lastSavedVersion: version,
          lastSavedObjectVersions: {
            ...useMetadataStore.getState().objectVersions,
          },
          openWarnings: result.warnings ?? [],
          projectOrigin: "directory",
          pendingDirectoryName: null,
          hasDraftFallback: false,
        })

        // Порівняння draft vs FS через timestamp
        const draft = await loadDraft()
        if (draft && draft.savedAt > session.savedAt) {
          // Draft новіший — показати RecoveryBanner, не оновлювати session.savedAt
          set({
            sessionRestoreStatus: "recovery-available",
            pendingRecovery: { savedAt: draft.savedAt },
          })
        } else {
          set({
            sessionRestoreStatus: "restored",
            pendingRecovery: null,
          })
          stopAndClearDraft()
          void saveSession(handle, result.model, version, 'directory')
        }
        resumeDraftSync()
      } catch (e) {
        resumeDraftSync()
        set({
          sessionRestoreStatus: "failed",
          pendingDirectoryName: null,
          lastError: e instanceof Error ? e.message : String(e),
        })
      }
    },

    restoreDraft: async () => {
      set({ isLoading: true, lastError: null })
      try {
        const draft = await loadDraft()
        if (!draft) {
          set({ isLoading: false })
          return
        }

        pauseDraftSync()
        useMetadataStore.getState().loadModel(draft.model)
        useMetadataStore.temporal.getState().clear()

        set({
          isLoading: false,
          isNewProject: false,
          lastSavedVersion: null,
          ...withHandle(null),
          sessionRestoreStatus: "restored",
          projectOrigin: "draft-recovery",
          pendingDirectoryName: null,
          pendingRecovery: null,
          hasDraftFallback: false,
        })
        resumeDraftSync()
      } catch (e) {
        resumeDraftSync()
        set({
          isLoading: false,
          lastError: e instanceof Error ? e.message : String(e),
        })
      }
    },
  }
})
