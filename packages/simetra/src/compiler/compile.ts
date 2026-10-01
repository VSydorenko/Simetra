import {
  KIND_REGISTRY,
  METADATA_KINDS,
  type MetadataKind,
  type PhysicalSnapshot,
  type Project,
} from "simetra/model"
import { compareStrings, sortDiagnostics, type Diagnostic } from "./diagnostics"
import { withRanges } from "./locate"
import { modelHash } from "./canonical"
import { buildContracts, type Contracts } from "./contracts"
import { buildPresentation, type Presentation } from "./presentation"
import { readFiles } from "./stages/files"
import { checkIdentity, type ResolvedReference } from "./stages/identity"
import { checkIntegrity } from "./stages/integrity"
import { checkLinks } from "./stages/links"
import { buildModel } from "./stages/model"
import { buildMovementFunctions } from "./movement-functions"
import { creationOrder, type CreationNode } from "./sql/dependencies"
import { loadSqlParser } from "./sql/parse"
import {
  generatedDuplicates,
  readSqlUnits,
  type SqlSource,
  type SqlUnit,
  type VerbatimUnit,
} from "./sql/units"
import type { FilesStageResult } from "./stages/files"

export interface SourceObject {
  id: string
  kind: MetadataKind
  name: string
  file: string
  /** Модуль об'єкта: один неявний модуль з іменем проєкту. */
  module: string
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
  /** Один неявний модуль з іменем проєкту; за `name`. */
  modules: { name: string }[]
  /** Дії над кожним об'єктом з реєстру видів; за `objectId`. */
  actions: { objectId: string; actions: readonly string[] }[]
  /** За `name`. */
  scopeKinds: CompiledScopeKind[]
  /** За (file, pointer). */
  references: ResolvedReference[]
  moduleFiles: { file: string; ownerObjectId: string }[]
  physical: PhysicalSnapshot
  /** Дослівні одиниці `.sql` і обгортки запитів рухів; за `identity`. */
  sqlUnits: SqlUnit[]
  /**
   * Спільний порядок створення енам-типів, таблиць і одиниць: розширення
   * перші, далі топологічно з tie-break (тип вузла, схема, ім'я/ідентичність).
   */
  creationOrder: CreationNode[]
  contracts: Contracts
  /** За `objectId`; лише об'єкти з полями подання. */
  presentation: Presentation
  /** Hex sha256 канонічного знімка (RFC 8785); його звіряє П3. */
  hash: string
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
 * Асинхронна, бо парсер Postgres — WASM, який вантажиться один раз на процес.
 */
export async function compile(
  files: ReadonlyMap<string, string>
): Promise<CompileResult> {
  const result = await runStages(files)
  // Діапазони дописуються в одному місці, а не стадіями: стадії знають лише
  // pointer, а текст файлу їм не потрібен.
  return {
    ...result,
    diagnostics: withRanges(result.diagnostics, files),
  }
}

async function runStages(
  files: ReadonlyMap<string, string>
): Promise<CompileResult> {
  const parse = await loadSqlParser()
  const stage1 = readFiles(files)
  const stage2 = checkIdentity(
    stage1.objects,
    stage1.brokenNames,
    stage1.project
  )
  // Некваліфіковані імена `.sql` беруть схему проєкту, тож без валідного
  // проєкту одиниць немає: його помилку вже названо.
  const sql =
    stage1.project === undefined
      ? { units: [], diagnostics: [] }
      : readSqlUnits(
          sqlSources(stage1, files, stage1.project.defaultSchema),
          parse
        )
  const early = [
    ...stage1.diagnostics,
    ...stage2.diagnostics,
    ...sql.diagnostics,
  ]
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
      stage1.project.scopeKinds,
      sql.units
    ),
    ...checkLinks(
      stage1.objects,
      stage2.references,
      stage1.project,
      sql.units,
      parse
    ),
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

  const projectModule = stage1.project.name
  const objects = stage1.objects
    .map(({ id, kind, name, file, data }): SourceObject => {
      const scopeKindId = scopeKindIdByFile.get(file)
      return {
        id: id ?? "",
        kind,
        name,
        file,
        module: projectModule,
        data,
        ...(scopeKindId !== undefined ? { scopeKindId } : {}),
      }
    })
    .sort(
      (a, b) =>
        METADATA_KINDS.indexOf(a.kind) - METADATA_KINDS.indexOf(b.kind) ||
        compareStrings(a.name, b.name)
    )

