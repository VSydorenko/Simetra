import { existsSync } from "node:fs"
import { dirname, join, posix, relative, resolve, sep } from "node:path"
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

/**
 * Відносний шлях із роздільниками `/`: він потрапляє у файли, які комітять і
 * читають на будь-якій ОС (`$schema`, ціль лінка скіла, шлях до бінарника в
 * MCP-конфігу), тож форма не може залежати від машини, де його пораховано.
 */
export function posixRelative(fromDir: string, to: string): string {
  return relative(fromDir, to).split(sep).join(posix.sep)
}
