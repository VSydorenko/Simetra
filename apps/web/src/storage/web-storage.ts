import type { MetadataKind, MetadataObject, ProjectModel } from "@simetra/core"
import {
  serializeMetadataObject,
  serializeProject,
  enrichSchemaUrl,
  enrichProjectSchemaUrl,
  buildConstantsSchemaUrl,
  projectModelSchema,
  metadataObjectSchema,
  projectSchema,
  constantSchema,
} from "@simetra/core"
import { unzip, zip } from "fflate"
import type {
  FileValidationError,
  OpenResult,
  OpenProjectResult,
  StorageProvider,
} from "./storage-provider"

// Маппінг MetadataKind → назва каталогу (BRD §7.2)
const KIND_TO_DIR: Record<MetadataKind, string> = {
  Catalog: "catalogs",
  Document: "documents",
  Enumeration: "enumerations",
  InformationRegister: "information-registers",
  AccumulationRegister: "accumulation-registers",
  Constant: "constants",
  CustomTable: "custom-tables",
}

// Зворотній маппінг: назва каталогу → MetadataKind
const DIR_TO_KIND: Record<string, MetadataKind> = Object.fromEntries(
  Object.entries(KIND_TO_DIR).map(([k, v]) => [v, k as MetadataKind])
) as Record<string, MetadataKind>

// Ключі ProjectModel → MetadataKind
const MODEL_KEY_TO_KIND: Record<string, MetadataKind> = {
  catalogs: "Catalog",
  documents: "Document",
  enumerations: "Enumeration",
  informationRegisters: "InformationRegister",
  accumulationRegisters: "AccumulationRegister",
  constants: "Constant",
  customTables: "CustomTable",
}

/** PascalCase → kebab-case: SalesOrder → sales-order */
export function toKebabCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1-$2")
    .toLowerCase()
}

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

// --- Серіалізація ProjectModel → файлова структура ---

interface FileEntry {
  path: string
  content: string
}

/** Серіалізувати ProjectModel у масив файлів (path → content) */
export function serializeToFiles(model: ProjectModel): FileEntry[] {
  const files: FileEntry[] = []
  const schemaVersion = model.project.schemaVersion

  // project.meta.json — enrich $schema before serialization
  const enrichedProject = enrichProjectSchemaUrl(model.project, schemaVersion)
  files.push({
    path: "project.meta.json",
    content: serializeProject(enrichedProject),
  })

  // Кожен тип метаданих
  for (const [modelKey, kind] of Object.entries(MODEL_KEY_TO_KIND)) {
    const objects = model[modelKey as keyof ProjectModel] as MetadataObject[]
    if (!objects || objects.length === 0) continue

    const dirName = KIND_TO_DIR[kind]

    if (kind === "Constant") {
      // Усі константи — в одному файлі, object wrapper (BRD §7.2 + §7.6)
      const enrichedConstants = objects.map((obj) =>
        enrichSchemaUrl(obj, schemaVersion)
      )
      const serializedItems = enrichedConstants.map((obj) =>
        serializeMetadataObject(obj).trimEnd()
      )
      const indentedItems = serializedItems.map((item) =>
        item
          .split("\n")
          .map((line) => "    " + line)
          .join("\n")
      )
      const constantsJson =
        "{\n" +
        `  "$schema": "${buildConstantsSchemaUrl(schemaVersion)}",\n` +
        '  "constants": [\n' +
        indentedItems.join(",\n") +
        "\n  ]\n}\n"
      files.push({
        path: `${dirName}/constants.meta.json`,
        content: constantsJson,
      })
    } else {
      // Один файл на обʼєкт — enrich $schema
      for (const obj of objects) {
        const enriched = enrichSchemaUrl(obj, schemaVersion)
        const kebabName = toKebabCase(obj.name)
        files.push({
          path: `${dirName}/${kebabName}/${kebabName}.meta.json`,
          content: serializeMetadataObject(enriched),
        })
      }
    }
  }

  return files
}

// --- Десеріалізація файлової структури → ProjectModel ---

interface ParsedFiles {
  project?: unknown
  objects: { kind: MetadataKind; data: unknown; filePath: string }[]
}

