import type { ProjectModel, FileEntry } from "@simetra/core"
import {
  parseMetadataFiles,
  buildProjectModelFromParsed,
  formatValidationMessage,
  serializeToFiles,
  toKebabCase,
} from "@simetra/core"
import { unzip, zip } from "fflate"
import i18n from "@/i18n"
import type {
  FileValidationError,
  OpenResult,
  OpenProjectResult,
  StorageProvider,
} from "./storage-provider"

/** Чи підтримує браузер File System Access API */
export function hasFileSystemAccess(): boolean {
  return typeof window !== "undefined" && "showDirectoryPicker" in window
}

// --- File System Access API helpers ---

async function getOrCreateDir(
  parent: FileSystemDirectoryHandle,
  name: string
): Promise<FileSystemDirectoryHandle> {
  return parent.getDirectoryHandle(name, { create: true })
}

async function writeTextFile(
  dir: FileSystemDirectoryHandle,
  name: string,
  content: string
): Promise<void> {
  const file = await dir.getFileHandle(name, { create: true })
  const writable = await file.createWritable()
  await writable.write(content)
  await writable.close()
}

async function fileExists(
  dir: FileSystemDirectoryHandle,
  name: string
): Promise<boolean> {
  try {
    await dir.getFileHandle(name)
    return true
  } catch {
    return false
  }
}

async function dirExists(
  parent: FileSystemDirectoryHandle,
  name: string
): Promise<boolean> {
  try {
    await parent.getDirectoryHandle(name)
    return true
  } catch {
    return false
  }
}

// serializeToFiles, parseMetadataFiles, buildProjectModelFromParsed
// тепер імпортуються з @simetra/core (shared metadata IO layer)

// Re-export для зворотної сумісності модулів, що імпортували з web-storage
export { toKebabCase, serializeToFiles }

function localizeWarnings(
  warnings: FileValidationError[]
): FileValidationError[] {
  return warnings.map((warning) => ({
    filePath: warning.filePath,
    errors: warning.errors.map((error) =>
      formatValidationMessage(error, {
        translate: (key, values) => i18n.t(key, values),
      })
    ),
  }))
}

// --- File System Access API storage ---

/** Видалити вміст каталогу рекурсивно */
async function clearDirectory(dir: FileSystemDirectoryHandle): Promise<void> {
  const entries: [string, FileSystemHandle][] = []
  for await (const entry of dir.entries()) {
    entries.push(entry)
  }
  for (const [name, entry] of entries) {
    if (entry.kind === "directory") {
      await dir.removeEntry(name, { recursive: true })
    } else {
      await dir.removeEntry(name)
    }
  }
}

async function saveToDirectory(
  model: ProjectModel,
  handle: FileSystemDirectoryHandle
): Promise<void> {
  const files = serializeToFiles(model)

  // Створити metadata/ корінь та очистити stale файли
  const metadataDir = await getOrCreateDir(handle, "metadata")
  await clearDirectory(metadataDir)

  for (const file of files) {
    const parts = file.path.split("/")
    let currentDir = metadataDir

    // Створити проміжні каталоги
    for (let i = 0; i < parts.length - 1; i++) {
      currentDir = await getOrCreateDir(currentDir, parts[i])
    }

    await writeTextFile(currentDir, parts[parts.length - 1], file.content)
  }
}

async function readFromDirectory(
  handle: FileSystemDirectoryHandle
): Promise<Map<string, string>> {
  const files = new Map<string, string>()

  // Шукаємо metadata/ каталог
  let metadataDir: FileSystemDirectoryHandle
  if (await dirExists(handle, "metadata")) {
    metadataDir = await handle.getDirectoryHandle("metadata")
  } else {
    // Можливо, кореневий каталог — це вже metadata/
    if (await fileExists(handle, "project.meta.json")) {
      metadataDir = handle
    } else {
      throw new Error(
        "Cannot find project.meta.json. Please select a valid project directory."
      )
    }
  }

  // Рекурсивне читання файлів (max depth 4 — достатньо для BRD структури)
  const MAX_DEPTH = 4
  async function readDir(
    dir: FileSystemDirectoryHandle,
    prefix: string,
    depth: number
  ): Promise<void> {
    if (depth > MAX_DEPTH) return
    for await (const [name, entry] of dir.entries()) {
      const fullPath = prefix ? `${prefix}/${name}` : name
      if (entry.kind === "file" && (name.endsWith(".meta.json") || name.endsWith(".form.json"))) {
        const file = await entry.getFile()
        files.set(fullPath, await file.text())
      } else if (entry.kind === "directory") {
        await readDir(entry, fullPath, depth + 1)
      }
    }
  }

  await readDir(metadataDir, "", 0)
  return files
}

// --- ZIP helpers ---

