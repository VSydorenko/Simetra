import {
  KIND_REGISTRY,
  METADATA_KINDS,
  PROVIDER_IDENTITY_SOURCES,
  type MetadataKind,
  type PhysicalSnapshot,
  type Project,
} from "simetra/model"
import type {
  CompileResult,
  CompiledModel,
  CompiledScopeKind,
  SourceObject,
} from "./compile"
import {
  compareStrings,
  diagnostic,
  isRepairError,
  sortDiagnostics,
  type Diagnostic,
} from "./diagnostics"
import { modelHash } from "./canonical"
import {
  accessContracts,
  buildAccessUnits,
  readBoundaries,
} from "./access-units"
import {
  buildContracts,
  derivedFunctions,
  eventSubscriptionContracts,
  membershipContracts,
  usersContractOf,
  mainTableOf,
  type RightsContract,
} from "./contracts"
import {
  buildFunctionExecuteUnits,
  executeEntries,
  executePurposes,
  checkExecuteTypeReferences,
  type FunctionExecuteSources,
  generatedGrantConflicts,
} from "./function-execute"
import { buildPresentation } from "./presentation"
import { rowBudgetDiagnostics } from "./row-budget"
import { buildRuntimeCatalog } from "./runtime-catalog"
import {
  PROJECT_FILE,
  readFiles,
  type FilesStageResult,
  type ParsedObject,
} from "./stages/files"
import { checkIdentity } from "./stages/identity"
import { checkDeclaredExpressions, checkIntegrity } from "./stages/integrity"
import {
  accessDimensionContracts,
  rightsContracts,
  rightsProjection,
  roleContracts,
  sourceContracts,
} from "./rights/contracts"
import {
  buildRightsUnits,
  hasActorSnapshot,
  hasRightsFunctions,
  hasVisibleUsers,
} from "./rights/functions"
import { buildClientSnapshotUnits } from "./rights/client-snapshot"
import { buildRequireUnits } from "./rights/require-units"
import { buildExplainUnits } from "./rights/explain-units"
import { buildRightsGuardUnits } from "./rights/guard-units"
import { snapshotExemptWriters } from "./rights/snapshot-exempt-writers"
import { snapshotSources } from "./rights/snapshot-sources"
import { scopeKindUnreadWarnings } from "./rights/scope-kind-warnings"
import { selfSignUpWarnings } from "./rights/self-sign-up-warning"
import {
  rootCreatedByCommand,
  rootCreatorAdminWarnings,
  rootCreatorUnreachableWarnings,
} from "./rights/role-checks"
import {
  rightsCatalogContracts,
  rightsCatalogTables,
} from "./rights/system-catalogs"
import { checkLinks } from "./stages/links"
import { buildModel, enumTypeOf, kindLabelOf, rowTypesOf } from "./stages/model"
import {
  buildMovementFunctions,
  movementWrapperName,
} from "./movement-functions"
import { buildAuthorUnits } from "./author-units"
import { catalogCommandContracts } from "./catalog-command/contracts"
import { buildCatalogCommandUnits } from "./catalog-command/units"
import { buildSignalUnits } from "./signal/units"
import { buildStorageUnits } from "./platform/storage"
import { buildRightsSignalUnits } from "./rights/signal-triggers"
import { buildHierarchyUnits } from "./hierarchy-units"
import { buildMechanicsUnits } from "./mechanics-units"
import { buildKeyUnits } from "./key-units"
import { buildCarrierUnits } from "./rights/carrier-units"
import { buildCommandUnits } from "./rights/command-units"
import { buildEffectsUnits } from "./rights/effects-units"
import {
  buildSubscriptionUnits,
  subscriptionTriggerConflicts,
} from "./subscription-units"
import { buildMembershipFunctions, membershipsOf } from "./membership-functions"
import { buildPlatformUnits } from "./platform/units"
import {
  checkSqlModules,
  closedModuleOwners,
  platformFormSources,
  staticFormSources,
} from "./sql/closed-forms"
import { creationOrder } from "./sql/dependencies"
import { checkDeclaredGuards, declaredFunctionStates } from "./sql/guard-of"
import { checkDebt, debtPredicate } from "./sql/debt"
import {
  checkDeclaredChecks,
  checkDeclarations,
  declaredFunctions,
} from "./sql/declarations"
import {
  checkFunctionBodies,
  checkPlatformCalls,
  modelViews,
} from "./sql/function-body"
import { checkFunctionSettingsShell } from "./sql/function-settings-shell"
import {
  checkExpressionCalls,
  expressionScope,
  type ExpressionScope,
} from "./sql/expression-calls"
import { checkKindTableVerbatim } from "./sql/kind-table-verbatim"
import { providerCalls } from "./sql/command-context"
import { kindTables } from "./sql/kind-tables"
import { loadSqlParser, type SqlParser } from "./sql/parse"
import { copyColumns } from "./copy-columns"
import { buildSchemaUsageUnits } from "./schema-usage"
import { loadPlpgsqlParser, type PlpgsqlParser } from "./sql/plpgsql"
import { policyFunctions, type PolicyFunctions } from "./sql/policy-functions"
import { assertPinnedSearchPath } from "./sql/pinned-search-path"
import { embedRowRules } from "./sql/row-rule"
import { withoutPlatformSchema } from "./sql/reserved-schema"
import {
  namespaceConflicts,
  readSqlUnits,
  unitDuplicates,
  type SqlSource,
  type SqlUnit,
  type UnitGenerator,
  type VerbatimUnit,
} from "./sql/units"

