import {
  canonicalSnapshot,
  loadSqlParser,
  type CompiledModel,
  type RuleCode,
  type SqlParser,
} from "simetra/compiler"
import {
  diffCatalogModels,
  PROVIDER_API_ROLES,
  quoteIdent,
  type CatalogModel,
} from "simetra/model"
import {
  PROVIDER_EXPECTED_BLIND_FUNCTIONS,
  PROVIDER_INSTALLABLE_EXTENSIONS,
  PROVIDER_LOCKS,
  type DbConnection,
  type EngineAction,
  type EngineDiagnostic,
  type EnginePlan,
  type EngineScope,
  type Extracted,
  type SchemaEngine,
  type ShadowOptions,
} from "../engine"
import { dedupe } from "../engine/desired"
import {
  PLAN_FORMAT,
  stampPlan,
  type PlanArtifact,
  type PromotionSection,
} from "./artifact"
import { desiredForApply, type ApplyDesired } from "./desired"
import { applyDiagnostic } from "./diagnostic"
import { driftGate, type DriftReport } from "./drift"
import {
  environmentMismatch,
  environmentSteps,
  readGlobalDefaultPrivileges,
  renderGlobalDefaultPrivileges,
  type GlobalDefaultPrivilege,
} from "./environment"
import { executePlan, type ExecutablePlan } from "./execute"
import {
  blindWarning,
  planFunctionChecks,
  readBlindFunctions,
  type BlindFunctions,
  type PlpgsqlCheckMode,
} from "./function-checks"
import {
  compareFingerprints,
  FINGERPRINT_SECTIONS,
  FINGERPRINT_VERSION,
  readFingerprint,
  readOwners,
  type CatalogFingerprint,
  type FingerprintSection,
  type ObjectOwner,
} from "./fingerprint"
import { readInvalidObjects } from "./validity"
import {
  footprintSubjects,
  footprintTables,
  planFootprint,
  planLocks,
  providerStatements,
  readLiveForeignKeys,
  readLockRights,
  readProviderLocks,
  type FootprintModels,
  type ImplicitLock,
  type ProviderLockSet,
  type TableLock,
} from "./locks"
import { ApplyConnectionLost, ApplyDbError, type ApplyDatabase } from "./port"
import {
  accessChanges,
  adoptedReplacements,
  canonicalRenames,
  classifyRemovals,
  foreignSequenceRefusals,
  platformReplacements,
  propertyReproductions,
  preservationPlan,
  promotionPermissionItems,
  promotionTransition,
  readAccessDependents,
  readEquivalenceObjects,
  readReservedNames,
  readWritePath,
  renameIntent,
  stepConversions,
  unclassifiedRemovals,
  unrealizedRenames,
  valueElementColumns,
  withTempNames,
  type CanonicalRename,
  type EquivalenceObject,
  type PromotionInput,
  type RenameIntent,
  type TransitionVerdict,
  type WritePath,
} from "./promotion"
import { readSessionSearchPath } from "./settings"
import { readAppliedPromotions, readApplyState } from "./state"
import {
  classifySteps,
  lintSteps,
  requiredPermissions,
  stepId,
  type PlanStep,
} from "./steps"
import { tableKey } from "./table-key"
import { typeChangeRefusals, typeGuards, type TypeChange } from "./type-guard"
import { PLATFORM_VERSION } from "./version"

export interface PlanDatabases {
  /** Ціль і тіні — лише читання. */
  reader: ApplyDatabase
  /** Лише жертовна копія. */
  scratch: ApplyDatabase
}

export type PlanOutcome =
  | {
      status: "planned"
      artifact: PlanArtifact
      diagnostics: EngineDiagnostic[]
      /**
       * Скільки сліпих функцій цілі — очікувані пресетом провайдера
       * (рішення 5 плану П3-2b-1): вивід їх лише лічить, без попередження.
       */
      expectedBlindFunctions: number
    }
  | { status: "unchanged"; diagnostics: EngineDiagnostic[] }
  | { status: "refused"; diagnostics: EngineDiagnostic[] }

/**
 * `planHash` прогону-доказу: копію буде викинуто, тож marker копії не
 * посилається на жоден справжній артефакт.
 */
const PROOF_PLAN_HASH = "proof"

/** Скільки шляхів різниці моделей називає відмова точності копії. */
const MISMATCH_PATH_LIMIT = 20

/** Скільки об'єктів називає відмова власників; решту дає лише `count`. */
const OWNER_LIMIT = 20

/** Модель і відбиток однієї бази, зняті під однією межею. */
interface Witness {
  extracted: Extracted
  fingerprint: CatalogFingerprint
}

const refused = (diagnostics: EngineDiagnostic[]): PlanOutcome => ({
  status: "refused",
  diagnostics,
})

const hasError = (diagnostics: readonly EngineDiagnostic[]): boolean =>
  diagnostics.some((d) => d.severity === "error")

/**
 * Коди діагностик витягу, що в плані — попередження, а не відмова.
 * `engine.unrepresentable` каже, що модель каталогу — проєкція для зворотної
 * генерації — не несе властивість бази (опції identity, власник). У плані
 * модель — лише деталь дрейфу й `resultCatalog`: властивість бачить відбиток
 * (рішення 2 і 3 плану П3-1), а збіжність перевіряє доказ. У `diff` і
 * `introspect` модель і є результатом, тож там код лишається помилкою.
 */
const PLAN_WARNINGS: ReadonlySet<RuleCode> = new Set<RuleCode>([
  "engine.unrepresentable",
])

const forPlan = (d: EngineDiagnostic): EngineDiagnostic =>
  PLAN_WARNINGS.has(d.code) ? { ...d, severity: "warning" } : d

const byCodeUnit = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0

/**
 * Межа плану — межа моделі ∪ межа з marker (рішення 2 плану П3-1): об'єкти
 * схеми, яку метадані покинули, стають кроками видалення з дозволом, а не
 * мовчазними сиротами поза межею.
 */
function planScope(
  model: EngineScope,
  marker: EngineScope | undefined
): EngineScope {
  return {
    schemas: [...new Set([...model.schemas, ...(marker?.schemas ?? [])])].sort(
      byCodeUnit
    ),
    provider: model.provider,
  }
}

const sameScope = (a: EngineScope, b: EngineScope): boolean =>
  a.provider === b.provider &&
  JSON.stringify([...a.schemas].sort(byCodeUnit)) ===
    JSON.stringify([...b.schemas].sort(byCodeUnit))

/**
 * Секції, що розійшлися між різними базами: без `owner`, бо ролі сесії копії
 * й тіні можуть бути іншими. Обидва відбитки читає той самий код, тож
 * непорівнянна версія означала б дефект — тоді розбіжні всі секції.
 */
function differingAcross(
  expected: CatalogFingerprint,
  actual: CatalogFingerprint
): FingerprintSection[] {
  const comparison = compareFingerprints(expected, actual, { owner: false })
  return comparison.comparable
    ? comparison.differing
    : FINGERPRINT_SECTIONS.filter((s) => s !== "owner")
}

/**
 * Сторожі й зміни типу кроків одним розбором кожного: відмова побудувати
 * сторожа — окремо, зміни — для детектора залежних і приведень на базі.
 */
function guardedChanges(
  steps: readonly PlanStep[],
  source: CatalogModel,
  parse: SqlParser
): { refusals: EngineDiagnostic[]; changes: TypeChange[] } {
  const refusals: EngineDiagnostic[] = []
  const changes: TypeChange[] = []
  for (const step of steps) {
    const guarded = typeGuards(step, source, parse)
    if ("refusal" in guarded) refusals.push(guarded.refusal)
    else changes.push(...guarded.changes)
  }
  return { refusals, changes }
}

/**
 * Конвеєр плану (платформна спека §6.2 п.2–4, §6.6; задача 9 плану П3-1):
 * стан застосування, гейт дрейфу, план від живої цілі до бажаного стану,
 * класи, лінт і дозволи, доказ на жертовній копії тим самим раннером і
 * детермінований артефакт. Дрейф планування не зупиняє: він іде в артефакт
 * пунктом дозволу (рішення 16). Ціль і тіні лише читаються (`reader`), пише
 * тільки прогін-доказ у копію (`scratch`).
 *
 * `promotions` — записи промоції з `plans/`; порожній масив передається
 * явно: перехід виявляється з ідентичності, а записи з ним лише звіряються
 * (рішення 1 плану П3-2a). План із промоцією будує `planPromotion`.
 */
