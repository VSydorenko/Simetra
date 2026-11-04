import { lstat } from "node:fs/promises"

export type Probe =
  | { kind: "missing" | "file" | "dir" | "symlink" }
  | { kind: "error"; code: string }

/**
 * Що лежить за шляхом, без переходу за симлінком: `init` судить про власні
 * лінки за самим лінком (`readlink`), тож битий власний лінк — теж власний.
 * Помилка ФС повертається значенням, а не винятком: план збирає відмови й
 * нічого не застосовує (спека designer §4.2).
 */
export async function probe(path: string): Promise<Probe> {
  try {
    const s = await lstat(path)
    if (s.isSymbolicLink()) return { kind: "symlink" }
    return { kind: s.isDirectory() ? "dir" : "file" }
  } catch (e) {
    const code = errorCode(e)
    return code === "ENOENT" ? { kind: "missing" } : { kind: "error", code }
  }
}

export function errorCode(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code
  return typeof code === "string" ? code : "EUNKNOWN"
}