// Внутрішній модуль: з `simetra/compiler` не експортується, публічні двері —
// лише `compile()`.
export { readFiles }

/**
 * Кваліфіковані імена згенерованих функцій членства, яким може довіряти
 * перевірка функції значень виміру (стадія 5). Стадії 4 і 5 ідуть підряд до
 * гейта помилок, тож довідник, на членство якого стадія 4 вже поскаржилась,
 * сюди не входить: зламане членство не легалізує виклик своєї функції.
 */
function validMembershipFunctions(
  objects: readonly ParsedObject[],
  physical: PhysicalSnapshot,
  project: Project,
  integrity: readonly Diagnostic[]
): ReadonlySet<string> {
  const broken = new Set(
    integrity
      .filter(
        (d) =>
          d.code.startsWith("membership.") ||
          d.pointer.startsWith("/membership")
      )
      .map((d) => d.file)
  )
  const valid = objects.filter((object) => !broken.has(object.file))
  return new Set(
    membershipsOf(valid, physical, project).flatMap((m) =>
      [m.myMember, m.setFunction].flatMap((fn) =>
        fn === undefined ? [] : [`${fn.schema}.${fn.name}`]
      )
    )
  )
}

/**
 * Стадії 2–5 і вихід над результатом стадії 1. Шов між `readFiles` і
 * `runStages` — межа «розібрані дані → їхні читачі»: ратчет «поле без
 * споживача» стоїть саме тут і бачить, які поля схем хтось прочитав.
 */
