import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { dirname, join, relative, resolve, sep } from "node:path"
import type { FileChange } from "simetra/compiler"
import { SQL_DEBT_FILE } from "simetra/model"
import { UsageError } from "./usage-error"

/**
 * Файли, які читає компілятор; усе інше в теці його не стосується. Перелік
 * боргу — один файл у корені теки: без нього ратчет бачив би порожній перелік
 * і звітував кожну одиницю боргу.
 */
const METADATA_SUFFIXES = [".meta.json", ".sql", ".module.ts"]
export const isMetadataFile = (key: string): boolean =>
  key === SQL_DEBT_FILE ||
  METADATA_SUFFIXES.some((suffix) => key.endsWith(suffix))

/**
 * Єдине місце читання диска для дверей CLI: компілятор (T1) працює над мапою
 * «шлях → текст» і не знає про файлову систему.
 */
export async function readMetadataDir(
  dir: string
): Promise<Map<string, string>> {
  let isDirectory: boolean
  try {
    isDirectory = (await stat(dir)).isDirectory()
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new UsageError(`metadata directory not found: ${dir}`)
    }
    throw error
  }
  if (!isDirectory) throw new UsageError(`Not a directory: ${dir}`)
  const entries = await readdir(dir, { recursive: true, withFileTypes: true })
  const files = new Map<string, string>()
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const full = join(entry.parentPath, entry.name)
    // Ключ із "/" на будь-якій ОС: так шляхи бачить компілятор.
    const key = relative(dir, full).split(sep).join("/")
    if (!isMetadataFile(key)) continue
    files.set(key, await readFile(full, "utf8"))
  }
  return files
}

/**
 * Єдине місце запису; `content: null` видаляє файл і прибирає порожні теки.
 * Видалення йдуть першими: на регістронезалежній ФС перейменування лише
 * регістру — це видалення старого шляху й запис нового, що вказують на той
 * самий файл, і зворотний порядок стер би щойно записане.
 */
export async function writeChanges(
  dir: string,
  changes: readonly FileChange[]
): Promise<void> {
  const root = resolve(dir)
  // Шлях зміни не повинен виходити за межі теки метаданих. Перевірка — до
  // першої дії з диском: шлях, що втікає, наприкінці набору інакше лишив би
  // вже виконані видалення й записи.
  const targets = new Map<FileChange, string>()
  for (const change of changes) {
    const target = resolve(root, change.path)
    if (!target.startsWith(root + sep)) {
      throw new UsageError(`Path escapes the target directory: ${change.path}`)
    }
    targets.set(change, target)
  }
  const ordered = [
    ...changes.filter((c) => c.content === null),
    ...changes.filter((c) => c.content !== null),
  ]
  for (const change of ordered) {
    const target = targets.get(change)!
    if (change.content === null) {
      await rm(target, { force: true })
      await pruneEmptyDirs(dirname(target), root)
    } else {
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, change.content, "utf8")
    }
  }
}

async function pruneEmptyDirs(from: string, root: string): Promise<void> {
  let current = from
  while (current !== root && current.startsWith(root + sep)) {
    let entries: string[]
    try {
      entries = await readdir(current)
    } catch {
      return
    }
    if (entries.length > 0) return
    await rm(current, { recursive: true })
    current = dirname(current)
  }
}