export async function buildPlan(
  engine: SchemaEngine,
  dbs: PlanDatabases,
  model: CompiledModel,
  o: ShadowOptions,
  promotions: readonly PromotionInput[]
): Promise<PlanOutcome> {
  const witness = async (
    db: DbConnection,
    scope: EngineScope
  ): Promise<Witness> => {
    const [extracted, fingerprint] = await Promise.all([
      engine.extract(db, scope),
      dbs.reader.transaction(db, "rollback", (tx) =>
        readFingerprint(tx, scope)
      ),
    ])
    return { extracted, fingerprint }
  }

  // 1–2. Бажаний стан і стан застосування цілі; пошкоджений стан лагодять
  // вручну, а не дозволом
  const desired = await desiredForApply(model)
  const state = await dbs.reader.transaction(o.target, "rollback", (tx) =>
    readApplyState(tx)
  )
  if (state.status === "corrupt") return refused([state.diagnostic])
  const markerScope =
    state.status === "applied" ? state.marker.scope : undefined
  const scope = planScope(desired.scope, markerScope)

  // 2а. Власники цілі — до будь-якого витягу: об'єкт ролі, членом якої роль
  // сесії не є, план не зніме й не змінить, а двигун на такій цілі навіть
  // витяг не будує. Тож це відмова з порадою ще до гейта
  const membership = await checkOwnerMembership(
    dbs.reader,
    o.target,
    scope,
    "plan.owner-mismatch"
  )
  if (membership.refusal !== undefined) return refused([membership.refusal])
  const targetOwners = membership.owners

  // 3. Гейт дрейфу порівнює ціль, зняту під межею з marker: інакше зміна
  // межі виглядала б дрейфом. Коли межі збігаються, свідок той самий, що й
  // джерело плану; першому застосуванню свідок гейта не потрібен
  const live = await witness(o.target, scope)
  const gateWitness =
    markerScope === undefined || sameScope(markerScope, scope)
      ? live
      : await witness(o.target, markerScope)
  const verdict = driftGate(state, {
    model: gateWitness.extracted.model,
    fingerprint: gateWitness.fingerprint,
    engine: engine.identity,
  })
  if (!verdict.ok) return refused(verdict.diagnostics)
  const { drift, fromHash } = verdict

  // 3а. Перехід промоції — з ідентичності marker і бажаної моделі; записи
  // звіряються з ним за таблицею рішень (рішення 1 плану П3-2a)
  const appliedHashes = await dbs.reader.transaction(
    o.target,
    "rollback",
    (tx) => readAppliedPromotions(tx)
  )
  const transition = await promotionTransition({
    state,
    model,
    records: promotions,
    appliedHashes,
    liveTables: new Set(
      live.extracted.model.tables.map((t) => tableKey(t.schema, t.name))
    ),
  })
  if (transition.status === "refused")
    return refused(dedupe([...verdict.diagnostics, ...transition.diagnostics]))
  if (transition.status === "promotion") {
    // Вердикт несе той самий об'єкт запису, що прийшов на вхід
    const input = promotions.find((p) => p.record === transition.record)
    if (input === undefined)
      throw new Error(
        "the promotion verdict names a record that was not passed"
      )
    return planPromotion({
      engine,
      dbs,
      model,
      o,
      witness,
      scope,
      live,
      desired,
      drift,
      fromHash,
      targetOwners,
      promotion: transition,
      file: input.file,
      diagnostics: dedupe([
        ...verdict.diagnostics,
        ...transition.diagnostics,
        ...desired.diagnostics,
      ]),
    })
  }

  // 4–5. План «ціль → бажана тінь» і модель та відбиток тіні під межею плану.
  // Тінь живе лише в колбеку, тож усе з неї знімається тут
  const shadow = await engine.withDesiredShadow(
    o,
    desired.sql,
    scope,
    async (db, enginePlan) => ({
      enginePlan,
      ...(await dbs.reader.transaction(db, "rollback", async (tx) => ({
        owners: await readOwners(tx, scope),
        desiredInvalid: await readInvalidObjects(tx, scope),
      }))),
      ...(await witness(db, scope)),
    })
  )
  if (shadow.status === "shadow-failed")
    return refused(
      dedupe([
        ...verdict.diagnostics,
        ...transition.diagnostics,
        ...desired.diagnostics,
        ...shadow.diagnostics,
      ])
    )
  const target = shadow.value
  const diagnostics = dedupe([
    ...verdict.diagnostics,
    ...transition.diagnostics,
    ...desired.diagnostics,
    ...shadow.diagnostics,
    ...live.extracted.diagnostics.map(forPlan),
    ...target.extracted.diagnostics.map(forPlan),
  ])
  // Помилка межі чи двигуна означає, що план бачить не все: «порожньо» чи
  // кроки тоді можуть приховати втрати
  if (hasError(diagnostics)) return refused(diagnostics)

  // Власник — керована властивість (платформна спека §6.7): об'єкти тримає
  // роль, що застосовує. Двигун підміну власника не сходить, а прийняти її
  // базою означало б узаконити чужого власника, що обходить RLS. Доки кроку
  // відновлення власника немає, це відмова з порадою
  const mismatched = ownerMismatches(targetOwners, target.owners)
  if (mismatched.length > 0)
    return refused([
      ...diagnostics,
      ownersDiagnostic("plan.owner-mismatch", mismatched),
    ])
  const { actions } = target.enginePlan

  // 6. Нічого застосовувати лише тоді, коли немає ні кроків, ні нового
  // знімка, ні дрейфу. Дрейф без кроків (зміна версій) — план із нулем кроків:
  // інакше дрейф не було б як прийняти, і кожен наступний план бачив би його
  if (actions.length === 0 && fromHash === model.hash && drift === null)
    return { status: "unchanged", diagnostics }

  // 7. Класи — від моделі вихідного стану плану, тобто живої цілі: з
  // порожньою моделлю кожна зміна типу стала б `destructive`
  const parse = await loadSqlParser()
  const unparsable = unparsableSteps(actions, parse)
  if (unparsable.length > 0) return refused([...diagnostics, ...unparsable])
  const planSteps = classifySteps(actions, live.extracted.model, parse)
  // Зміна типу, якій сторожа не побудувати, — відмова, а не крок без
  // перевірки: інакше дозвіл на `destructive` знову означав би «обріж мовчки»
  const guarded = guardedChanges(planSteps, live.extracted.model, parse)
  const lint = [...lintSteps(planSteps, parse), ...guarded.refusals]
  if (lint.length > 0) return refused([...diagnostics, ...lint])
  // 7а. Кроки середовища (рішення 5 плану П3-2b-0) — наприкінці плану; клас
  // і дозволи рахуються вже з ними
  const collected = await collectEnvironment({
    engine,
    dbs,
    o,
    scope,
    witness,
    live,
    desired: target.extracted.catalog,
    role: targetOwners.session,
    steps: planSteps,
    parse,
  })
  if (!collected.ok) return refused([...diagnostics, ...collected.diagnostics])
  const { environment } = collected
  const steps = [...planSteps, ...collected.steps]
  const permissions = requiredPermissions({ steps, drift, promotion: null })
  // Слід кроків — те саме правило, що й для плану з промоцією (R26); без
  // промоції імена вихідного стану й кроків збігаються
  const {
    locks,
    implicitLocks,
    providerLocks,
    foreignKeys,
    lockWarnings,
    revalidationSearchPath,
    blindFunctions,
    plpgsqlCheck,
    checkDiagnostics,
  } = await lockPlan(dbs.reader, o.target, {
    scope,
    role: targetOwners.session,
    steps,
    parse,
    promotion: false,
    models: {
      source: live.extracted.model,
      desired: target.extracted.model,
      typeChanges: guarded.changes,
      newToOld: new Map(),
      columnsNewToOld: new Map(),
    },
  })
  const { preamble } = target.enginePlan

  // 8–10. Доказ на копії. План доказу несе той самий дрейф, тож дозволи
  // `requiredPermissions` йому відповідають
  const proof = await prove(engine, dbs, o, witness, {
    scope,
    live,
    desired: target,
    model,
    typeChanges: guarded.changes,
    plan: {
      fromHash,
      toHash: model.hash,
      scope,
      engine: engine.identity,
      steps,
      requiredPermissions: permissions,
      drift,
      role: targetOwners.session,
      locks,
      implicitLocks,
      providerLocks,
      foreignKeys,
      preamble,
      revalidationSearchPath,
      plpgsqlCheck,
      desiredInvalid: target.desiredInvalid,
      promotion: null,
      environment,
      targetFingerprint: live.fingerprint,
      desiredFingerprint: target.fingerprint,
      // Модель бажаної тіні лише для marker копії, яку буде викинуто;
      // справжній `resultCatalog` — модель копії після прогону
      resultCatalog: target.extracted.model,
    },
  })
  if (!proof.ok) return refused(dedupe([...diagnostics, ...proof.diagnostics]))

  // 11. Артефакт: межа плану, дрейф вердикта й дозволи з дрейфом першим
  const artifact = await stampPlan({
    format: PLAN_FORMAT,
    platformVersion: PLATFORM_VERSION,
    engine: engine.identity,
    fingerprintVersion: FINGERPRINT_VERSION,
    fromHash,
    toHash: model.hash,
    scope,
    targetFingerprint: live.fingerprint,
    desiredFingerprint: target.fingerprint,
    steps,
    requiredPermissions: permissions,
    drift,
    role: targetOwners.session,
    locks,
    implicitLocks,
    providerLocks,
    foreignKeys,
    preamble,
    revalidationSearchPath,
    plpgsqlCheck,
    desiredInvalid: target.desiredInvalid,
    promotion: null,
    environment,
    resultCatalog: proof.resultCatalog,
  })
  return {
    status: "planned",
    artifact,
    expectedBlindFunctions: blindFunctions.expected.length,
    diagnostics: dedupe([
      ...diagnostics,
      ...collected.diagnostics,
      ...lockWarnings,
      ...checkDiagnostics,
      ...blindWarning(blindFunctions.blind),
      ...proof.diagnostics,
      applyDiagnostic("plan.schema-only-proof", "warning"),
    ]),
  }
}

