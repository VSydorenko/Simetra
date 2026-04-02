import { create } from 'zustand'
import { useMetadataStore } from './metadata-store'
import { WebStorage } from '@/storage/web-storage'
import type { FileValidationError } from '@/storage/storage-provider'
import {
  saveSession,
  clearSession,
  clearDraft,
  saveDraft as saveDraftToDb,
  loadSession,
  loadDraft,
} from '@/storage/session-db'
import { pauseDraftSync, resumeDraftSync } from '@/storage/draft-sync'

const storage = new WebStorage()

export type SessionRestoreStatus =
  | 'idle'
  | 'restoring'
  | 'awaiting-permission'
  | 'restored'
  | 'failed'

export interface ProjectState {
  // Шлях або handle до директорії проєкту (File System Access API)
  projectHandle: FileSystemDirectoryHandle | null
  // Обчислене з handle?.name — назва директорії проєкту
  projectDirectoryName: string | null
  // Чи це новий (ще не збережений) проєкт
  isNewProject: boolean
  // Версія model на момент останнього збереження — для порівняння isDirty
  lastSavedVersion: number | null
  // Статус операції
  isSaving: boolean
  isLoading: boolean
  // Помилка останньої операції
  lastError: string | null
  // Попередження при відкритті проєкту (невалідні файли)
  openWarnings: FileValidationError[]
  // Статус відновлення сесії
  sessionRestoreStatus: SessionRestoreStatus
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

export const useProjectStore = create<ProjectStore>()((set, get) => ({
  projectHandle: null,
  projectDirectoryName: null,
  isNewProject: true,
  lastSavedVersion: null,
  isSaving: false,
  isLoading: false,
  lastError: null,
  openWarnings: [],
  sessionRestoreStatus: 'idle' as SessionRestoreStatus,

  newProject: (name) => {
    pauseDraftSync()
    useMetadataStore.getState().resetModel(name)
    // Очистити undo-стек після reset
    useMetadataStore.temporal.getState().clear()

    set({
      projectHandle: null,
      projectDirectoryName: null,
      isNewProject: true,
      lastSavedVersion: useMetadataStore.getState().version,
      isSaving: false,
      isLoading: false,
      lastError: null,
      openWarnings: [],
    })

    // Очистити session і draft в IndexedDB
    void clearSession()
    void clearDraft()
    resumeDraftSync()
  },

  markSaved: (handle) => {
    set((state) => ({
      lastSavedVersion: useMetadataStore.getState().version,
      isNewProject: false,
      projectHandle: handle ?? state.projectHandle,
    }))
  },

  setProjectHandle: (handle) => {
    set({ projectHandle: handle })
  },

  getIsDirty: () => {
    const { lastSavedVersion } = get()
    if (lastSavedVersion === null) return true
    return useMetadataStore.getState().version !== lastSavedVersion
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
      const model = useMetadataStore.getState().model
      const result = await storage.saveProject(model, projectHandle ?? undefined)
      const newHandle = result.handle ?? get().projectHandle
      const version = useMetadataStore.getState().version
      set({
        isSaving: false,
        isNewProject: false,
        lastSavedVersion: version,
        projectHandle: newHandle,
        projectDirectoryName: newHandle?.name ?? null,
      })

      // Оновити session в IndexedDB, очистити draft
      void saveSession(newHandle, model, version)
      void clearDraft()
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
      const version = useMetadataStore.getState().version
      set({
        isLoading: false,
        isNewProject: false,
        lastSavedVersion: version,
        projectHandle: handle,
        projectDirectoryName: handle?.name ?? null,
        openWarnings: result.warnings ?? [],
      })

      // Оновити session, очистити draft
      void saveSession(handle, result.model, version)
      void clearDraft()
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
        projectHandle: null,
        projectDirectoryName: null,
        openWarnings: result.warnings ?? [],
      })

      // Очистити session (немає handle), зберегти model як draft
      void clearSession()
      void saveDraftToDb(result.model, version)
      resumeDraftSync()
    } catch (e) {
      set({
        isLoading: false,
        lastError: e instanceof Error ? e.message : String(e),
      })
    }
  },

  restoreSession: async () => {
    set({ sessionRestoreStatus: 'restoring', lastError: null })
    try {
      const session = await loadSession()
      if (!session) {
        set({ sessionRestoreStatus: 'idle' })
        return
      }

      const { projectHandle: handle } = session

      if (handle) {
        // Перевірити дозвіл на доступ до директорії
        const permission = await handle.queryPermission({ mode: 'readwrite' })

        if (permission === 'granted') {
          // Тихий auto-restore: читаємо з FS
          pauseDraftSync()
          const result = await storage.openFromHandle(handle)
          useMetadataStore.getState().loadModel(result.model)
          useMetadataStore.temporal.getState().clear()

          const version = useMetadataStore.getState().version
          set({
            projectHandle: handle,
            projectDirectoryName: handle.name,
            isNewProject: false,
            lastSavedVersion: version,
            sessionRestoreStatus: 'restored',
            openWarnings: result.warnings ?? [],
          })

          // Перевірити чи є новіший draft (crash recovery)
          const draft = await loadDraft()
          if (draft && draft.version > version) {
            // Draft новіший — зберегти інфо, UI вирішить чи показувати діалог
            void saveSession(handle, result.model, version)
          } else {
            void clearDraft()
          }
          resumeDraftSync()
          return
        }

        if (permission === 'prompt') {
          // Потрібен user gesture — показати Welcome Screen з кнопкою
          set({
            sessionRestoreStatus: 'awaiting-permission',
            projectDirectoryName: handle.name,
          })
          return
        }
      }

      // Немає handle або denied — спробувати draft
      const draft = await loadDraft()
      if (draft) {
        set({ sessionRestoreStatus: 'awaiting-permission' })
        return
      }

      set({ sessionRestoreStatus: 'idle' })
    } catch (e) {
      resumeDraftSync()
      set({
        sessionRestoreStatus: 'failed',
        lastError: e instanceof Error ? e.message : String(e),
      })
    }
  },

  requestDirectoryPermission: async () => {
    set({ sessionRestoreStatus: 'restoring', lastError: null })
    try {
      const session = await loadSession()
      if (!session?.projectHandle) {
        set({ sessionRestoreStatus: 'failed' })
        return
      }

      const handle = session.projectHandle
      const permission = await handle.requestPermission({ mode: 'readwrite' })

      if (permission !== 'granted') {
        set({ sessionRestoreStatus: 'awaiting-permission' })
        return
      }

      pauseDraftSync()
      const result = await storage.openFromHandle(handle)
      useMetadataStore.getState().loadModel(result.model)
      useMetadataStore.temporal.getState().clear()

      const version = useMetadataStore.getState().version
      set({
        projectHandle: handle,
        projectDirectoryName: handle.name,
        isNewProject: false,
        lastSavedVersion: version,
        sessionRestoreStatus: 'restored',
        openWarnings: result.warnings ?? [],
      })

      void saveSession(handle, result.model, version)
      // Draft очищається тільки після успішного відновлення з FS
      void clearDraft()
      resumeDraftSync()
    } catch (e) {
      resumeDraftSync()
      set({
        sessionRestoreStatus: 'failed',
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
        lastSavedVersion: draft.version,
        projectHandle: null,
        projectDirectoryName: null,
        sessionRestoreStatus: 'restored',
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
}))