export async function runStages(
  stage1: FilesStageResult,
  options: { repair?: true } = {}
): Promise<CompileResult> {
  // Гейт стадій: у режимі `repair` помилки класу ремонту його не закривають
  // (спека декларацій функцій §5.1) — модель будується, а `ok` лишається
  // `false` за `hasErrors`.
  const blocks = (diagnostics: readonly Diagnostic[]) =>
    diagnostics.some(
      (d) =>
        d.severity === "error" && !(options.repair === true && isRepairError(d))
    )
  const [parse, plpgsql] = await Promise.all([
    loadSqlParser(),
    loadPlpgsqlParser(),
  ])
  const { stage2, upstream, stage3, sql, declared, derived, calls, policies } =
    sqlStage(stage1, parse, plpgsql)
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
  // Таблиці видів — зі знімка стадії 3. Без неї компіляцію вже зупиняють
  // помилки вище за течією, тож порожній знімок лише для судження запису
  // сесії боргу (спека прав §5.3): ратчет на ньому не судиться.
  const kinds = kindTables(stage1.objects, stage3?.physical.tables ?? [])
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
          kinds,
          stage1.sqlDebt,
          !sql.diagnostics.some((d) => d.code === "sql.parse"),
          parse,
          plpgsql,
          declared,
          calls,
          policies
        )
  // Вирази прийнятих таблиць цієї стадії не мають, тож для них поза переліком
  // лише згенеровані функції, що читають.
  const expressions = (reading: boolean): ExpressionScope | undefined =>
    derived === undefined || stage1.project === undefined
      ? undefined
      : expressionScope(
          sql.units,
          stage1.project.database.provider,
          new Set(
            derived
              .filter(
                (f) => !reading || f.reads === true || f.membership === true
              )
              .map((f) => `${f.schema}.${f.name}`)
          )
        )
  const unitExpressions = expressions(false)
  // Функції, `EXECUTE` яких виводить платформа: одні джерела для перевірки
  // підпису раннього блоку й для генератора грантів.
  const executeSources: FunctionExecuteSources = {
    forms: platformFormSources(stage1.objects, stage1.project, policies),
    declared,
    units: sql.units,
    moduleOwners: owners,
  }
  // Модуль виду 1С звужено до закритих форм: вид власника одиниці — з її
  // `ownerFile`, тож перевірка не чекає моделі стадії 3.
  const early = [
    ...upstream,
    ...sql.diagnostics,
    ...checkSqlModules(
      stage1.objects,
      sql.units,
      sql.rowRules,
      debtPredicate(
        stage1.objects,
        stage1.project,
        kinds,
        parse,
        plpgsql,
        modelViews(sql.units),
        sql.units,
        declared,
        calls,
        policies
      ),
      parse,
      plpgsql,
      stage1.project?.database.provider,
      declared,
      calls,
      policies
    ),
    // Функція, яку кличе дослівна політика, поза формою функції політики —
    // помилка класу ремонту (спека декларацій функцій §5.8): її розпізнано
    // одразу після розбору `.sql`, тож вона стоїть поруч із ратчетом боргу.
    ...policies.diagnostics,
    // Оболонку судимих функцій задає лише `CREATE` (спека прав §5.3): набір судимих
    // відомий до стадії 3, тож помилка стоїть поруч із формами модулів.
    ...checkFunctionSettingsShell(
      stage1.objects,
      stage1.project,
      sql.units,
      parse,
      plpgsql,
      declared,
      calls.models,
      policies
    ),
    // Резолв декларацій функцій (спека декларацій функцій §5.1) потребує лише
    // одиниць і метаданих, тож стоїть у ранньому блоці: нерезолвлена
    // декларація не має доходити до генератора `EXECUTE`.
    ...checkDeclarations(
      stage1.functionsFiles,
      sql.units,
      stage1.objects,
      stage1.project,
      new Set(
        sql.diagnostics.filter((d) => d.code === "sql.parse").map((d) => d.file)
      ),
      policies
    ),
    // Аргумент `%type` функції з виведеним `EXECUTE` (#300) — помилка до
    // генератора `EXECUTE`: інакше функція лишилася б з `EXECUTE` від `PUBLIC`.
    ...checkExecuteTypeReferences(executeSources),
    ...debt.grows,
    // Дослівна політика чи тригер на таблиці виду і тіло функції, що її
    // пише, — помилка раннього блоку поруч із ратчетом боргу (спека прав §6.1,
    // Правило 1): стадія 5 за нею не запускається, а знімок таблиць уже є —
    // стадія 3 будує його до розбору `.sql`.
    ...(stage3 === undefined
      ? []
      : checkKindTableVerbatim(
          stage1.objects,
          stage3.physical.tables,
          sql.units,
          parse,
          plpgsql,
          stage1.project?.database.provider
        )),
    // Дозвільний перелік операторів тіла (спека прав §6.1) і виклики функцій
    // платформи (спека прав §5.3) знімка не потребують: стадія 5 після них судить
    // лише прочитані тіла.
    ...checkFunctionBodies(
      stage1.objects,
      stage1.project,
      sql.units,
      parse,
      plpgsql,
      calls,
      policies
    ),
    ...checkPlatformCalls(sql.units, parse, plpgsql, declared),
    // Виклики подань і політик — дозвільний перелік виразів (спека прав §5.3).
    ...(unitExpressions === undefined
      ? []
      : checkExpressionCalls(sql.units, unitExpressions, parse)),
    ...(embedded?.diagnostics ?? []),
  ]
  if (
    blocks(early) ||
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

  const integrity = [
    ...checkIntegrity(
      stage1.objects,
      stage2.references,
      { ...stage3, physical },
      stage1.project,
      sql.units
    ),
    ...checkDeclaredExpressions(
      stage1.objects,
      stage1.project,
      expressions(true)!,
      parse
    ),
  ]
  const staged = sortDiagnostics([
    ...early,
    ...debt.stale,
    ...integrity,
    ...checkLinks(
      stage1.objects,
      stage2.references,
      stage1.project,
      physical,
      sql.units,
      parse,
      plpgsql,
      validMembershipFunctions(
        stage1.objects,
        physical,
        stage1.project,
        integrity
      ),
      rightsCatalogTables(stage1.objects, physical),
      declared,
      policies
    ),
  ])
  if (blocks(staged)) return { ok: !hasErrors(staged), diagnostics: staged }

  const rights = rightsContracts(
    stage1.objects,
    stage2.references,
    physical,
    stage1.project
  )
  const roles = roleContracts(stage1.objects, stage2.references)
  // Рівень ролі й вимоги дій видно лише на контрактах прав, а ті будуються
  // лише на моделі без помилок — тож ці помилки йдуть після гейта стадій 4–5,
  // як конфлікти тригерів нижче.
  const projection = rightsProjection(
    stage1.objects,
    stage2.references,
    rights,
    roles,
    stage1.project
  )
  if (projection.diagnostics.length > 0) {
    return {
      ok: false,
      diagnostics: sortDiagnostics([...staged, ...projection.diagnostics]),
    }
  }
  // Вид скоупу, об'єктів якого не читає жодна роль (спека прав §5.2), і творця
  // кореня без адміністрування прав рівня (спека П4 §6.13) видно лише на
  // проєкції ролей — тож попередження йдуть після неї й не зупиняють компіляції.
  let diagnostics = sortDiagnostics([
    ...staged,
    ...scopeKindUnreadWarnings(
      { rights, roles, rightsProjection: projection.rows },
      stage1.project
    ),
    ...rootCreatorAdminWarnings(
      { rights, roles, rightsProjection: projection.rows },
      stage1.objects,
      stage1.project.scopeKinds
    ),
    ...rootCreatorUnreachableWarnings(
      roles,
      stage1.objects,
      stage2.references,
      stage1.project.scopeKinds
    ),
  ])
  // Довідники прав потрібні і контрактам, і генератору прав серед SQL-одиниць:
  // обчислюються до одиниць, тож `buildContracts` їх лише приймає.
  const rightsCatalogs = rightsCatalogContracts(
    stage1.objects,
    stage2.references,
    physical
  )
  const accessDimensions = accessDimensionContracts(
    stage1.objects,
    stage2.references,
    physical,
    stage1.project
  )
  const sources = sourceContracts(
    stage1.objects,
    stage2.references,
    physical,
    stage1.project
  )

  const scopeKindIdByFile = new Map<string, string>()
  const rootIdByPointer = new Map<string, string>()
  for (const { role, from, to } of stage2.references) {
    if (role === "object.scope") scopeKindIdByFile.set(from.file, to.id)
    if (role === "scopeKind.root") rootIdByPointer.set(from.pointer, to.id)
  }
  const { defaultSchema } = stage1.project
  const memberships = membershipsOf(stage1.objects, physical, stage1.project)
  // Факт «вид має творця кореня» — один для генераторів ядра, ефектів і
  // каталогу рантайму. Корінь, якого не створює команда, факту не дає
  // (попередження `rights.root-creator-unreachable`): інакше ядро кликало б
  // функцію гранту, якої немає, а маркер ставився б на вставці без гранту.
  // Довідник членства й «Призначення ролей» такого виду гарантують
  // діагностики `rights.root-creator-*`, тож їх
  // відсутність тут — дефект компілятора, а не моделі.
  const rootCreatorOf = (
    kindId: string,
    rootId: string | undefined
  ): Pick<CompiledScopeKind, "rootCreator"> => {
    const creator = roles.find(
      (r) =>
        r.rootCreator &&
        r.assignedOn.level === "scope" &&
        r.assignedOn.scopeKindId === kindId
    )
    if (
      creator === undefined ||
      rootId === undefined ||
      !rootCreatedByCommand(rootId, stage1.objects)
    )
      return {}
    const membership = memberships.find((m) => m.scopeKind.id === kindId)
      ?.object.id
    const assignments = rightsCatalogs.find(
      (c) => c.level.level === "scope" && c.level.scopeKindId === kindId
    )?.assignments.objectId
    if (membership === undefined || assignments === undefined) {
      throw new Error(
        `internal: scope kind ${kindId} has a root creator without membership or assignments`
      )
    }
    return {
      rootCreator: { role: creator.roleId, membership, assignments },
    }
  }
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
      ...rootCreatorOf(
        kind.id ?? "",
        "object" in kind.root
          ? rootIdByPointer.get(`/scopeKinds/${index}/root/object`)
          : undefined
      ),
    }))
    .sort((a, b) => compareStrings(a.name, b.name))
  // Один контракт «Користувачів» і для шару платформи, і для функцій прав, і
  // для меж доступу: без нього всі мовчать (спека прав §4.6).
  const users = usersContractOf(stage1.objects, physical)
  // Дослівні функції множини видів скоупу — факт актора `scopeSets` (спека
  // прав §5.2): ті самі функції, що отримують гранти форми `setFunction`, з видом.
  const scopeSetFunctions = scopeKinds
    .filter((kind) =>
      stage1.project!.scopeKinds.some(
        (declared) =>
          declared.id === kind.id && typeof declared.setFunction !== "string"
      )
    )
    .map((kind) => ({ scopeKindId: kind.id, fn: kind.setFunction }))
    .sort((a, b) => compareStrings(a.scopeKindId, b.scopeKindId))
  // Знімок актора (спека прав §7): з ним публічні функції фактів, функції
  // членства й межа тенанта дослівної функції множини читають факти
  // транзакції на її початок.
  const actorSnapshot = hasActorSnapshot(
    {
      rightsCatalogs,
      roles,
      users,
      membershipSources: sources.membershipSources,
    },
    stage1.project.database.provider
  )
  const access = accessContracts(
    stage1.objects,
    physical,
    scopeKinds,
    scopeKindIdByFile,
    rights,
    users?.objectId,
    stage1.project.naming.attributeCase,
    new Set(
      actorSnapshot ? scopeSetFunctions.map((set) => set.scopeKindId) : []
    )
  )

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
  const eventSubscriptions = eventSubscriptionContracts(
    stage1.objects,
    physical,
    stage1.project
  )
  const membership = membershipContracts(
    stage1.objects,
    physical,
    stage1.project
  )
  // Мітка виду й UUID кастомної дії для `check` декларації є лише на
  // контрактах прав (Р1), а чи читає дія рядок через межу «Користувачів» — на
  // контрактах доступу й членства, тож суддя стоїть після їх побудови, до
  // одиниць. Хибна `check` — не клас ремонту, тож зупиняє і в режимі `repair`.
  const visibleUsers = hasVisibleUsers(
    {
      roles,
      users,
      membership,
      membershipSources: sources.membershipSources,
    },
    stage1.project.database.provider
  )
  const checkForms = checkDeclaredChecks(
    declared,
    sql.units,
    stage1.objects,
    rights,
    new Set(
      access.flatMap((contract) =>
        contract.rights !== undefined &&
        readBoundaries(contract, visibleUsers).includes("users")
          ? [contract.rights.objectId]
          : []
      )
    ),
    new Set(
      rights.flatMap(({ objectId }) => {
        const main = mainTableOf(physical, objectId)
        const key = main?.primaryKey?.columns
        return key?.length === 1 &&
          main?.columns.find((c) => c.name === key[0])?.type === "uuid"
          ? [objectId]
          : []
      })
    )
  )
  if (checkForms.length > 0) {
    return {
      ok: false,
      diagnostics: sortDiagnostics([...diagnostics, ...checkForms]),
    }
  }
  // Запобіжник виклику судиться лише для декларацій, що пройшли `check-form`
  // (ранній `return` вище): контракт об'єкта й ціль тоді гарантовано є. Це
  // клас ремонту: у режимі `repair` модель будується далі.
  const guards = checkDeclaredGuards(
    declared,
    sql.units,
    stage1.objects,
    rights,
    plpgsql,
    parse
  )
  if (blocks(guards)) {
    return {
      ok: false,
      diagnostics: sortDiagnostics([...diagnostics, ...guards]),
    }
  }
  diagnostics = sortDiagnostics([...diagnostics, ...guards])
  // Один об'єкт контрактів для функцій прав і для пояснення видимості: поле,
  // додане лише в одне місце, дало б двом генераторам різні контракти.
  const rightsInputs = {
    rights,
    roles,
    rightsProjection: projection.rows,
    rightsCatalogs,
    accessDimensions,
    membership,
    membershipSources: sources.membershipSources,
    assignmentSources: sources.assignmentSources,
    users,
    scopeSetFunctions,
  }
  const kindLabels = new Map(
    stage1.objects.flatMap((object) => {
      const label = kindLabelOf(object)
      return object.id === undefined || label === undefined
        ? []
        : [[object.id, label] as const]
    })
  )
  const baseUnits = [
    ...sql.units.map((unit) => verbatimUnit(unit, ownerId, module)),
    ...wrappers,
    ...buildMembershipFunctions(
      stage1.objects,
      physical,
      stage1.project,
      parse,
      actorSnapshot
    ),
    ...buildPlatformUnits(
      {
        objects: stage1.objects,
        physical,
        contracts: {
          users,
          membershipSources: sources.membershipSources,
        },
        project: stage1.project,
      },
      parse,
      // Ключ провайдера ідентичності — тимчасово пресет бази: окрема вісь
      // провайдера ідентичності з'явиться з другим таким провайдером.
      PROVIDER_IDENTITY_SOURCES[stage1.project.database.provider]
    ),
    ...buildAccessUnits(
      access,
      {
        rights,
        accessDimensions,
        roles,
        users,
        membership,
        membershipSources: sources.membershipSources,
      },
      physical,
      stage1.project.database.provider,
      module,
      parse
    ),
    ...buildFunctionExecuteUnits(
      executeSources,
      stage1.project.database.provider,
      module,
      parse
    ),
    ...buildMechanicsUnits(
      physical,
      stage1.project.naming.attributeCase,
      stage1.project.database.provider,
      module,
      parse
    ),
    // Незмінність ключа — для кожного проєкту, незалежно від прав (спека прав §7).
    ...buildKeyUnits(
      physical,
      stage1.project.naming.attributeCase,
      stage1.project.database.provider,
      module,
      parse
    ),
    ...buildAuthorUnits(
      physical,
      { roles, users, membershipSources: sources.membershipSources },
      stage1.project.naming.attributeCase,
      stage1.project.database.provider,
      module,
      parse
    ),
    ...buildHierarchyUnits(
      physical,
      stage1.objects,
      stage1.project.naming.attributeCase,
      stage1.project.database.provider,
      module,
      parse
    ),
    ...buildSubscriptionUnits(
      eventSubscriptions,
      physical,
      stage1.project.naming.attributeCase,
      module,
      parse
    ),
    ...buildCarrierUnits(
      physical,
      stage1.project.naming.attributeCase,
      stage1.project.database.provider,
      module,
      parse
    ),
    ...buildRightsUnits(
      rightsInputs,
      physical,
      stage1.project.naming.attributeCase,
      stage1.project.database.provider,
      module,
      parse
    ),
    ...buildExplainUnits(
      { ...rightsInputs, access, kindLabels },
      physical,
      stage1.project.database.provider,
      module,
      parse
    ),
    ...buildCommandUnits(
      { rights, roles, users, membershipSources: sources.membershipSources },
      stage1.project.database.provider,
      module,
      parse
    ),
    ...buildEffectsUnits(
      {
        rights,
        roles,
        users,
        membership,
        membershipSources: sources.membershipSources,
      },
      scopeKinds,
      physical,
      stage1.project.naming.attributeCase,
      stage1.project.database.provider,
      module,
      parse
    ),
  ]
  // Джерела знімка актора — аналізом тіл живих варіантів над усіма
  // згенерованими й дослівними одиницями (спека прав §7): запобіжники
  // ставлять тригер знімка на кожне джерело, тож рахуються раз до них.
  const guardContracts = {
    rights,
    roles,
    users,
    membership,
    membershipSources: sources.membershipSources,
    assignmentSources: sources.assignmentSources,
    rightsCatalogs,
    accessDimensions,
    scopeSetFunctions,
  }
  // Під функціями прав, а не лише під знімком актора: та сама множина дає
  // таблиці фактів тригерам сигналу прав (спека П4-B §8.2).
  const rightsFunctions = hasRightsFunctions(
    { roles, users, membershipSources: sources.membershipSources },
    stage1.project.database.provider
  )
  const snapshot = rightsFunctions
    ? snapshotSources({
        contracts: guardContracts,
        physical,
        objects: stage1.objects,
        generated: baseUnits.filter((unit) => unit.generator !== undefined),
        verbatim: sql.units,
        attributeCase: stage1.project.naming.attributeCase,
        parse,
        plpgsql,
      })
    : { sources: [], exempt: [], unknown: [] }
  const snapshotProblems = [
    ...snapshot.unknown.map((entry) =>
      diagnostic(
        "rights.snapshot-source-unknown",
        sql.units.find((unit) => unit.identity === entry.via)?.file ??
          PROJECT_FILE,
        "",
        { ...entry }
      )
    ),
    // Винятки знімка стереже лише знімок актора: без нього запис у
    // виняток фактів транзакції не зсуває.
    ...(actorSnapshot
      ? snapshotExemptWriters(
          snapshot,
          sql.units,
          parse,
          plpgsql,
          stage1.project.database.provider
        )
      : []),
  ]
  if (snapshotProblems.length > 0) {
    return {
      ok: false,
      diagnostics: sortDiagnostics([...diagnostics, ...snapshotProblems]),
    }
  }
  baseUnits.push(
    ...buildRightsGuardUnits(
      guardContracts,
      physical,
      stage1.objects,
      stage1.project.naming.attributeCase,
      stage1.project.database.provider,
      module,
      parse,
      snapshot
    )
  )
  // Ядро команд довідника — над рештою одиниць: функції, які кличе його
  // тіло (функції прав, множин, джерел копій), — ребра `requires`, а
  // обробники `beforeWrite` вирішують замок ієрархії (спека П4 §6.6).
  // Контракти ядра — рівно той набір, з якого генерується SQL: без функцій
  // прав ядра немає, тож і каталог рантайму не обіцяє жодної команди.
  const catalogCommands = rightsFunctions
    ? catalogCommandContracts({
        access,
        rights,
        physical,
        objects: stage1.objects,
        attributeCase: stage1.project.naming.attributeCase,
        usersObjectId: users?.objectId,
        scopeRootIds: new Set(
          scopeKinds.flatMap((k) =>
            "objectId" in k.root ? [k.root.objectId] : []
          )
        ),
        subscriptions: eventSubscriptions,
        units: baseUnits,
        parse,
        plpgsql,
      })
    : []
  // Оракул каналу, відправка сигналу й політика `INSERT` outbox — за тією
  // самою умовою, що ядро: сигнали шле лише воно (спека П4-B §8.2). Першими:
  // ядро кличе `simetra.signal`, і ребро `requires` бере її одиницю.
  const signalUnits = buildSignalUnits({
    contracts: {
      access,
      rights,
      roles,
      users,
      membership,
      membershipSources: sources.membershipSources,
    },
    physical,
    provider: stage1.project.database.provider,
    module,
    units: baseUnits,
    parse,
    plpgsql,
  })
  // Сховище файлів: функції, тригери вкладення, незмінності й обліку на
  // таблицях видів зі `storage` (спека профілю postgres §8). Гілки права —
  // ті самі будівники, що й політики, тож лише коли є функції прав.
  const storageUnits = buildStorageUnits({
    objects: stage1.objects,
    contracts: {
      access,
      rights,
      roles,
      users,
      membership,
      membershipSources: sources.membershipSources,
    },
    physical,
    provider: stage1.project.database.provider,
    module,
    units: baseUnits,
    parse,
    plpgsql,
  })
  // Тригери сигналу прав — на кожну таблицю фактів з аналізу джерел (спека
  // П4-B §8.2); кличуть функції сигналів прав генератора `signal`.
  const rightsSignals = rightsFunctions
    ? buildRightsSignalUnits({
        contracts: {
          rightsCatalogs,
          membership,
          membershipSources: sources.membershipSources,
          users,
          accessDimensions,
          rights,
        },
        physical,
        objects: stage1.objects,
        sources: snapshot,
        attributeCase: stage1.project.naming.attributeCase,
        provider: stage1.project.database.provider,
        module,
        parse,
      })
    : { units: [], exempt: [], unknown: [] }
  if (rightsSignals.unknown.length > 0) {
    return {
      ok: false,
      diagnostics: sortDiagnostics([
        ...diagnostics,
        ...rightsSignals.unknown.map((entry) =>
          diagnostic("rights.signal-source-unknown", PROJECT_FILE, "", {
            table: `${entry.table.schema}.${entry.table.name}`,
            facts: entry.facts.join(", "),
          })
        ),
      ]),
    }
  }
  // Знімок прав клієнта — читає лише публічні функції фактів: їхні одиниці
  // (функції прав, множини) — в `baseUnits`, ребра `requires` бере з тіла.
  const clientSnapshotUnits = buildClientSnapshotUnits({
    contracts: {
      access,
      rights,
      roles,
      users,
      membershipSources: sources.membershipSources,
    },
    physical,
    provider: stage1.project.database.provider,
    module,
    units: baseUnits,
    parse,
    plpgsql,
  })
  const modelUnits = [
    ...baseUnits,
    ...buildCatalogCommandUnits({
      catalogCommands,
      contracts: {
        rights,
        access,
        roles,
        users,
        membershipSources: sources.membershipSources,
        membership,
      },
      scopeKinds,
      physical,
      attributeCase: stage1.project.naming.attributeCase,
      provider: stage1.project.database.provider,
      module,
      units: [...baseUnits, ...signalUnits],
      parse,
      plpgsql,
    }),
    ...signalUnits,
    ...storageUnits,
    ...rightsSignals.units,
    ...clientSnapshotUnits,
    // Функції запобіжника виклику: гілки — з декларацій, що пройшли
    // `check-form`; ребра `requires` — до функцій прав і множин `baseUnits`.
    ...buildRequireUnits({
      declared,
      objects: stage1.objects,
      contracts: {
        access,
        rights,
        roles,
        users,
        membership,
        membershipSources: sources.membershipSources,
      },
      physical,
      provider: stage1.project.database.provider,
      module,
      units: baseUnits,
      parse,
      plpgsql,
    }),
  ]
  // `USAGE` на схеми застосунку — над усіма згенерованими грантами, бо схему
  // відкривають і таблиці, і функції (платформна спека §6.7)
  const sqlUnits = [
    ...modelUnits,
    ...buildSchemaUsageUnits(modelUnits, module, parse),
  ].sort((a, b) => compareStrings(a.identity, b.identity))
  assertPinnedSearchPath(sqlUnits)
  const nameById = new Map(stage1.objects.map((o) => [o.id ?? "", o.name]))
  const name = (id: string | undefined) => nameById.get(id ?? "") ?? ""
  // Згенерована одиниця файлу не має: збіг із нею називає її походження.
  const describeGenerated: Record<UnitGenerator, (unit: SqlUnit) => string> = {
    movementQuery: (unit) =>
      `the movement query of ${name(unit.documentId)} into ${name(unit.registerId)}`,
    membership: (unit) => `the membership SQL of ${name(unit.ownerObjectId)}`,
    // Без «Користувачів» функція поточного користувача — спільна, без власника.
    platformLayer: (unit) =>
      unit.ownerObjectId === undefined
        ? "the platform layer"
        : `the platform layer of ${name(unit.ownerObjectId)}`,
    access: (unit) => `the access SQL of ${name(unit.ownerObjectId)}`,
    functionExecute: (unit) => `the EXECUTE grant of ${unit.name}`,
    // Функція механіки й її гранти спільні для всіх таблиць — власника немає.
    mechanics: (unit) =>
      unit.ownerObjectId === undefined
        ? "the row mechanics of the platform"
        : `the row mechanics of ${name(unit.ownerObjectId)}`,
    // Функція незмінності ключа й її гранти спільні — власника немає.
    key: (unit) =>
      unit.ownerObjectId === undefined
        ? "the key immutability of the platform"
        : `the key immutability of ${name(unit.ownerObjectId)}`,
    subscription: (unit) =>
      `the event subscription ${name(unit.ownerObjectId)}`,
    // Функції прав спільні для всіх об'єктів — власника немає.
    rights: (unit) => `the rights function ${unit.name}`,
    rightsGuards: (unit) => `the rights guard of ${name(unit.ownerObjectId)}`,
    // Функції запобіжника виклику спільні для всіх об'єктів — власника немає.
    rightsRequire: (unit) => `the call guard function ${unit.name}`,
    // Пояснення видимості спільне для всіх об'єктів — власника немає.
    rightsExplain: (unit) => `the rights explain function ${unit.name}`,
    carriers: (unit) => `the carrier copies of ${name(unit.ownerObjectId)}`,
    // Функції контексту команди спільні для всіх об'єктів — власника немає.
    command: (unit) => `the command context function ${unit.name}`,
    effects: (unit) =>
      `the action effects check of ${name(unit.ownerObjectId)}`,
    catalogCommand: (unit) => `the command core of ${name(unit.ownerObjectId)}`,
    // Грант схеми спільний для всіх її об'єктів — власника немає.
    schemaUsage: (unit) => `the USAGE grant on schema ${unit.name}`,
    // Outbox сигналів — у кожному проєкті, власника немає.
    signalOutbox: () => "the signal outbox of the platform",
    // Функції сховища спільні, тригери — на таблиці об'єкта зі `storage`.
    storage: (unit) =>
      unit.ownerObjectId === undefined
        ? `the file storage object ${unit.name}`
        : `the file storage of ${name(unit.ownerObjectId)}`,
    // Оракул каналу й правило форми сигналу спільні — власника немає.
    signal: (unit) => `the signal authorization ${unit.name}`,
    rightsSignal: (unit) =>
      `the rights signal trigger of ${name(unit.ownerObjectId)}`,
    // Знімок прав клієнта спільний — власника немає.
    rightsClientSnapshot: (unit) => `the rights client snapshot ${unit.name}`,
  }
  const fileById = new Map(stage1.objects.map((o) => [o.id ?? "", o.file]))
  const triggerConflicts = subscriptionTriggerConflicts(
    sqlUnits,
    (id) => fileById.get(id ?? "") ?? "",
    (unit) => describeGenerated[must(unit.generator)](unit)
  )
  // Дослівний грант на об'єкт платформи вже названо своєю помилкою: як
  // тотожна копія згенерованого він не звітується вдруге дублікатом.
  const grants = generatedGrantConflicts(sqlUnits, parse)
  const collisions = namespaceConflicts(
    physical,
    sqlUnits.filter((unit) => !grants.flagged.has(unit)),
    (unit) => describeGenerated[must(unit.generator)](unit)
  )
  if (
    triggerConflicts.length > 0 ||
    grants.diagnostics.length > 0 ||
    collisions.length > 0
  ) {
    return {
      ok: false,
      diagnostics: sortDiagnostics([
        ...diagnostics,
        ...triggerConflicts,
        ...grants.diagnostics,
        ...collisions,
      ]),
    }
  }
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
        actions: KIND_REGISTRY[o.kind].actions(o.data).map((a) => a.name),
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
    catalogCommands,
    checkColumns: [...stage3.checkColumns, ...embedded.checkColumns],
    copyColumns: new Map(
      physical.tables.flatMap((table) => {
        const columns = copyColumns(table, parse)
        return columns.size === 0
          ? []
          : [[`${table.schema}.${table.name}`, columns] as const]
      })
    ),
    creationOrder: ordered.order,
    contracts: buildContracts(
      stage1.objects,
      physical,
      stage1.project.naming.attributeCase,
      sqlUnits,
      stage1.project.timezone,
      stage3.elementChecks,
      stage1.project,
      access,
      eventSubscriptions,
      rights,
      accessDimensions,
      sources,
      roles,
      projection.rows,
      rightsCatalogs
    ),
    presentation: buildPresentation(
      stage1.objects,
      stage1.project.naming.attributeCase,
      stage1.project.defaultLocale
    ),
  }
  const compiled = { ...model, hash: await modelHash(model) }
  // Бюджет рядка рахується за формою передачі, а її дає лише каталог
  // рантайму — проєкція готової моделі, тож правило йде останнім.
  const budget = rowBudgetDiagnostics(buildRuntimeCatalog(compiled), objects)
  if (blocks(budget)) {
    return {
      ok: false,
      diagnostics: sortDiagnostics([...diagnostics, ...budget]),
    }
  }
  // `ok` рахується над усіма діагностиками: помилки класу ремонту, що пізніші
  // за гейт стадій (`checkDeclaredGuards`), не закривали його в `repair`.
  // Самореєстрація відкриває межу «дійсного користувача» Інтернету (Р-D5-9):
  // потрібен контракт доступу, тож попередження — після його побудови, на шляху
  // до результату без раннього `return`.
  const final = sortDiagnostics([
    ...diagnostics,
    ...budget,
    ...selfSignUpWarnings(
      { access, rights, roles, rightsProjection: projection.rows },
      stage1.objects,
      stage1.project
    ),
  ])
  return {
    ok: !hasErrors(final),
    diagnostics: final,
    model: compiled,
    functionExecute: executeEntries(executeSources),
    declaredFunctions: declaredFunctionStates(
      declared,
      executePurposes(executeSources),
      sql.units,
      stage1.objects,
      rights,
      plpgsql,
      parse
    ),
  }
}