/** Що конвеєр П3-1 уже зібрав до гілки промоції. */
interface PromotionContext {
  engine: SchemaEngine
  dbs: PlanDatabases
  model: CompiledModel
  o: ShadowOptions
  witness: (db: DbConnection, scope: EngineScope) => Promise<Witness>
  scope: EngineScope
  live: Witness
  desired: ApplyDesired
  drift: DriftReport | null
  fromHash: string | null
  targetOwners: { session: string; owners: ObjectOwner[] }
  promotion: Extract<TransitionVerdict, { status: "promotion" }>
  /** Файл запису в `plans/`: його називають відмови виявлення. */
  file: string
  /** Діагностики гейта, переходу й бажаного стану. */
  diagnostics: EngineDiagnostic[]
}

/** Таблиця, як її бачить ціль чи копія. */
interface TableName {
  schema: string
  name: string
}

/**
 * План із промоцією (рішення 2, 9, 10, 12 плану П3-2a). Ціль ще має старі
 * імена, тож план будується з першої копії після кроків наміру
 * (перейменування таблиць і колонок, далі канонічні імена), а не з живої
 * цілі: двигун з `renames: "off"` перетворив би перейменування на DROP +
 * CREATE. Порядок на першій копії (R5): намір → канонічні імена → витяг →
 * план двигуна з опціями живої цілі → класи й сторожі → детектор залежних і
 * приведення. Далі — класи видалень, доступ, блокування й збереження, доказ
 * усього плану на другій, свіжій копії й артефакт із секцією `promotion`.
 * Читання цілі — лише транзакції `READ ONLY` порту (`reader`).
 */
