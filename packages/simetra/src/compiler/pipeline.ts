import { KIND_REGISTRY, METADATA_KINDS } from "simetra/model"
import type {
  CompileResult,
  CompiledModel,
  CompiledScopeKind,
  SourceObject,
} from "./compile"
import { compareStrings, sortDiagnostics, type Diagnostic } from "./diagnostics"
import { modelHash } from "./canonical"
import { buildContracts } from "./contracts"
import { buildPresentation } from "./presentation"
import { readFiles, type FilesStageResult } from "./stages/files"
import { checkIdentity } from "./stages/identity"
import { checkIntegrity } from "./stages/integrity"
import { checkLinks } from "./stages/links"
import { buildModel, enumTypeOf, rowTypesOf } from "./stages/model"
import { buildMovementFunctions } from "./movement-functions"
import { checkSqlModules } from "./sql/closed-forms"
import { creationOrder } from "./sql/dependencies"
import { loadSqlParser } from "./sql/parse"
import {
  namespaceConflicts,
  readSqlUnits,
  type SqlSource,
  type SqlUnit,
  type VerbatimUnit,
} from "./sql/units"

// Внутрішній модуль: з `simetra/compiler` не експортується, публічні двері —
// лише `compile()`.
export { readFiles }

/**
 * Стадії 2–5 і вихід над результатом стадії 1. Шов між `readFiles` і
 * `runStages` — межа «розібрані дані → їхні читачі»: ратчет «поле без
 * споживача» стоїть саме тут і бачить, які поля схем хтось прочитав.
 */
export async function runStages(
  stage1: FilesStageResult
): Promise<CompileResult> {
  const parse = await loadSqlParser()
  const stage2 = checkIdentity(
    stage1.objects,
    stage1.brokenNames,
    stage1.project
  )
  const upstream = [...stage1.diagnostics, ...stage2.diagnostics]
  // Стадії 3–4 спираються на резолвлені посилання й наявні id та
  // physicalName, тож на зламаній моделі не запускаються. Стадія 3 бігає до
  // розбору `.sql`: типи рядків таблиць потрібні ідентичності аргументів.
  const stage3 =
    stage1.project === undefined || hasErrors(upstream)
      ? undefined
      : buildModel(stage1.objects, stage1.project, stage2.references)
  // Некваліфіковані імена `.sql` беруть схему проєкту, тож без валідного
  // проєкту одиниць немає: його помилку вже названо.
  const sql =
    stage1.project === undefined
      ? { units: [], diagnostics: [] }
      : readSqlUnits(sqlSources(stage1, stage1.project.defaultSchema), parse, [
          ...enumTypes(stage1, stage1.project.defaultSchema),
          ...(stage3 === undefined ? [] : rowTypesOf(stage3.physical)),
        ])
  // Модуль виду 1С звужено до закритих форм: вид власника одиниці — з її
  // `ownerFile`, тож перевірка не чекає моделі стадії 3.
  const early = [
    ...upstream,
    ...sql.diagnostics,
    ...checkSqlModules(stage1.objects, sql.units),
  ]
  if (
    hasErrors(early) ||
    stage1.project === undefined ||
    stage3 === undefined
  ) {
    return { ok: false, diagnostics: sortDiagnostics(early) }
  }

  const diagnostics = sortDiagnostics([
    ...early,
    ...checkIntegrity(
      stage1.objects,
      stage2.references,
      stage3,
      stage1.project.naming.attributeCase,
      stage1.project.scopeKinds,
      sql.units,
      stage1.project.database.provider
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
  const module = projectModule
  const sqlUnits = [
    ...sql.units.map((unit) => verbatimUnit(unit, ownerId, module)),
    ...wrappers,
  ].sort((a, b) => compareStrings(a.identity, b.identity))
  const nameById = new Map(stage1.objects.map((o) => [o.id ?? "", o.name]))
  const collisions = namespaceConflicts(
    stage3.physical,
    sqlUnits,
    (unit) =>
      `the movement query of ${nameById.get(unit.documentId ?? "")} into ${nameById.get(unit.registerId ?? "")}`
  )
  if (collisions.length > 0) {
    return {
      ok: false,
      diagnostics: sortDiagnostics([...diagnostics, ...collisions]),
    }
  }
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
      stage3.elementChecks,
      stage1.project
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
  defaultSchema: string
): SqlSource[] {
  const objectSchema = new Map(
    stage1.objects.map((o) => [
      o.file,
      (o.data as { schema?: string }).schema ?? defaultSchema,
    ])
  )
  return stage1.sqlFiles.map(({ file, text, ownerFile, schema }) => ({
    file,
    text,
    schema:
      schema ??
      (ownerFile === undefined ? undefined : objectSchema.get(ownerFile)) ??
      defaultSchema,
    ...(ownerFile === undefined ? {} : { ownerFile }),
  }))
}

/**
 * Енам-типи знімка для резолву некваліфікованих типів аргументів: стадія 3
 * ще не бігла, тож схема й ім'я — тим самим правилом, що в неї.
 */
function enumTypes(
  stage1: FilesStageResult,
  defaultSchema: string
): { schema: string; name: string }[] {
  return stage1.objects.flatMap((object) => {
    const type = enumTypeOf(object, defaultSchema)
    return type === undefined ? [] : [type]
  })
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
