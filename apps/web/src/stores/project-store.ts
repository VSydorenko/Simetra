import { create } from 'zustand'
import { useMetadataStore } from './metadata-store'
import { WebStorage } from '@/storage/web-storage'
import type { FileValidationError } from '@/storage/storage-provider'

const storage = new WebStorage()

export interface ProjectState {
  // Шлях або handle до директорії проєкту (File System Access API)
  projectHandle: FileSystemDirectoryHandle | null
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
}

export type ProjectStore = ProjectState & ProjectActions

export const useProjectStore = create<ProjectStore>()((set, get) => ({
  projectHandle: null,
  isNewProject: true,
  lastSavedVersion: null,
  isSaving: false,
  isLoading: false,
  lastError: null,
  openWarnings: [],

  newProject: (name) => {
    useMetadataStore.getState().resetModel(name)
    // Очистити undo-стек після reset
    useMetadataStore.temporal.getState().clear()

    set({
      projectHandle: null,
      isNewProject: true,
      lastSavedVersion: useMetadataStore.getState().version,
      isSaving: false,
      isLoading: false,
      lastError: null,
      openWarnings: [],
    })
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
      set({
        isSaving: false,
        isNewProject: false,
        lastSavedVersion: useMetadataStore.getState().version,
        projectHandle: result.handle ?? get().projectHandle,
      })
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
      useMetadataStore.getState().loadModel(result.model)
      useMetadataStore.temporal.getState().clear()

      set({
        isLoading: false,
        isNewProject: false,
        lastSavedVersion: useMetadataStore.getState().version,
        projectHandle: result.handle ?? null,
        openWarnings: result.warnings ?? [],
      })
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
      useMetadataStore.getState().loadModel(result.model)
      useMetadataStore.temporal.getState().clear()

      set({
        isLoading: false,
        isNewProject: false,
        lastSavedVersion: useMetadataStore.getState().version,
        projectHandle: null,
        openWarnings: result.warnings ?? [],
      })
    } catch (e) {
      set({
        isLoading: false,
        lastError: e instanceof Error ? e.message : String(e),
      })
    }
  },
}))