/**
 * Контракти прав лише з метаданих, без SQL-стадій: зворотна генерація
 * розв'язує за ними мітку виду й дію запобіжника. `undefined` — метадані
 * не доходять до моделі (помилка стадій 1–3) чи контракти не будуються.
 */
export function metadataRights(files: ReadonlyMap<string, string>):
  | {
      objects: readonly { id: string; kind: MetadataKind; name: string }[]
      rights: RightsContract[]
    }
  | undefined {
  const stage1 = readFiles(files)
  const stage2 = checkIdentity(
    stage1.objects,
    stage1.brokenNames,
    stage1.project,
    stage1.functionsFiles
  )
  if (
    stage1.project === undefined ||
    hasErrors([...stage1.diagnostics, ...stage2.diagnostics])
  )
    return undefined
  try {
    const stage3 = buildModel(stage1.objects, stage1.project, stage2.references)
    const rights = rightsContracts(
      stage1.objects,
      stage2.references,
      stage3.physical,
      stage1.project
    )
    return {
      objects: stage1.objects.flatMap((o) =>
        o.id === undefined ? [] : [{ id: o.id, kind: o.kind, name: o.name }]
      ),
      rights,
    }
  } catch {
    // Цикл вимог чи невідома дія: їх називає стадія 4 повної компіляції
    return undefined
  }
}