async function planPromotion(c: PromotionContext): Promise<PlanOutcome> {
  const { engine, dbs, o, scope, live, promotion } = c
  const { record } = promotion
  const oldTables = record.tables.map((t): TableName => ({
    schema: t.schema,
    name: t.from,
  }))
  const newTables = record.tables.map((t): TableName => ({
    schema: t.schema,
    name: t.to,
  }))

  // Послідовність поза схемою таблиці (R17) і шлях запису через API
  // (рішення 10) — на живій цілі, до тіні й копій: обидва — відмова з
  // порадою, і жодна копія тут нічого не уточнить
  const blocked = await dbs.reader.transaction(
    o.target,
    "rollback",
    async (tx) => [
      ...(await foreignSequenceRefusals(tx, { record, file: c.file })),
      ...writePathRefusal(
        oldTables,
        await readWritePath(tx, {
          tables: oldTables,
          apiRoles: Object.values(PROVIDER_API_ROLES[scope.provider]),
        })
      ),
    ]
  )
  if (blocked.length > 0) return refused(dedupe([...c.diagnostics, ...blocked]))

  // Бажана тінь: модель, відбиток, власники й об'єкти еквівалентності таблиць
  // одиниці в нових іменах. План «ціль → тінь» порту тут не потрібен: план
  // будується з копії після наміру
  const shadow = await engine.withDesiredShadow(
    o,
    c.desired.sql,
    scope,
    async (db) => ({
      ...(await dbs.reader.transaction(db, "rollback", async (tx) => ({
        owners: await readOwners(tx, scope),
        desiredInvalid: await readInvalidObjects(tx, scope),
        equivalence: await readEquivalenceObjects(tx, newTables),
      }))),
      ...(await c.witness(db, scope)),
    })
  )
  if (shadow.status === "shadow-failed")
    return refused(dedupe([...c.diagnostics, ...shadow.diagnostics]))
  const target = shadow.value
  const diagnostics = dedupe([
    ...c.diagnostics,
    ...shadow.diagnostics,
    ...live.extracted.diagnostics.map(forPlan),
    ...target.extracted.diagnostics.map(forPlan),
  ])
  if (hasError(diagnostics)) return refused(diagnostics)

  // Власники тіні — у нових іменах, цілі — ще в старих: без перекладу
  // перейменовані таблиці випали б із порівняння (рішення 9)
  const intent = renameIntent(record, c.model.physical)
  const mismatched = ownerMismatches(
    c.targetOwners,
    ownersInOldNames(target.owners, intent.tablesNewToOld)
  )
  if (mismatched.length > 0)
    return refused([
      ...diagnostics,
      ownersDiagnostic("plan.owner-mismatch", mismatched),
    ])

  const parse = await loadSqlParser()
  const cloned = await engine.withTargetClone(
    o,
    live.extracted,
    scope,
    (clone) =>
      analyseOnClone({
        engine,
        scratch: dbs.scratch,
        clone,
        scope,
        intent,
        oldTables,
        newTables,
        shadowEquivalence: target.equivalence,
        desired: target.extracted.catalog,
        optionsFrom: live.extracted.catalog,
        parse,
      })
  )
  if (cloned.status === "shadow-failed")
    return refused(dedupe([...diagnostics, ...cloned.diagnostics]))
  const analysis = cloned.value
  const withClone = dedupe([
    ...diagnostics,
    ...cloned.diagnostics,
    ...analysis.diagnostics,
  ])
  if (!analysis.ok || hasError(withClone)) return refused(withClone)
  const { steps: planSteps, model: cloneModel } = analysis

  // Класи видалень і нереалізовані перейменування — копія після наміру
  // проти бажаної тіні (рішення 2, 7)
  const removals = classifyRemovals({
    record,
    intent: analysis.intent,
    clone: cloneModel,
    desired: target.extracted.model,
    parse,
  })
  // Клас `platform` — лише за наявного механізму-заміни (рішення 7, R9 плану
  // П3-2b-0): колонки `Ref` на перерахування — з бажаної моделі через реєстр
  const unclassified = [
    ...unrealizedRenames(planSteps, analysis.intent, record),
    ...unclassifiedRemovals(removals),
    ...platformReplacements({
      record,
      cloneEquivalence: analysis.equivalence,
      shadowEquivalence: target.equivalence,
      desired: target.extracted.model,
      valueElementColumns: valueElementColumns(c.model),
      parse,
    }),
    // Клас `property` — лише за еквівалентного відтворення в тіні (R10):
    // запис, метадані після `promote` чи ручна правка класу не доводять
    ...propertyReproductions({
      record,
      cloneEquivalence: analysis.equivalence,
      shadowEquivalence: target.equivalence,
    }),
  ]
  if (unclassified.length > 0) return refused([...withClone, ...unclassified])

  // Кроки середовища (рішення 5 плану П3-2b-0): копія цілі в старих іменах
  // проходить і кроки наміру, і кроки двигуна, тож залишок — у нових
  const collected = await collectEnvironment({
    engine,
    dbs,
    o,
    scope,
    witness: c.witness,
    live,
    desired: target.extracted.catalog,
    role: c.targetOwners.session,
    steps: planSteps,
    parse,
  })
  if (!collected.ok) return refused([...withClone, ...collected.diagnostics])
  const { environment } = collected
  const steps = [...planSteps, ...collected.steps]

  // Залежні доступу (рішення 8) — з живої цілі, у старих іменах, транзакцією
  // READ ONLY
  const dependents = await dbs.reader.transaction(o.target, "rollback", (tx) =>
    readAccessDependents(
      tx,
      record.tables.map((t) => ({
        schema: t.schema,
        name: t.from,
        forcedToEnabled: record.rowLevelSecurity.some(
          (r) =>
            r.schema === t.schema && r.table === t.from && r.from === "forced"
        ),
      }))
    )
  )
  const access = accessChanges({
    record,
    intent: analysis.intent,
    clone: cloneModel,
    desired: target.extracted.model,
    dependents,
    parse,
  })
  // `delete:*` — лише з виведених фактів (R3), запис для них не читається
  const permissionItems = promotionPermissionItems(
    access,
    promotion.facts.deleteSemantics,
    removals
  )
  // Слід кроків двигуна — від копії після наміру, у нових іменах, і
  // перекладається в старі (R26)
  const {
    locks,
    implicitLocks,
    providerLocks,
    foreignKeys,
    lockWarnings,
    revalidationSearchPath,
    blindFunctions,
    plpgsqlCheck,
    checkDiagnostics,
  } = await lockPlan(dbs.reader, o.target, {
    scope,
    role: c.targetOwners.session,
    steps,
    parse,
    promotion: true,
    models: {
      source: cloneModel,
      desired: target.extracted.model,
      typeChanges: analysis.changes,
      newToOld: analysis.intent.tablesNewToOld,
      columnsNewToOld: columnsNewToOld(analysis.intent.columns),
    },
  })
  // Промоція без `plpgsql_check` — відмова до доказу (рішення 4 плану П3-2b-1)
  if (hasError(checkDiagnostics))
    return refused([...withClone, ...checkDiagnostics])
  const typeChangeSteps = new Map(
    analysis.changes.map((t) => [
      JSON.stringify([t.schema, t.table, t.column]),
      t.step,
    ])
  )
  const section: PromotionSection = {
    recordHash: promotion.recordHash,
    record,
    permissionItems,
    preservation: preservationPlan(
      record,
      analysis.intent,
      { tables: promotion.source },
      typeChangeSteps
    ),
    columns: analysis.intent.columns,
    canonicalNames: analysis.canonicalNames,
    // Лише показ (R6): дозволи й класи кроків від нього не залежать
    conversions: [
      ...stepConversions(steps, record, analysis.intent, parse),
    ].map(([step, cls]) => ({ step, class: cls })),
  }
  const permissions = requiredPermissions({
    steps,
    drift: c.drift,
    promotion: section,
  })

  // Доказ усього плану на другій, свіжій копії. Залежні й приведення змін
  // типу вже перевірено на першій копії після наміру: на цій таблиці ще
  // мають старі імена, і детектор їх би не знайшов
  const proof = await prove(engine, dbs, o, c.witness, {
    scope,
    live,
    desired: target,
    model: c.model,
    typeChanges: [],
    plan: {
      fromHash: c.fromHash,
      toHash: c.model.hash,
      scope,
      engine: engine.identity,
      steps,
      requiredPermissions: permissions,
      drift: c.drift,
      role: c.targetOwners.session,
      locks,
      implicitLocks,
      providerLocks,
      foreignKeys,
      preamble: analysis.preamble,
      revalidationSearchPath,
      plpgsqlCheck,
      desiredInvalid: target.desiredInvalid,
      promotion: section,
      environment,
      targetFingerprint: live.fingerprint,
      desiredFingerprint: target.fingerprint,
      resultCatalog: target.extracted.model,
    },
  })
  if (!proof.ok) return refused(dedupe([...withClone, ...proof.diagnostics]))

  const artifact = await stampPlan({
    format: PLAN_FORMAT,
    platformVersion: PLATFORM_VERSION,
    engine: engine.identity,
    fingerprintVersion: FINGERPRINT_VERSION,
    fromHash: c.fromHash,
    toHash: c.model.hash,
    scope,
    targetFingerprint: live.fingerprint,
    desiredFingerprint: target.fingerprint,
    steps,
    requiredPermissions: permissions,
    drift: c.drift,
    role: c.targetOwners.session,
    locks,
    implicitLocks,
    providerLocks,
    foreignKeys,
    preamble: analysis.preamble,
    revalidationSearchPath,
    plpgsqlCheck,
    desiredInvalid: target.desiredInvalid,
    promotion: section,
    environment,
    resultCatalog: proof.resultCatalog,
  })
  return {
    status: "planned",
    artifact,
    expectedBlindFunctions: blindFunctions.expected.length,
    diagnostics: dedupe([
      ...withClone,
      ...collected.diagnostics,
      ...lockWarnings,
      ...checkDiagnostics,
      ...blindWarning(blindFunctions.blind),
      ...proof.diagnostics,
      applyDiagnostic("plan.schema-only-proof", "warning"),
      // Межа 2a (рішення 12): людина дізнається про неї до `apply`
      applyDiagnostic("plan.promotion-commit-pending", "warning"),
    ]),
  }
}

/**
 * Відмова шляху запису: усі знахідки однією діагностикою. `table` — лише
 * таблиці, яких знахідки стосуються, у порядку одиниці.
 */
function writePathRefusal(
  tables: readonly TableName[],
  found: readonly WritePath[]
): EngineDiagnostic[] {
  if (found.length === 0) return []
  const hit = new Set(
    found.flatMap((f) => f.tables.map((t) => tableKey(t.schema, t.name)))
  )
  return [
    applyDiagnostic("plan.write-path", "error", {
      table: tables
        .filter((t) => hit.has(tableKey(t.schema, t.name)))
        .map((t) => `${quoteIdent(t.schema)}.${quoteIdent(t.name)}`)
        .join(", "),
      detail: found.map((f) => f.detail).join("; "),
    }),
  ]
}

type CloneAnalysis =
  | {
      ok: true
      /** Кроки наміру, далі кроки двигуна, нумерація наскрізна. */
      steps: PlanStep[]
      /** Модель копії після наміру: вихідний стан кроків двигуна. */
      model: CatalogModel
      /** Намір разом із тимчасовими іменами канонічних перейменувань. */
      intent: RenameIntent
      /**
       * Об'єкти еквівалентності копії після наміру, до канонічних імен: імена
       * обмежень та індексів — ще початкові (гейт класу `platform`).
       */
      equivalence: EquivalenceObject[]
      canonicalNames: CanonicalRename[]
      changes: TypeChange[]
      preamble: EnginePlan["preamble"]
      diagnostics: EngineDiagnostic[]
    }
  | { ok: false; diagnostics: EngineDiagnostic[] }

/** Крок наміру впав на копії: ціль не така, як каже запис. */
class IntentStepFailed extends Error {
  constructor(readonly diagnostic: EngineDiagnostic) {
    super(diagnostic.message)
    this.name = "IntentStepFailed"
  }
}

