import type { ProjectModel } from "@simetra/core"

/** Результат відкриття проєкту */
export interface OpenProjectResult {
  model: ProjectModel
  handle?: FileSystemDirectoryHandle
}

/** Помилка валідації файлу при відкритті */
export interface FileValidationError {
  filePath: string
  errors: string[]
}

/** Результат відкриття з можливими попередженнями */
export interface OpenResult {
  model: ProjectModel
  handle?: FileSystemDirectoryHandle
  warnings?: FileValidationError[]
}

/**
 * Абстракція I/O для збереження/відкриття проєктів.
 * Store працює тільки з ProjectModel, деталі файлової системи — тут.
 */
export interface StorageProvider {
  /** Відкрити проєкт із каталогу або файлу */
  openProject(): Promise<OpenResult>
  /** Зберегти проєкт у каталог */
  saveProject(
    model: ProjectModel,
    handle?: FileSystemDirectoryHandle
  ): Promise<OpenProjectResult>
  /** Експортувати проєкт як ZIP */
  exportProject(model: ProjectModel): Promise<void>
  /** Імпортувати проєкт із ZIP */
  importProject(): Promise<OpenResult>
}
