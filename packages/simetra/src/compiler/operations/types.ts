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
  /** Компіляція результату без помилок; тоді обгортка пише зміни. */
  ok: boolean
  /**
   * Лише в хвості режиму `repair` (спека декларацій функцій §5.1): результат
   * з помилками лише класу ремонту, жодна з яких не нова, прийнято — `ok`
   * лишається `false`, а обгортка пише зміни.
   */
  written?: true
  changes: FileChange[]
  diagnostics: Diagnostic[]
}
