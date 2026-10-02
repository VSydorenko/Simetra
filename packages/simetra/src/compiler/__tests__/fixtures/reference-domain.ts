import { readdirSync, readFileSync } from "node:fs"
import { join, relative, sep } from "node:path"
import { fileURLToPath } from "node:url"

/** Тека `metadata/` референсного домену (спека П2 §10.1). */
export const REFERENCE_METADATA = fileURLToPath(
  new URL("../../../../../../examples/reference/metadata", import.meta.url)
)

/**
 * Читає домен із диска в мапу «шлях відносно `metadata/` → вміст»: компілятор
 * чистий, читання файлів — справа того, хто його викликає. Спільне для
 * юніт- і DB-тестів, щоб обидва бачили той самий набір файлів.
 */
export function readReferenceDomain(): Map<string, string> {
  const files = new Map<string, string>()
  for (const entry of readdirSync(REFERENCE_METADATA, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile()) continue
    const full = join(entry.parentPath, entry.name)
    const path = relative(REFERENCE_METADATA, full).split(sep).join("/")
    files.set(path, readFileSync(full, "utf8"))
  }
  return files
}