function filesToZipEntries(files: FileEntry[]): Record<string, Uint8Array> {
  const encoder = new TextEncoder()
  const entries: Record<string, Uint8Array> = {}
  for (const file of files) {
    entries[`metadata/${file.path}`] = encoder.encode(file.content)
  }
  return entries
}

function unzipEntries(data: Uint8Array): Promise<Map<string, string>> {
  return new Promise((resolve, reject) => {
    unzip(data, (err, entries) => {
      if (err) {
        reject(err)
        return
      }
      const decoder = new TextDecoder()
      const files = new Map<string, string>()
      for (const [entryPath, content] of Object.entries(entries)) {
        // Захист від path traversal в ZIP
        if (entryPath.includes("..") || entryPath.startsWith("/")) continue

        // Видалити metadata/ префікс якщо є
        const normalizedPath = entryPath.startsWith("metadata/")
          ? entryPath.slice("metadata/".length)
          : entryPath
        if (normalizedPath && (normalizedPath.endsWith(".meta.json") || normalizedPath.endsWith(".form.json"))) {
          files.set(normalizedPath, decoder.decode(content))
        }
      }
      resolve(files)
    })
  })
}

function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

const MAX_IMPORT_SIZE = 50 * 1024 * 1024 // 50 MB

function pickFile(accept: string): Promise<File> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input")
    input.type = "file"
    input.accept = accept
    input.addEventListener("change", () => {
      const file = input.files?.[0]
      if (!file) {
        reject(new Error("No file selected"))
        return
      }
      if (file.size > MAX_IMPORT_SIZE) {
        reject(
          new Error(
            `File too large (${Math.round(file.size / 1024 / 1024)} MB). Maximum: 50 MB.`
          )
        )
        return
      }
      resolve(file)
    })
    input.click()
  })
}

// --- WebStorage: реалізація StorageProvider ---

export class WebStorage implements StorageProvider {
  async openProject(): Promise<OpenResult> {
    if (hasFileSystemAccess()) {
      return this.openFromDirectory()
    }
    return this.openFromZip()
  }

  async saveProject(
    model: ProjectModel,
    handle?: FileSystemDirectoryHandle
  ): Promise<OpenProjectResult> {
    if (hasFileSystemAccess()) {
      return this.saveToDirectory(model, handle)
    }
    // Fallback: download як ZIP
    await this.exportProject(model)
    return { model }
  }

  async exportProject(model: ProjectModel): Promise<void> {
    const files = serializeToFiles(model)
    const entries = filesToZipEntries(files)

    const data = await new Promise<Uint8Array<ArrayBuffer>>(
      (resolve, reject) => {
        zip(entries, { level: 6 }, (err, result) => {
          if (err) reject(err)
          else resolve(result as Uint8Array<ArrayBuffer>)
        })
      }
    )

    const blob = new Blob([data], { type: "application/zip" })
    const projectName = toKebabCase(model.project.name)
    downloadBlob(blob, `${projectName}.simetra.zip`)
  }

  async importProject(): Promise<OpenResult> {
    return this.openFromZip()
  }

  /** Відкрити проєкт із вже відомого handle (для restore session) */
  async openFromHandle(handle: FileSystemDirectoryHandle): Promise<OpenResult> {
    const fileMap = await readFromDirectory(handle)
    const { parsed, warnings: parseWarnings } = parseMetadataFiles(fileMap)
    const { model, warnings: validationWarnings } = buildProjectModelFromParsed(parsed)

    return {
      model,
      handle,
      warnings: localizeWarnings([...parseWarnings, ...validationWarnings]),
    }
  }

  // --- Private: File System Access API ---

  private async openFromDirectory(): Promise<OpenResult> {
    const handle = await window.showDirectoryPicker({ mode: "readwrite" })
    const fileMap = await readFromDirectory(handle)
    const { parsed, warnings: parseWarnings } = parseMetadataFiles(fileMap)
    const { model, warnings: validationWarnings } = buildProjectModelFromParsed(parsed)

    return {
      model,
      handle,
      warnings: localizeWarnings([...parseWarnings, ...validationWarnings]),
    }
  }

  private async saveToDirectory(
    model: ProjectModel,
    existingHandle?: FileSystemDirectoryHandle
  ): Promise<OpenProjectResult> {
    const handle =
      existingHandle ??
      (await window.showDirectoryPicker({ mode: "readwrite" }))
    await saveToDirectory(model, handle)
    return { model, handle }
  }

  // --- Private: ZIP fallback ---

  private async openFromZip(): Promise<OpenResult> {
    const file = await pickFile(".zip")
    const buffer = await file.arrayBuffer()
    const data = new Uint8Array(buffer)
    const fileMap = await unzipEntries(data)
    const { parsed, warnings: parseWarnings } = parseMetadataFiles(fileMap)
    const { model, warnings: validationWarnings } = buildProjectModelFromParsed(parsed)

    return {
      model,
      warnings: localizeWarnings([...parseWarnings, ...validationWarnings]),
    }
  }
}