/** Кроки наміру на копії однією транзакцією з `COMMIT`. */
async function runOnClone(
  scratch: ApplyDatabase,
  clone: DbConnection,
  steps: readonly PlanStep[]
): Promise<void> {
  if (steps.length === 0) return
  await scratch.transaction(clone, "commit", async (tx) => {
    for (const step of steps) {
      try {
        await tx.query(step.sql)
      } catch (error) {
        if (!(error instanceof ApplyDbError)) throw error
        throw new IntentStepFailed(
          applyDiagnostic("apply.step-failed", "error", {
            step: step.id,
            sqlstate: error.sqlstate ?? "unknown",
            error: error.message,
          })
        )
      }
    }
  })
}

/**
 * Перша копія (рішення 2, R5 плану П3-2a): кроки наміру й канонічні імена
 * виконуються на ній, план двигуна знімається з неї після них, а класи,
 * сторожі, залежні й приведення змін типу питають саме її — там уже нові
 * імена й старі типи. Опції плану — від живої цілі: план застосовують до неї.
 */
async function analyseOnClone(p: {
  engine: SchemaEngine
  scratch: ApplyDatabase
  clone: DbConnection
  scope: EngineScope
  intent: RenameIntent
  /** Таблиці одиниці в старих іменах: їхні колонки й обмеження займає намір. */
  oldTables: readonly TableName[]
  newTables: readonly TableName[]
  shadowEquivalence: readonly EquivalenceObject[]
  desired: Extracted["catalog"]
  optionsFrom: Extracted["catalog"]
  parse: SqlParser
}): Promise<CloneAnalysis> {
  const { engine, scratch, clone, scope, parse } = p
  try {
    // Тимчасові імена наміру вже зайняті — відмова плану, а не сирий
    // `42701`/`42P07` кроку наміру на копії (рішення 11 плану П3-2b-1)
    const taken = await scratch.transaction(clone, "rollback", (tx) =>
      readReservedNames(tx, {
        schemas: [...new Set(p.oldTables.map((t) => t.schema))],
        tables: p.oldTables,
      })
    )
    if (taken.length > 0)
      return {
        ok: false,
        diagnostics: [
          applyDiagnostic("plan.temp-name-taken", "error", {
            names: taken.join(", "),
          }),
        ],
      }
    const renames = p.intent.steps.map((s, i) => ({ ...s, id: stepId(i) }))
    await runOnClone(scratch, clone, renames)
    const equivalence = await scratch.transaction(clone, "rollback", (tx) =>
      readEquivalenceObjects(tx, p.newTables)
    )
    const canonical = canonicalRenames(
      equivalence,
      p.shadowEquivalence,
      p.intent.tablesNewToOld
    )
    const names = canonical.steps.map((s, i) => ({
      ...s,
      id: stepId(renames.length + i),
    }))
    await runOnClone(scratch, clone, names)

    const extracted = await engine.extract(clone, scope)
    const enginePlan = engine.plan(extracted.catalog, p.desired, scope, {
      optionsFrom: p.optionsFrom,
    })
    const diagnostics = [
      ...extracted.diagnostics.map(forPlan),
      ...enginePlan.diagnostics,
    ]
    if (hasError(diagnostics)) return { ok: false, diagnostics }

    const offset = renames.length + names.length
    const { actions } = enginePlan
    const unparsable = unparsableSteps(actions, parse, offset)
    if (unparsable.length > 0)
      return { ok: false, diagnostics: [...diagnostics, ...unparsable] }
    // Виняток «заміна» не діє для прийнятого об'єкта таблиці одиниці
    // (рішення 3): рахується з дій до класифікатора, бо він — його вхід
    const unitTables = new Set(
      p.newTables.map((t) => tableKey(t.schema, t.name))
    )
    const engineSteps = classifySteps(actions, extracted.model, parse, offset, {
      noReplacement: adoptedReplacements(
        actions,
        extracted.model,
        unitTables,
        offset
      ),
    })
    const steps = [...renames, ...names, ...engineSteps]
    const guarded = guardedChanges(engineSteps, extracted.model, parse)
    const lint = [...lintSteps(steps, parse), ...guarded.refusals]
    if (lint.length > 0)
      return { ok: false, diagnostics: [...diagnostics, ...lint] }
    const blocked =
      guarded.changes.length === 0
        ? []
        : await scratch.transaction(clone, "rollback", (tx) =>
            typeChangeRefusals(tx, guarded.changes, steps)
          )
    if (blocked.length > 0)
      return { ok: false, diagnostics: [...diagnostics, ...blocked] }
    return {
      ok: true,
      steps,
      model: extracted.model,
      intent: withTempNames(p.intent, canonical.tempNames),
      equivalence,
      canonicalNames: canonical.renames,
      changes: guarded.changes,
      preamble: enginePlan.preamble,
      diagnostics,
    }
  } catch (error) {
    if (error instanceof IntentStepFailed)
      return { ok: false, diagnostics: [error.diagnostic] }
    // Копія жертовна: обрив з'єднання з нею — недоведеність, а не стан цілі
    if (error instanceof ApplyConnectionLost)
      return {
        ok: false,
        diagnostics: [
          applyDiagnostic("engine.clone-failed", "error", {
            detail:
              "the connection to the copy was lost while planning the promotion, so the plan could not be built; nothing was written to the database",
          }),
        ],
      }
    throw error
  }
}

/**
 * Власники тіні в старих іменах перейменованих таблиць. Перепис називає
 * таблицю `relation <схема>.<ім'я>` у формі `regclass`, яку дає й
 * `quoteIdent`; залежні об'єкти (індекси, послідовності колонок) `readOwners`
 * уже пропустив.
 */
function ownersInOldNames(
  shadow: { session: string; owners: readonly ObjectOwner[] },
  newToOld: ReadonlyMap<string, string>
): { session: string; owners: ObjectOwner[] } {
  const relation = (key: string): string => {
    const [schema, name] = JSON.parse(key) as [string, string]
    return `relation ${quoteIdent(schema)}.${quoteIdent(name)}`
  }
  const renamed = new Map(
    [...newToOld].map(([to, from]) => [relation(to), relation(from)])
  )
  return {
    session: shadow.session,
    owners: shadow.owners.map((o) => ({
      ...o,
      object: renamed.get(o.object) ?? o.object,
    })),
  }
}

/**
 * Старе ім'я кожної колонки, яку намір перейменував, за її новим іменем:
 * ланцюжок перейменувань у порядку кроків (обмін іде через тимчасове ім'я).
 */
function columnsNewToOld(
  columns: RenameIntent["columns"]
): Map<string, string> {
  const original = new Map<string, string>()
  for (const c of columns) {
    const from = JSON.stringify([c.table.schema, c.table.name, c.from])
    const first = original.get(from) ?? c.from
    original.delete(from)
    original.set(JSON.stringify([c.table.schema, c.table.name, c.to]), first)
  }
  return original
}

/**
 * Блокування плану за слідом кроків (спека промоції §7.2, «З'єднання й
 * блокування», R26 і R27 плану П3-2a): слід кожного кроку з провайдерськими
 * замками, право ролі на явний
 * `LOCK` кожної його таблиці на живій цілі (READ ONLY) і замки з неявними
 * замками. `ACCESS EXCLUSIVE` на таблиці поза межею двигуна — попередження:
 * її читання блоковані на всю транзакцію.
 *
 * Тією самою транзакцією READ ONLY — те, що ціль дає ревалідації тіл
 * (рішення 2, 5 плану П3-2b-1): шлях пошуку сесії, під яким раннер перевіряє
 * тіла, і функції, яких перевірка не бачить, для попередження у виводі плану.
 */
