import {
  METADATA_KINDS,
  type MetadataKind,
  type PhysicalSnapshot,
  type Project,
} from "simetra/model"
import { compareStrings, sortDiagnostics, type Diagnostic } from "./diagnostics"
import { buildContracts, type Contracts } from "./contracts"
import { readFiles } from "./stages/files"
import { checkIdentity, type ResolvedReference } from "./stages/identity"
import { checkIntegrity } from "./stages/integrity"
import { checkLinks } from "./stages/links"
import { buildModel } from "./stages/model"
import { buildMovementFunctions, type SqlUnit } from "./movement-functions"

export interface SourceObject {
  id: string
  kind: MetadataKind
  name: string
  file: string
  /** Вихід Zod-схеми виду. */
  data: unknown
  /** Вид скоупу об'єкта; відсутній — «без скоупу» (`none`, поле або вид без скоупу). */
  scopeKindId?: string
}

export interface CompiledScopeKind {
  id: string
  name: string
  physicalName: string
  root:
    | { objectId: string }
    | { external: { schema: string; table: string; column: string } }
  setFunction: { schema: string; name: string }
  onRootDelete: "restrict" | "cascade"
}

export interface CompiledModel {
  project: Project
  /** Порядок METADATA_KINDS, далі ім'я. */
  objects: SourceObject[]
  /** За `name`. */
  scopeKinds: CompiledScopeKind[]
  /** За (file, pointer). */
  references: ResolvedReference[]
  sqlFiles: { file: string; ownerObjectId?: string; schema?: string }[]
  moduleFiles: { file: string; ownerObjectId: string }[]
  physical: PhysicalSnapshot
  /** За `(schema, name)`. */
  sqlUnits: SqlUnit[]
  contracts: Contracts
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
  const early = [...stage1.diagnostics, ...stage2.diagnostics]
  // Стадії 3–4 спираються на резолвлені посилання й наявні id та
  // physicalName, тож на зламаній моделі не запускаються.
  if (hasErrors(early) || stage1.project === undefined) {
    return { ok: false, diagnostics: sortDiagnostics(early) }
  }

  const stage3 = buildModel(stage1.objects, stage1.project)
  const diagnostics = sortDiagnostics([
    ...early,
    ...checkIntegrity(
      stage1.objects,
      stage2.references,
      stage3,
      stage1.project.naming.attributeCase,
      stage1.project.scopeKinds
    ),
    ...checkLinks(stage1.objects, stage2.references),
  ])
  const ok = !hasErrors(diagnostics)
  if (!ok) return { ok, diagnostics }

  // Без помилок стадії 2 id є в кожного об'єкта.
  const idByFile = new Map(stage1.objects.map((o) => [o.file, o.id ?? ""]))
  const ownerId = (ownerFile: string) => idByFile.get(ownerFile) ?? ""

  const scopeKindIdByFile = new Map<string, string>()
  const rootIdByPointer = new Map<string, string>()
  for (const { role, from, to } of stage2.references) {
    if (role === "object.scope") scopeKindIdByFile.set(from.file, to.id)
    if (role === "scopeKind.root") rootIdByPointer.set(from.pointer, to.id)
  }
  const { defaultSchema } = stage1.project
  const scopeKinds = stage1.project.scopeKinds
    .map((kind, index): CompiledScopeKind => ({
      id: kind.id ?? "",
      name: kind.name,
      physicalName: kind.physicalName ?? "",
      root:
        "object" in kind.root
          ? {
              objectId:
                rootIdByPointer.get(`/scopeKinds/${index}/root/object`) ?? "",
            }
          : { external: kind.root.external },
      setFunction: {
        schema: kind.setFunction.schema ?? defaultSchema,
        name: kind.setFunction.name,
      },
      onRootDelete: kind.onRootDelete,
    }))
    .sort((a, b) => compareStrings(a.name, b.name))

  const objects = stage1.objects
    .map(({ id, kind, name, file, data }): SourceObject => {
      const scopeKindId = scopeKindIdByFile.get(file)
      return {
        id: id ?? "",
        kind,
        name,
        file,
        data,
        ...(scopeKindId !== undefined ? { scopeKindId } : {}),
      }
    })
    .sort(
      (a, b) =>
        METADATA_KINDS.indexOf(a.kind) - METADATA_KINDS.indexOf(b.kind) ||
        compareStrings(a.name, b.name)
    )

  const sqlUnits = buildMovementFunctions(
    stage1.objects,
    stage2.references,
    stage3.physical,
    stage1.project
  )
  return {
    ok,
    diagnostics,
    model: {
      project: stage1.project,
      objects,
      scopeKinds,
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
      physical: stage3.physical,
      sqlUnits,
      contracts: buildContracts(
        stage1.objects,
        stage3.physical,
        stage1.project.naming.attributeCase,
        sqlUnits
      ),
    },
  }
}

function hasErrors(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === "error")
}
