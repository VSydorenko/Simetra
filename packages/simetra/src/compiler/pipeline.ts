import {
  KIND_REGISTRY,
  METADATA_KINDS,
  PROVIDER_IDENTITY_SOURCES,
} from "simetra/model"
import type {
  CompileResult,
  CompiledModel,
  CompiledScopeKind,
  SourceObject,
} from "./compile"
import { compareStrings, sortDiagnostics, type Diagnostic } from "./diagnostics"
import { modelHash } from "./canonical"
import { buildContracts, usersContractOf } from "./contracts"
import { buildPresentation } from "./presentation"
import { readFiles, type FilesStageResult } from "./stages/files"
import { checkIdentity } from "./stages/identity"
import { checkIntegrity } from "./stages/integrity"
import { checkLinks } from "./stages/links"
import { buildModel, enumTypeOf, rowTypesOf } from "./stages/model"
import { buildMovementFunctions } from "./movement-functions"
import { buildMembershipFunctions, membershipsOf } from "./membership-functions"
import { buildPlatformUnits } from "./platform/units"
import { checkSqlModules, closedModuleOwners } from "./sql/closed-forms"
import { creationOrder } from "./sql/dependencies"
import { checkDebt } from "./sql/debt"
import { loadSqlParser, type SqlParser } from "./sql/parse"
import { embedRowRules } from "./sql/row-rule"
import { withoutPlatformSchema } from "./sql/reserved-schema"
import {
  namespaceConflicts,
  readSqlUnits,
  type SqlSource,
  type SqlUnit,
  type UnitGenerator,
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
  const { stage2, upstream, stage3, sql } = sqlStage(stage1, parse)
  // id є в кожного об'єкта, лише коли стадія 2 чиста; її помилки закривають
  // шлях до вкладення правил і далі, тож порожнє id сюди не доходить.
  const idByFile = new Map(stage1.objects.map((o) => [o.file, o.id ?? ""]))
  const ownerId = (ownerFile: string) => idByFile.get(ownerFile) ?? ""
  // Правило рядка модуля виду — CHECK таблиці у знімку, а не одиниця: його
  // вкладено до стадії 4, тож цілісність, залежності, рендер і хеш бачать одну
  // правду про таблицю. Правило поза модулем виду вже назване нижче.
  const owners = closedModuleOwners(stage1.objects)
  const embedded =
    stage3 === undefined
      ? undefined
      : embedRowRules(
          stage3.physical,
          sql.rowRules.filter(
            (r) => r.ownerFile !== undefined && owners.has(r.ownerFile)
          ),
          (ownerFile) => idByFile.get(ownerFile)
        )
  // Ратчет боргу судить лише повні одиниці: без стадії 3 ідентичності
  // функцій (типи рядків) неповні, і `sql.debt-grows` на вже зламаній
  // компіляції був би шумом.
  const debt =
    stage1.sqlDebt === undefined || stage3 === undefined
      ? { grows: [], stale: [] }
      : checkDebt(
          sql.units,
          stage1.objects,
          stage1.project,
          stage1.sqlDebt,
          !sql.diagnostics.some((d) => d.code === "sql.parse")
        )
  // Модуль виду 1С звужено до закритих форм: вид власника одиниці — з її
  // `ownerFile`, тож перевірка не чекає моделі стадії 3.
  const early = [
    ...upstream,
    ...sql.diagnostics,
    ...checkSqlModules(stage1.objects, sql.units, sql.rowRules),
    ...debt.grows,
    ...(embedded?.diagnostics ?? []),
  ]
  if (
    hasErrors(early) ||
    stage1.project === undefined ||
    stage3 === undefined ||
    embedded === undefined
  ) {
    return {
      ok: false,
      diagnostics: sortDiagnostics([...early, ...debt.stale]),
    }
  }
  const physical = embedded.physical

  const diagnostics = sortDiagnostics([
    ...early,
    ...debt.stale,
    ...checkIntegrity(
      stage1.objects,
      stage2.references,
      { ...stage3, physical },
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

  const scopeKindIdByFile = new Map<string, string>()
  const rootIdByPointer = new Map<string, string>()
  for (const { role, from, to } of stage2.references) {
    if (role === "object.scope") scopeKindIdByFile.set(from.file, to.id)
    if (role === "scopeKind.root") rootIdByPointer.set(from.pointer, to.id)
  }
  const { defaultSchema } = stage1.project
  const memberships = membershipsOf(stage1.objects, physical, stage1.project)
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
      // `membership` — функція, згенерована з довідника членства виду;
      // стадія 5 гарантує, що він є.
      setFunction:
        typeof kind.setFunction === "string"
          ? must(
              memberships.find((m) => m.scopeKind.id === kind.id)?.setFunction
            )
          : {
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
    physical,
    stage1.project,
    parse
  )
  const module = projectModule
  const sqlUnits = [
    ...sql.units.map((unit) => verbatimUnit(unit, ownerId, module)),
    ...wrappers,
    ...buildMembershipFunctions(
      stage1.objects,
      physical,
      stage1.project,
      parse
    ),
    ...buildPlatformUnits(
      {
        objects: stage1.objects,
        physical,
        contracts: { users: usersContractOf(stage1.objects, physical) },
        project: stage1.project,
      },
      parse,
      // Ключ провайдера ідентичності — тимчасово пресет бази: окрема вісь
      // провайдера ідентичності з'явиться з другим таким провайдером.
      PROVIDER_IDENTITY_SOURCES[stage1.project.database.provider]
    ),
  ].sort((a, b) => compareStrings(a.identity, b.identity))
  const nameById = new Map(stage1.objects.map((o) => [o.id ?? "", o.name]))
  const name = (id: string | undefined) => nameById.get(id ?? "") ?? ""
  // Згенерована одиниця файлу не має: збіг із нею називає її походження.
  const describeGenerated: Record<UnitGenerator, (unit: SqlUnit) => string> = {
    movementQuery: (unit) =>
      `the movement query of ${name(unit.documentId)} into ${name(unit.registerId)}`,
    membership: (unit) => `the membership SQL of ${name(unit.ownerObjectId)}`,
    platformLayer: (unit) =>
      `the platform layer of ${name(unit.ownerObjectId)}`,
  }
  const collisions = namespaceConflicts(physical, sqlUnits, (unit) =>
    describeGenerated[must(unit.generator)](unit)
  )
  if (collisions.length > 0) {
    return {
      ok: false,
      diagnostics: sortDiagnostics([...diagnostics, ...collisions]),
    }
  }
  const fileById = new Map(stage1.objects.map((o) => [o.id ?? "", o.file]))
  const ordered = creationOrder(
    physical,
    sqlUnits,
    parse,
    // Згенерована одиниця файлу не має: цикл через неї названо в об'єкті-власнику.
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
    physical,
    sqlUnits,
    creationOrder: ordered.order,
    contracts: buildContracts(
      stage1.objects,
      physical,
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
 * Стадії 2–3 і розбір `.sql`: одиниці потребують типів рядків моделі
 * (ідентичність аргументів), тож це один крок. Окремо від `runStages` — бо
 * перелік боргу (`fix`, `introspect`) рахується над тими самими одиницями,
 * що бачить ратчет, без решти стадій.
 */
export function sqlStage(stage1: FilesStageResult, parse: SqlParser) {
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
      ? { units: [], rowRules: [], diagnostics: [] }
      : readAppSql(stage1, stage1.project.defaultSchema, parse, [
          ...enumTypes(stage1, stage1.project.defaultSchema),
          ...(stage3 === undefined ? [] : rowTypesOf(stage3.physical)),
        ])
  return { stage2, upstream, stage3, sql }
}

/**
 * `.sql` застосунку: мова одиниць (`readSqlUnits`, спільна зі зворотним
 * читанням двигуна) і правило файлів метаданих — схема платформи зайнята.
 */
function readAppSql(
  stage1: FilesStageResult,
  defaultSchema: string,
  parse: SqlParser,
  known: readonly { schema: string; name: string }[]
) {
  const sources = sqlSources(stage1, defaultSchema)
  const read = readSqlUnits(sources, parse, known)
  const kept = withoutPlatformSchema(read, sources)
  return {
    units: kept.units,
    rowRules: kept.rowRules,
    diagnostics: [...read.diagnostics, ...kept.diagnostics],
  }
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

/** Модель без помилок гарантує наявність; відсутність — дефект компілятора. */
function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("internal: missing value")
  return value
}

function hasErrors(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === "error")
}