/**
 * Стадії 2–3 і розбір `.sql`: одиниці потребують типів рядків моделі
 * (ідентичність аргументів), тож це один крок. Окремо від `runStages` — бо
 * перелік боргу (`fix`, `introspect`) рахується над тими самими одиницями,
 * що бачить ратчет, без решти стадій.
 */
export function sqlStage(
  stage1: FilesStageResult,
  parse: SqlParser,
  plpgsql: PlpgsqlParser
) {
  const stage2 = checkIdentity(
    stage1.objects,
    stage1.brokenNames,
    stage1.project,
    stage1.functionsFiles
  )
  const upstream = [...stage1.diagnostics, ...stage2.diagnostics]
  // Стадії 3–4 спираються на резолвлені посилання й наявні id та
  // physicalName, тож на зламаній моделі не запускаються. Стадія 3 бігає до
  // розбору `.sql`: типи рядків таблиць потрібні ідентичності аргументів.
  // Помилка класу ремонту стадії 2 (`customTable.index-derived-column`)
  // модель не ламає: стадія 3 її будує, а чи віддати модель далі, вирішує
  // гейт стадій режиму `repair`.
  const stage3 =
    stage1.project === undefined ||
    hasErrors(upstream.filter((d) => !isRepairError(d)))
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
  // Декларації резолвляться над тими самими одиницями, тож ратчет боргу
  // (`fix`, `introspect`) і стадії бачать одне й те саме виключення.
  const declared =
    stage1.project === undefined
      ? []
      : declaredFunctions(
          stage1.functionsFiles,
          sql.units,
          stage1.project.defaultSchema
        )
  // Згенеровані функції схем застосунку відомі лише зі знімка. Подання й
  // політики їх не судять дозвільним переліком виразів (спека прав §5.3): ті, що
  // пишуть, судить `sql.platform-function-call` стадії 5; кваліфікований виклик
  // у тілі їх теж не судить як текст SQL. Одні дані для ратчета боргу й стадій,
  // тож `fix` і `introspect` бачать те саме, що компілятор.
  const derived =
    stage3 === undefined || stage1.project === undefined
      ? undefined
      : derivedFunctions(
          stage1.objects,
          stage2.references,
          stage3.physical,
          movementWrapperName,
          stage1.project.scopeKinds,
          stage1.project.naming.attributeCase
        )
  const calls = providerCalls(
    stage1.project?.database.provider,
    sql.units,
    new Set((derived ?? []).map((f) => `${f.schema}.${f.name}`))
  )
  // Функції політик боргу (спека декларацій функцій §5.8) — одразу після
  // розбору `.sql`: їх читають ратчет боргу, джерело форм платформи й
  // генератор `EXECUTE`, тож `fix`, `introspect` і стадії бачать одну форму.
  // Таблиця T — зі знімка стадії 3; без неї компіляцію вже зупиняють помилки
  // вище за течією, і функцій політик немає.
  const policies: PolicyFunctions =
    stage3 === undefined || stage1.project === undefined
      ? { functions: [], diagnostics: [], refused: [] }
      : policyFunctions({
          units: sql.units,
          tables: stage3.physical.tables,
          provider: stage1.project.database.provider,
          forms: staticFormSources(stage1.objects, stage1.project),
          membershipFunctions: new Set(
            (derived ?? [])
              .filter((f) => f.membership === true)
              .map((f) => `${f.schema}.${f.name}`)
          ),
          parse,
          plpgsql,
        })
  return { stage2, upstream, stage3, sql, declared, derived, calls, policies }
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
    diagnostics: [
      ...read.diagnostics,
      ...kept.diagnostics,
      ...unitDuplicates(kept.units),
    ],
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