async function lockPlan(
  reader: ApplyDatabase,
  target: DbConnection,
  o: {
    scope: EngineScope
    role: string
    steps: readonly PlanStep[]
    parse: SqlParser
    /** План несе промоцію: без `plpgsql_check` — відмова, а не попередження. */
    promotion: boolean
    models: Omit<
      FootprintModels,
      "live" | "providerStatements" | "providerLocks"
    >
  }
): Promise<{
  locks: TableLock[]
  implicitLocks: ImplicitLock[]
  providerLocks: ProviderLockSet[]
  foreignKeys: PlanArtifact["foreignKeys"]
  lockWarnings: EngineDiagnostic[]
  revalidationSearchPath: string
  blindFunctions: BlindFunctions
  plpgsqlCheck: PlpgsqlCheckMode
  /** Попередження чи відмова `plan.plpgsql-check-unavailable`. */
  checkDiagnostics: EngineDiagnostic[]
}> {
  const { scope, steps } = o
  const statements = providerStatements(steps, o.parse)
  // Перелік провайдера й FK живої цілі — до сліду: таблиці провайдера й
  // таблиця поза межею двигуна, що посилається на колонку зі зміною типу,
  // моделям каталогу невидимі. Права — тією самою транзакцією READ ONLY
  const {
    footprint,
    rights,
    providerLocks,
    foreignKeys,
    revalidationSearchPath,
    blindFunctions,
    checks,
  } = await reader.transaction(target, "rollback", async (tx) => {
    const providerLocks = await readProviderLocks(
      tx,
      o.role,
      PROVIDER_LOCKS[scope.provider]
    )
    // Таблиці й FK — в артефакт (рішення 9 плану П3-2b-1): раннер звіряє їх
    // тим самим читанням перед блокуваннями
    const subjects = footprintSubjects(steps, o.models)
    const live = await readLiveForeignKeys(tx, subjects)
    const footprint = planFootprint(steps, {
      ...o.models,
      live,
      providerStatements: statements,
      providerLocks,
    })
    const checks = await planFunctionChecks(tx, {
      promotion: o.promotion,
      installable: PROVIDER_INSTALLABLE_EXTENSIONS[scope.provider],
    })
    return {
      footprint,
      providerLocks,
      foreignKeys: { subjects, live },
      rights: await readLockRights(tx, footprintTables(footprint)),
      revalidationSearchPath: await readSessionSearchPath(tx),
      checks,
      blindFunctions: await readBlindFunctions(
        tx,
        checks.mode === "unavailable" ? "unavailable" : "available",
        PROVIDER_EXPECTED_BLIND_FUNCTIONS[scope.provider]
      ),
    }
  })
  const { locks, implicitLocks } = planLocks({ footprint, rights })
  // Крок попередження — перший, чий слід бере на таблиці ACCESS EXCLUSIVE
  const exclusiveStep = (l: TableLock): string =>
    footprint.find((f) =>
      f.tables.some(
        (t) =>
          t.mode === "accessExclusive" &&
          t.schema === l.schema &&
          t.name === l.name
      )
    )?.step ?? ""
  // Таблиця провайдера в попередженні — та, яку провайдер займає через
  // оператор самого кроку попередження; FK на таблицю провайдера — звичайний
  // замок кроку
  const byProvider = (l: TableLock, step: string): boolean => {
    const ofStep = statements.get(step) ?? []
    return providerLocks.some(
      (set) =>
        set.statements.some((s) => ofStep.includes(s)) &&
        set.tables.some((t) => t.schema === l.schema && t.name === l.name)
    )
  }
  const foreign = [...locks, ...implicitLocks]
    .filter(
      (l) => l.mode === "accessExclusive" && !scope.schemas.includes(l.schema)
    )
    .sort(
      (a, b) => byCodeUnit(a.schema, b.schema) || byCodeUnit(a.name, b.name)
    )
    .map((l) => ({ lock: l, step: exclusiveStep(l) }))
  const qualified = (l: TableLock) =>
    `${quoteIdent(l.schema)}.${quoteIdent(l.name)}`
  // Таблиці провайдера — одним попередженням на крок: їх займає один
  // оператор разом, і стоять тоді служби провайдера, а не окрема таблиця
  const byStep = new Map<string, string[]>()
  for (const { lock, step } of foreign)
    if (byProvider(lock, step))
      byStep.set(step, [...(byStep.get(step) ?? []), qualified(lock)])
  const lockWarnings = [
    ...foreign
      .filter(({ lock, step }) => !byProvider(lock, step))
      .map(({ lock, step }) =>
        applyDiagnostic("plan.foreign-exclusive-lock", "warning", {
          table: qualified(lock),
          step,
        })
      ),
    ...[...byStep].map(([step, tables]) =>
      applyDiagnostic("plan.foreign-exclusive-lock", "warning", {
        table: tables.join(", "),
        step,
        services: PROVIDER_LOCKS[scope.provider].services.join(", "),
      })
    ),
  ]
  return {
    locks,
    implicitLocks,
    providerLocks,
    foreignKeys,
    lockWarnings,
    revalidationSearchPath,
    blindFunctions,
    plpgsqlCheck: checks.mode,
    checkDiagnostics: checks.diagnostics,
  }
}

/** Відмови перепису власників: план і звірка (`diff`) — одна порада, різні коди. */
export type OwnerRefusalCode = "plan.owner-mismatch" | "engine.owner-not-member"

const ownersDiagnostic = (
  code: OwnerRefusalCode,
  objects: readonly string[]
): EngineDiagnostic =>
  applyDiagnostic(code, "error", {
    count: objects.length,
    objects: objects
      .slice(0, OWNER_LIMIT)
      .concat(objects.length > OWNER_LIMIT ? ["…"] : [])
      .join(", "),
  })

/**
 * Передперевірка власників межі на цілі — до будь-якого витягу. Двигун не
 * будує витягу цілі, де роль сесії не є членом ролі-власника об'єкта
 * (відмова «capability»), тож і план, і звірка (`diff`) питають це наперед і
 * відмовляють з порадою, а не падають. Межа — та, що читає двигун
 * (`readOwners`). `owners` — повний перепис цілі для подальшого порівняння.
 */
export async function checkOwnerMembership(
  reader: ApplyDatabase,
  target: DbConnection,
  scope: EngineScope,
  code: OwnerRefusalCode
): Promise<{
  owners: { session: string; owners: ObjectOwner[] }
  refusal?: EngineDiagnostic
}> {
  const owners = await reader.transaction(target, "rollback", (tx) =>
    readOwners(tx, scope)
  )
  const strangers = owners.owners
    .filter((owner) => !owner.member)
    .map(
      (owner) =>
        `${owner.object} (owner ${owner.owner}, not a role ${owners.session} is a member of)`
    )
  return strangers.length > 0
    ? { owners, refusal: ownersDiagnostic(code, strangers) }
    : { owners }
}

/**
 * Перепис власників об'єктів, що є і в цілі, і в тіні. Та сама проєкція, що
 * в двигуна: власник, рівний ролі сесії своєї бази, — типовий. Тож об'єкт
 * тіні, яким володіє її роль сесії, в цілі має належати ролі сесії цілі, і
 * різні ролі адміністрування тіні й застосування хибної відмови не дають.
 * Об'єкт пресету провайдера, яким у тіні володіє інша роль (`public` —
 * `pg_database_owner`), порівнюється за іменем ролі. Об'єкт лише цілі план
 * зніме чи змінить: йому досить, щоб роль сесії була членом ролі-власника,
 * а це перевірено ще до витягу (крок 2а). Залежні об'єкти (індекс, рядковий
 * тип, послідовність колонки) `readOwners` уже пропустив: їхній власник іде
 * за господарем.
 */
function ownerMismatches(
  target: { session: string; owners: readonly ObjectOwner[] },
  shadow: { session: string; owners: readonly ObjectOwner[] }
): string[] {
  const expected = new Map(
    shadow.owners.map((o) => [
      o.object,
      o.owner === shadow.session ? target.session : o.owner,
    ])
  )
  return target.owners.flatMap((o) => {
    const owner = expected.get(o.object)
    return owner === undefined || owner === o.owner
      ? []
      : [`${o.object} (owner ${o.owner}, expected ${owner})`]
  })
}

/**
 * SQL двигуна, якого не читає парсер, — дефект адаптера: `classifySteps` і
 * `lintSteps` кинули б на ньому виняток. Перевіряється наперед, щоб план
 * відмовив діагностикою з id кроку (`stepId` зі зсувом на кроки наміру, як
 * у `classifySteps`).
 */
function unparsableSteps(
  actions: readonly EngineAction[],
  parse: SqlParser,
  offset = 0
): EngineDiagnostic[] {
  return actions.flatMap((action, index) => {
    const result = parse(action.sql)
    return result.ok
      ? []
      : [
          applyDiagnostic("plan.unparsable-step", "error", {
            step: stepId(offset + index),
            message: result.message,
          }),
        ]
  })
}

