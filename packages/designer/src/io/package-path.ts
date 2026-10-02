import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { UsageError } from "./usage-error"

/**
 * Тека встановленого пакета: перший предок `fromDir` (включно) з
 * `node_modules/<pkg>/package.json`. Шлях навмисно не проходить `realpath`:
 * pnpm робить `node_modules/<pkg>` симлінком у сховище, а значення, що потрапляє
 * у файли метаданих, мусить бути однаковим на кожній машині й переживати
 * перенос репо.
 */
export function installedPackageDir(fromDir: string, pkg: string): string {
  const start = resolve(fromDir)
  let current = start
  for (;;) {
    const candidate = join(current, "node_modules", pkg)
    if (existsSync(join(candidate, "package.json"))) return candidate
    const parent = dirname(current)
    if (parent === current) {
      throw new UsageError(
        `${pkg} is not installed in node_modules above ${start}`
      )
    }
    current = parent
  }
}
