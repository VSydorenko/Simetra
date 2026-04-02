import { create } from 'zustand'
import { useMetadataStore } from './metadata-store'

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
}

export type ProjectStore = ProjectState & ProjectActions

export const useProjectStore = create<ProjectStore>()((set, get) => ({
  projectHandle: null,
  isNewProject: true,
  lastSavedVersion: null,
  isSaving: false,
  isLoading: false,
  lastError: null,

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
}))