  const wrappers = buildMovementFunctions(
    stage1.objects,
    stage2.references,
    stage3.physical,
    stage1.project,
    parse
  )
  const nameById = new Map(stage1.objects.map((o) => [o.id ?? "", o.name]))
  const collisions = generatedDuplicates(
    sql.units,
    new Map(
      wrappers.map((w) => [
        w.identity,
        `the movement query of ${nameById.get(w.documentId)} into ${nameById.get(w.registerId)}`,
      ])
    )
  )
  if (collisions.length > 0) {
    return {
      ok: false,
      diagnostics: sortDiagnostics([...diagnostics, ...collisions]),
    }
  }
  const module = projectModule
  const sqlUnits = [
    ...sql.units.map((unit) => verbatimUnit(unit, ownerId, module)),
    ...wrappers,
  ].sort((a, b) => compareStrings(a.identity, b.identity))
  const fileById = new Map(stage1.objects.map((o) => [o.id ?? "", o.file]))
  const ordered = creationOrder(
    stage3.physical,
    sqlUnits,
    parse,
    // Обгортка рухів файлу не має: цикл через неї названо в документі.
    (unit) => unit.file ?? fileById.get(unit.ownerObjectId ?? "") ?? ""
  )
  if (ordered.diagnostics.length > 0) {
    return {
      ok: false,
      diagnostics: sortDiagnostics([...diagnostics, ...ordered.diagnostics]),
    }
  }
  const model: Omit<CompiledModel, "hash"> = {
    project: stage1.project,
    objects,
    modules: [{ name: stage1.project.name }],
    actions: objects
      .map((o) => ({
        objectId: o.id,
        actions: KIND_REGISTRY[o.kind].actions,
      }))
      .sort((a, b) => compareStrings(a.objectId, b.objectId)),
    scopeKinds,
    references: stage2.references,
    moduleFiles: stage1.moduleFiles
      .map(({ file, ownerFile }) => ({
        file,
        ownerObjectId: ownerId(ownerFile),
      }))
      .sort((a, b) => compareStrings(a.file, b.file)),
    physical: stage3.physical,
    sqlUnits,
    creationOrder: ordered.order,
    contracts: buildContracts(
      stage1.objects,
      stage3.physical,
      stage1.project.naming.attributeCase,
      sqlUnits,
      stage1.project.timezone,
      stage3.requiredChecks
    ),
    presentation: buildPresentation(
      stage1.objects,
      stage1.project.naming.attributeCase,
      stage1.project.defaultLocale
    ),
  }
  return { ok, diagnostics, model: { ...model, hash: await modelHash(model) } }
}

/**
 * `.sql` до розбору: спільний файл бере схему з теки, файл об'єкта — схему
 * самого об'єкта (поле заголовка) або схему проєкту.
 */
function sqlSources(
  stage1: FilesStageResult,
  files: ReadonlyMap<string, string>,
  defaultSchema: string
): SqlSource[] {
  const objectSchema = new Map(
    stage1.objects.map((o) => [
      o.file,
      (o.data as { schema?: string }).schema ?? defaultSchema,
    ])
  )
  return stage1.sqlFiles.map(({ file, ownerFile, schema }) => ({
    file,
    text: files.get(file) ?? "",
    schema:
      schema ??
      (ownerFile === undefined ? undefined : objectSchema.get(ownerFile)) ??
      defaultSchema,
    ...(ownerFile === undefined ? {} : { ownerFile }),
  }))
}

function verbatimUnit(
  unit: VerbatimUnit,
  ownerId: (ownerFile: string) => string,
  module: string
): SqlUnit {
  return {
    class: unit.class,
    identity: unit.identity,
    schema: unit.schema,
    name: unit.name,
    file: unit.file,
    line: unit.line,
    ...(unit.ownerFile === undefined
      ? {}
      : { ownerObjectId: ownerId(unit.ownerFile) }),
    module,
    sql: unit.sql,
    tree: unit.tree,
  }
}

function hasErrors(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === "error")
}
