import { readdirSync, readFileSync, statSync, existsSync } from "node:fs"
import { join } from "node:path"

// Відомі директорії метаданих
const KIND_DIRS = [
  "catalogs",
  "documents",
  "enumerations",
  "information-registers",
  "accumulation-registers",
  "constants",
  "custom-tables",
] as const

/**
 * Зчитує всі .meta.json файли з директорії проєкту.
 * Повертає Map<відносний_шлях, вміст_файлу>.
 */
export function readMetadataFiles(projectDir: string): Map<string, string> {
  const files = new Map<string, string>()

  // Читаємо project.meta.json
  const projectPath = join(projectDir, "project.meta.json")
  if (existsSync(projectPath)) {
    files.set("project.meta.json", readFileSync(projectPath, "utf-8"))
  }

  // Знаходимо директорію metadata
  let metadataDir = join(projectDir, "metadata")
  if (!existsSync(metadataDir) || !statSync(metadataDir).isDirectory()) {
    // Можливо projectDir і є кореневою директорією metadata
    metadataDir = projectDir
  }

  for (const kindDir of KIND_DIRS) {
    const dirPath = join(metadataDir, kindDir)
    if (!existsSync(dirPath) || !statSync(dirPath).isDirectory()) continue

    if (kindDir === "constants") {
      // Константи — один файл constants.meta.json
      const constFile = join(dirPath, "constants.meta.json")
      if (existsSync(constFile)) {
        files.set(
          `${kindDir}/constants.meta.json`,
          readFileSync(constFile, "utf-8")
        )
      }
    } else {
      // Інші типи: {kind-dir}/{kebab-name}/{kebab-name}.meta.json + forms
      const entries = readdirSync(dirPath)
      for (const entry of entries) {
        const entryPath = join(dirPath, entry)
        if (!statSync(entryPath).isDirectory()) continue
        const metaFile = join(entryPath, `${entry}.meta.json`)
        if (existsSync(metaFile)) {
          files.set(
            `${kindDir}/${entry}/${entry}.meta.json`,
            readFileSync(metaFile, "utf-8")
          )
        }
        // Phase 3: forms/*.form.json
        const formsDir = join(entryPath, "forms")
        if (existsSync(formsDir) && statSync(formsDir).isDirectory()) {
          const formEntries = readdirSync(formsDir)
          for (const formFile of formEntries) {
            if (!formFile.endsWith(".form.json")) continue
            const formPath = join(formsDir, formFile)
            if (statSync(formPath).isFile()) {
              files.set(
                `${kindDir}/${entry}/forms/${formFile}`,
                readFileSync(formPath, "utf-8")
              )
            }
          }
        }
      }
    }
  }

  return files
}