function parseFileStructure(files: Map<string, string>): {
  parsed: ParsedFiles
  warnings: FileValidationError[]
} {
  const warnings: FileValidationError[] = []
  const parsed: ParsedFiles = { objects: [] }

  for (const [path, content] of files) {
    // project.meta.json
    if (path === "project.meta.json") {
      try {
        parsed.project = JSON.parse(content)
      } catch (e) {
        warnings.push({
          filePath: path,
          errors: [
            `Invalid JSON: ${e instanceof Error ? e.message : String(e)}`,
          ],
        })
      }
      continue
    }

    // Визначити тип за назвою каталогу
    const parts = path.split("/")
    if (parts.length < 2) continue

    const dirName = parts[0]
    const kind = DIR_TO_KIND[dirName]
    if (!kind) continue

    // Файл має закінчуватись на .meta.json
    const fileName = parts[parts.length - 1]
    if (!fileName.endsWith(".meta.json")) continue

    try {
      const data = JSON.parse(content)

      if (kind === "Constant") {
        // constants.meta.json — object wrapper or legacy array (backward compat)
        const items = Array.isArray(data)
          ? data
          : data && typeof data === "object" && "constants" in data && Array.isArray((data as Record<string, unknown>).constants)
            ? (data as Record<string, unknown>).constants as unknown[]
            : null
        if (items) {
          for (const item of items) {
            parsed.objects.push({ kind, data: item, filePath: path })
          }
        } else {
          parsed.objects.push({ kind, data, filePath: path })
        }
      } else {
        parsed.objects.push({ kind, data, filePath: path })
      }
    } catch (e) {
      warnings.push({
        filePath: path,
        errors: [`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`],
      })
    }
  }

  return { parsed, warnings }
}

function buildProjectModel(parsed: ParsedFiles): {
  model: ProjectModel
  warnings: FileValidationError[]
} {
  const warnings: FileValidationError[] = []

  // Валідація project
  let project
  if (parsed.project) {
    const result = projectSchema.safeParse(parsed.project)
    if (result.success) {
      project = result.data
    } else {
      warnings.push({
        filePath: "project.meta.json",
        errors: result.error.issues.map(
          (i) => `${i.path.join(".")}: ${i.message}`
        ),
      })
    }
  }

  if (!project) {
    throw new Error("project.meta.json is missing or invalid")
  }

  // Валідація обʼєктів по типах
  const collections: Record<string, MetadataObject[]> = {
    catalogs: [],
    documents: [],
    enumerations: [],
    informationRegisters: [],
    accumulationRegisters: [],
    constants: [],
    customTables: [],
  }

  const kindToKey: Record<MetadataKind, string> = {
    Catalog: "catalogs",
    Document: "documents",
    Enumeration: "enumerations",
    InformationRegister: "informationRegisters",
    AccumulationRegister: "accumulationRegisters",
    Constant: "constants",
    CustomTable: "customTables",
  }

  for (const { kind, data, filePath } of parsed.objects) {
    const schema = kind === "Constant" ? constantSchema : metadataObjectSchema
    const result = schema.safeParse(data)
    if (result.success) {
      const key = kindToKey[kind]
      collections[key].push(result.data as MetadataObject)
    } else {
      warnings.push({
        filePath,
        errors: result.error.issues.map(
          (i) => `${i.path.join(".")}: ${i.message}`
        ),
      })
    }
  }

  const model = projectModelSchema.parse({
    project,
    ...collections,
  })

  return { model, warnings }
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
      if (entry.kind === "file" && name.endsWith(".meta.json")) {
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
        if (normalizedPath && normalizedPath.endsWith(".meta.json")) {
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
    const { parsed, warnings: parseWarnings } = parseFileStructure(fileMap)
    const { model, warnings: validationWarnings } = buildProjectModel(parsed)

    return {
      model,
      handle,
      warnings: [...parseWarnings, ...validationWarnings],
    }
  }

  // --- Private: File System Access API ---

  private async openFromDirectory(): Promise<OpenResult> {
    const handle = await window.showDirectoryPicker({ mode: "readwrite" })
    const fileMap = await readFromDirectory(handle)
    const { parsed, warnings: parseWarnings } = parseFileStructure(fileMap)
    const { model, warnings: validationWarnings } = buildProjectModel(parsed)

    return {
      model,
      handle,
      warnings: [...parseWarnings, ...validationWarnings],
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
    const { parsed, warnings: parseWarnings } = parseFileStructure(fileMap)
    const { model, warnings: validationWarnings } = buildProjectModel(parsed)

    return {
      model,
      warnings: [...parseWarnings, ...validationWarnings],
    }
  }
}
