import type { Diagnostic } from "../diagnostics"

/**
 * Зміна одного файлу метаданих. Операції T1 не торкаються диска (T1 без Node
 * API), тож повертають перелік змін, а запис — справа обгортки (CLI, MCP).
 */
export interface FileChange {
  /** Шлях відносно кореня `metadata/`, розділювач `/`. */
  path: string
  /** `null` — видалити файл. */
  content: string | null
}

export interface OperationResult {
  /** Компіляція результату без помилок; лише тоді обгортка пише зміни. */
  ok: boolean
  changes: FileChange[]
  diagnostics: Diagnostic[]
}
