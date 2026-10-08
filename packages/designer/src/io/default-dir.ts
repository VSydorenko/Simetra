/** Тека метаданих за замовчуванням — спільна для CLI і `simetra mcp`. */
export const DEFAULT_DIR = "./metadata"

// Кінцевий слеш дав би в тексті `dir//file`.
export const trimSlash = (d: string): string => d.replace(/(?<=.)[\\/]+$/, "")
