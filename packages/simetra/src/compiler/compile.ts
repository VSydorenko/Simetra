import {
  METADATA_KINDS,
  type MetadataKind,
  type PhysicalSnapshot,
  type Project,
} from "simetra/model"
import { compareStrings, sortDiagnostics, type Diagnostic } from "./diagnostics"
import { readFiles } from "./stages/files"
import { checkIdentity, type ResolvedReference } from "./stages/identity"

export interface SourceObject {
  id: string
  kind: MetadataKind
  name: string
  file: string
  /** Вихід Zod-схеми виду. */
  data: unknown
}

export interface CompiledModel {
  project: Project
  /** Порядок METADATA_KINDS, далі ім'я. */
  objects: SourceObject[]
  /** За (file, pointer). */
  references: ResolvedReference[]
  sqlFiles: { file: string; ownerObjectId?: string; schema?: string }[]
  moduleFiles: { file: string; ownerObjectId: string }[]
  physical: PhysicalSnapshot
}

export interface CompileResult {
  ok: boolean
  diagnostics: Diagnostic[]
  /** Лише коли прогін без помилок: наступні шари не бачать напівмоделі. */
  model?: CompiledModel
}

/**
 * Компілятор — чиста функція над мапою «шлях відносно `metadata/` → вміст»
 * (спека П2 §8.2): читання диска — справа CLI, тож одна реалізація служить
 * CLI, MCP, тестам і студії. Повертає всі діагностики прогону, а не першу.
 */
export function compile(files: ReadonlyMap<string, string>): CompileResult {
  const stage1 = readFiles(files)
  const stage2 = checkIdentity(
    stage1.objects,
    stage1.brokenNames,
    stage1.project
  )
  const diagnostics = sortDiagnostics([
    ...stage1.diagnostics,
    ...stage2.diagnostics,
  ])
  const ok = !diagnostics.some((d) => d.severity === "error")
  if (!ok || stage1.project === undefined) return { ok, diagnostics }

  // Без помилок стадії 2 id є в кожного об'єкта.
  const idByFile = new Map(stage1.objects.map((o) => [o.file, o.id ?? ""]))
  const ownerId = (ownerFile: string) => idByFile.get(ownerFile) ?? ""

  const objects = stage1.objects
    .map(({ id, kind, name, file, data }) => ({
      id: id ?? "",
      kind,
      name,
      file,
      data,
    }))
    .sort(
      (a, b) =>
        METADATA_KINDS.indexOf(a.kind) - METADATA_KINDS.indexOf(b.kind) ||
        compareStrings(a.name, b.name)
    )

  return {
    ok,
    diagnostics,
    model: {
      project: stage1.project,
      objects,
      references: stage2.references,
      sqlFiles: stage1.sqlFiles
        .map(({ file, ownerFile, schema }) =>
          ownerFile !== undefined
            ? { file, ownerObjectId: ownerId(ownerFile) }
            : { file, schema: schema ?? "" }
        )
        .sort((a, b) => compareStrings(a.file, b.file)),
      moduleFiles: stage1.moduleFiles
        .map(({ file, ownerFile }) => ({
          file,
          ownerObjectId: ownerId(ownerFile),
        }))
        .sort((a, b) => compareStrings(a.file, b.file)),
      // Фізичний знімок будує стадія 3.
      physical: { tables: [], enumTypes: [] },
    },
  }
}