/** Діагностика збою засіву копії: копія не відтворила середовища цілі. */
const environmentFailed = (reason?: string): EngineDiagnostic =>
  applyDiagnostic("engine.clone-failed", "error", {
    detail: `the copy could not reproduce the target's global default privileges${reason === undefined ? "" : `: ${reason}`}`,
  })

/**
 * Засів копії глобальними типовими привілеями ролі плану й звірка засіву
 * тим самим запитом, що читав ціль (рішення 5(б)). Порожній перелік теж
 * звіряється: копія без засіву не має мати чужих глобальних ADP. Сіяти тоді
 * нічого, тож звірка — транзакцією лише читання: писати в копію нічого. Збій
 * оператора (скажімо, роль сесії копії не член ролі плану) — так само
 * невідтворене середовище, а не стан цілі.
 *
 * Глобальний ADP діє лише на об'єкти, які створює його роль, а кроки на
 * копії створює роль сесії копії (`shadowBase` — інший сервер з іншою роллю
 * адміністрування). Тож за іншої ролі копії засів для ролі плану нічого б не
 * дав, і доказ тихо позеленів би; так само власні глобальні ADP ролі копії
 * дали б її об'єктам права, яких на цілі не буде (R7 плану П3-2b-0). Інша
 * роль з глобальними ADP хоч з одного боку — гучна відмова, а без них —
 * допустима, як і раніше. Засів «для ролі копії» з мапою одержувачів
 * відхилено: друга мапа ролей розійшлася б із семантикою тихо.
 */
async function seedEnvironment(
  dbs: PlanDatabases,
  clone: DbConnection,
  role: string,
  privileges: readonly GlobalDefaultPrivilege[]
): Promise<EngineDiagnostic[]> {
  const statements = renderGlobalDefaultPrivileges(role, privileges)
  try {
    const copy = await dbs.reader.transaction(clone, "rollback", async (tx) => {
      const [who] = await tx.query<{ role: string }>(
        "SELECT current_user AS role"
      )
      if (who === undefined) throw new Error("current_user returned no row")
      return {
        role: who.role,
        own:
          who.role === role
            ? []
            : await readGlobalDefaultPrivileges(tx, who.role),
      }
    })
    if (copy.role !== role && (privileges.length > 0 || copy.own.length > 0))
      return [
        environmentFailed(
          `the target's environment cannot be reproduced by another role: objects on the copy are created by ${quoteIdent(copy.role)}, on the target by ${quoteIdent(role)}, and global default privileges apply only to objects of their own role (${
            privileges.length > 0
              ? `the target has them for ${quoteIdent(role)}`
              : `the copy has them for ${quoteIdent(copy.role)}`
          })`
        ),
      ]
    const seeded = await (
      statements.length === 0 ? dbs.reader : dbs.scratch
    ).transaction(
      clone,
      statements.length === 0 ? "rollback" : "commit",
      async (tx) => {
        for (const statement of statements) await tx.query(statement)
        return readGlobalDefaultPrivileges(tx, role)
      }
    )
    return environmentMismatch(privileges, seeded) ? [environmentFailed()] : []
  } catch (error) {
    if (error instanceof ApplyDbError) return [environmentFailed(error.message)]
    if (error instanceof ApplyConnectionLost)
      return [
        environmentFailed(
          "the connection to the copy was lost; nothing was written to the database"
        ),
      ]
    throw error
  }
}

type EnvironmentResult =
  | {
      ok: true
      environment: { defaultPrivileges: GlobalDefaultPrivilege[] }
      /** Кроки `origin: "environment"` з id після кроків плану. */
      steps: PlanStep[]
      /** Попередження порту копії збору; план їх дедуплікує з рештою. */
      diagnostics: EngineDiagnostic[]
    }
  | { ok: false; diagnostics: EngineDiagnostic[] }

/**
 * Кроки середовища (рішення 5(а), (в) плану П3-2b-0). Глобальні типові
 * привілеї ролі плану читаються з цілі (READ ONLY); є вони — перша копія
 * засівається ними, проходить усі кроки плану сирою транзакцією з `COMMIT`
 * (раннер у режимі `proof` звірив би відбиток і відкотився б раніше, ніж
 * залишок можна обчислити), а план «копія → бажана тінь» стає кроками
 * середовища, якщо він — лише гранти на об'єктах, які створює сам план.
 * Семантику ADP дає сам Postgres, а не друга реалізація в T2; механізм
 * доводить прогін доказу. Без глобальних ADP копії немає.
 */
async function collectEnvironment(p: {
  engine: SchemaEngine
  dbs: PlanDatabases
  o: ShadowOptions
  scope: EngineScope
  witness: (db: DbConnection, scope: EngineScope) => Promise<Witness>
  live: Witness
  desired: Extracted["catalog"]
  role: string
  steps: readonly PlanStep[]
  parse: SqlParser
}): Promise<EnvironmentResult> {
  const { engine, dbs, scope, live, role, parse } = p
  const defaultPrivileges = await dbs.reader.transaction(
    p.o.target,
    "rollback",
    (tx) => readGlobalDefaultPrivileges(tx, role)
  )
  const environment = { defaultPrivileges }
  if (defaultPrivileges.length === 0)
    return { ok: true, environment, steps: [], diagnostics: [] }

  const outcome = await engine.withTargetClone(
    p.o,
    live.extracted,
    scope,
    async (clone): Promise<EnvironmentResult> => {
      const seeded = await seedEnvironment(dbs, clone, role, defaultPrivileges)
      if (seeded.length > 0) return { ok: false, diagnostics: seeded }
      // Неточна копія дала б залишок, не пов'язаний із середовищем: її
      // називає своя відмова, а не «доказ не порожній»
      const mismatch = cloneMismatch(
        engine,
        scope,
        live,
        await p.witness(clone, scope)
      )
      if (mismatch.length > 0) return { ok: false, diagnostics: mismatch }
      try {
        await runOnClone(dbs.scratch, clone, p.steps)
      } catch (error) {
        if (error instanceof IntentStepFailed)
          return { ok: false, diagnostics: [error.diagnostic] }
        if (error instanceof ApplyConnectionLost)
          return {
            ok: false,
            diagnostics: [
              applyDiagnostic("engine.clone-failed", "error", {
                detail:
                  "the connection to the copy was lost while collecting the environment steps, so the plan could not be built; nothing was written to the database",
              }),
            ],
          }
        throw error
      }
      const after = await engine.extract(clone, scope)
      // Опції — від живої цілі: кроки середовища застосовують до неї
      const residual = engine.plan(after.catalog, p.desired, scope, {
        optionsFrom: live.extracted.catalog,
      })
      const planErrors = errorsOf(residual)
      if (planErrors.length > 0) return { ok: false, diagnostics: planErrors }
      const offset = p.steps.length
      const unparsable = unparsableSteps(residual.actions, parse, offset)
      if (unparsable.length > 0) return { ok: false, diagnostics: unparsable }
      const admitted = environmentSteps(
        residual.actions,
        p.steps.flatMap((s) => s.produced),
        parse
      )
      if ("refusal" in admitted)
        return { ok: false, diagnostics: [admitted.refusal] }
      // Клас — від моделі копії після кроків: це вихідний стан кроків
      // середовища; гранти завжди `catalogOnly`
      const steps = classifySteps(
        admitted.steps,
        after.model,
        parse,
        offset
      ).map((s): PlanStep => ({ ...s, origin: "environment" }))
      return { ok: true, environment, steps, diagnostics: [] }
    }
  )
  if (outcome.status === "shadow-failed")
    return { ok: false, diagnostics: outcome.diagnostics }
  return outcome.value.ok && !hasError(outcome.diagnostics)
    ? { ...outcome.value, diagnostics: outcome.diagnostics }
    : {
        ok: false,
        diagnostics: [
          ...outcome.diagnostics,
          ...(outcome.value.ok ? [] : outcome.value.diagnostics),
        ],
      }
}

type ProofResult =
  | { ok: true; resultCatalog: CatalogModel; diagnostics: EngineDiagnostic[] }
  | { ok: false; diagnostics: EngineDiagnostic[] }

/**
 * Доказ (рішення 4 плану П3-1). Копія поточного стану цілі, перевірена трьома
 * незалежними способами; той самий раннер у режимі `proof`; далі план
 * «копія → бажана тінь» порожній і відбиток копії = бажаний без `owner`.
 * Копія без даних доводить збіжність схеми, а не сумісність із даними.
 */
async function prove(
  engine: SchemaEngine,
  dbs: PlanDatabases,
  o: ShadowOptions,
  witness: (db: DbConnection, scope: EngineScope) => Promise<Witness>,
  p: {
    scope: EngineScope
    live: Witness
    desired: Witness
    model: CompiledModel
    /** Зміни типу колонок плану: їхні відмови видно лише на базі. */
    typeChanges: readonly TypeChange[]
    plan: ExecutablePlan
  }
): Promise<ProofResult> {
  const outcome = await engine.withTargetClone(
    o,
    p.live.extracted,
    p.scope,
    async (clone): Promise<ProofResult> => {
      // Глобальні типові привілеї ролі — до прогону: Postgres застосує їх до
      // кожного об'єкта кроків так само, як на цілі (рішення 5(г))
      const seeded = await seedEnvironment(
        dbs,
        clone,
        p.plan.role,
        p.plan.environment.defaultPrivileges
      )
      if (seeded.length > 0) return { ok: false, diagnostics: seeded }
      const copy = await witness(clone, p.scope)
      const mismatch = cloneMismatch(engine, p.scope, p.live, copy)
      if (mismatch.length > 0) return { ok: false, diagnostics: mismatch }

      // Залежні від колонок зі зміною типу й приведення сторожів — на копії
      // до прогону: прогін упав би на першому сирим збоєм кроку. Плану без
      // зміни типу зайва транзакція на копії ні до чого
      const blocked =
        p.typeChanges.length === 0
          ? []
          : await typeChangeProof(dbs.scratch, clone, p.typeChanges, p.plan)
      if (blocked.length > 0) return { ok: false, diagnostics: blocked }

      const run = await executePlan(dbs.scratch, clone, p.plan, {
        mode: "proof",
        planHash: PROOF_PLAN_HASH,
        allow: p.plan.requiredPermissions,
        snapshot: canonicalSnapshot(p.model),
      })
      if (run.status !== "committed")
        return { ok: false, diagnostics: run.diagnostics.map(asProofRefusal) }

      const after = await witness(clone, p.scope)
      const afterPlan = engine.plan(
        after.extracted.catalog,
        p.desired.extracted.catalog,
        p.scope
      )
      const remaining = afterPlan.actions
      // Помилка плану двигуна (зокрема невідома преамбула) означає, що порожній
      // чи ні план не можна вважати доказом
      const planErrors = errorsOf(afterPlan)
      if (planErrors.length > 0) return { ok: false, diagnostics: planErrors }
      if (remaining.length > 0)
        return {
          ok: false,
          diagnostics: [
            applyDiagnostic("plan.proof-not-empty", "error", {
              count: remaining.length,
              first: remaining[0]!.sql,
            }),
          ],
        }
      const sections = differingAcross(p.desired.fingerprint, after.fingerprint)
      if (sections.length > 0)
        return {
          ok: false,
          diagnostics: [
            applyDiagnostic("plan.fingerprint-disagrees", "error", {
              sections: sections.join(", "),
            }),
          ],
        }
      // Модель копії після прогону, а не бажаної тіні: порядок колонок цілі
      // інший, а marker має описувати саме ціль після застосування
      // Попередження прогону — звірка сліду замків — ідуть у діагностику плану
      return {
        ok: true,
        resultCatalog: after.extracted.model,
        diagnostics: run.diagnostics,
      }
    }
  )
  if (outcome.status === "shadow-failed")
    return { ok: false, diagnostics: outcome.diagnostics }
  const diagnostics = [...outcome.diagnostics, ...outcome.value.diagnostics]
  return outcome.value.ok && !hasError(diagnostics)
    ? { ...outcome.value, diagnostics }
    : { ok: false, diagnostics }
}

/**
 * Відмови змін типу на копії. Обрив з'єднання тут — така сама недоведеність,
 * як обрив прогону-доказу (див. `asProofRefusal`): копія жертовна, ціль ніхто
 * не чіпав.
 */
async function typeChangeProof(
  scratch: ApplyDatabase,
  clone: DbConnection,
  changes: readonly TypeChange[],
  plan: ExecutablePlan
): Promise<EngineDiagnostic[]> {
  try {
    return await scratch.transaction(clone, "rollback", (tx) =>
      typeChangeRefusals(tx, changes, plan.steps)
    )
  } catch (error) {
    if (!(error instanceof ApplyConnectionLost)) throw error
    return [
      applyDiagnostic("engine.clone-failed", "error", {
        detail:
          "the connection to the copy was lost while checking the column type changes, so the plan could not be proved; nothing was written to the database",
      }),
    ]
  }
}

/** Помилки самого плану двигуна: попередження вже звучать у результаті порту. */
function errorsOf(plan: EnginePlan): EngineDiagnostic[] {
  return plan.diagnostics.filter((d) => d.severity === "error")
}

/**
 * Перевірка раннера перед `COMMIT` у режимі `proof` — це і є крок 10
 * доказу: відбиток копії після кроків проти бажаного без `owner`. Відмова
 * доказу називається кодом доказу, а не кодом застосування: на цілі ще
 * нічого не застосовувалось.
 *
 * Обрив з'єднання з копією так само не стосується цілі: текст раннера («під
 * час застосування», «шукайте в ledger») послав би того, хто планує,
 * перевіряти базу, якої ніхто не чіпав. Копія жертовна, тож її результат
 * не цікавий — план просто не доведено. `engine.clone-failed` — про копію,
 * і його підказка вже називає режим з'єднання тіні як можливу причину.
 */
function asProofRefusal(d: EngineDiagnostic): EngineDiagnostic {
  switch (d.code) {
    case "apply.verify-failed":
      return applyDiagnostic("plan.fingerprint-disagrees", "error", {
        sections: d.params.sections ?? "",
      })
    case "apply.connection-lost":
      return applyDiagnostic("engine.clone-failed", "error", {
        detail:
          "the connection to the copy was lost during the proof run, so the plan could not be proved; nothing was written to the database",
      })
    default:
      return d
  }
}

/**
 * Точність копії трьома незалежними способами (рішення 4): план двигуна
 * «копія → ціль» порожній, моделі каталогу рівні, відбиток копії = відбиток
 * цілі без `owner`. Кожен спосіб сліпий до свого: двигун — до того, чого не
 * планує, модель — до того, чого не несе, відбиток — до того, що поза межею.
 */
function cloneMismatch(
  engine: SchemaEngine,
  scope: EngineScope,
  live: Witness,
  copy: Witness
): EngineDiagnostic[] {
  const mismatch = (how: string, detail: string) =>
    applyDiagnostic("plan.clone-mismatch", "error", { how, detail })
  const out: EngineDiagnostic[] = []
  const copyToLive = engine.plan(
    copy.extracted.catalog,
    live.extracted.catalog,
    scope
  )
  const actions = copyToLive.actions
  // Плану з помилкою довіряти не можна: порожні дії тоді нічого не доводять
  out.push(...errorsOf(copyToLive))
  if (actions.length > 0)
    out.push(
      mismatch(
        "plan",
        `${actions.length} engine action(s), the first is \`${actions[0]!.sql}\``
      )
    )
  // Порядок колонок — точно: копія мусить відтворювати ціль, і marker бере
  // модель саме з копії
  const differences = diffCatalogModels(
    live.extracted.model,
    copy.extracted.model,
    { columnOrder: true }
  )
  if (differences.length > 0)
    out.push(
      mismatch(
        "model",
        differences
          .slice(0, MISMATCH_PATH_LIMIT)
          .map((d) => d.path)
          .concat(differences.length > MISMATCH_PATH_LIMIT ? ["…"] : [])
          .join(", ")
      )
    )
  const sections = differingAcross(live.fingerprint, copy.fingerprint)
  if (sections.length > 0)
    out.push(mismatch("fingerprint", sections.join(", ")))
  return out
}
