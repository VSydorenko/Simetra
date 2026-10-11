import {
  canonicalSnapshot,
  loadSqlParser,
  type CompiledModel,
  type RuleCode,
  type SqlParser,
} from "simetra/compiler"
import { diffCatalogModels, type CatalogModel } from "simetra/model"
import type {
  DbConnection,
  EngineAction,
  EngineDiagnostic,
  EngineScope,
  Extracted,
  SchemaEngine,
  ShadowOptions,
} from "../engine"
import { dedupe } from "../engine/desired"
import { PLAN_FORMAT, stampPlan, type PlanArtifact } from "./artifact"
import { desiredForApply } from "./desired"
import { applyDiagnostic } from "./diagnostic"
import { driftGate } from "./drift"
import { executePlan, type ExecutablePlan } from "./execute"
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
import type { ApplyDatabase } from "./port"
import { readApplyState } from "./state"
import { classifySteps, lintSteps, requiredPermissions, stepId } from "./steps"
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
 * Конвеєр плану (платформна спека §6.2 п.2–4, §6.6; задача 9 плану П3-1):
 * стан застосування, гейт дрейфу, план від живої цілі до бажаного стану,
 * класи, лінт і дозволи, доказ на жертовній копії тим самим раннером і
 * детермінований артефакт. Дрейф планування не зупиняє: він іде в артефакт
 * пунктом дозволу (рішення 16). Ціль і тіні лише читаються (`reader`), пише
 * тільки прогін-доказ у копію (`scratch`).
 */
export async function buildPlan(
  engine: SchemaEngine,
  dbs: PlanDatabases,
  model: CompiledModel,
  o: ShadowOptions
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

  // 4–5. План «ціль → бажана тінь» і модель та відбиток тіні під межею плану.
  // Тінь живе лише в колбеку, тож усе з неї знімається тут
  const shadow = await engine.withDesiredShadow(
    o,
    desired.sql,
    scope,
    async (db, enginePlan) => ({
      enginePlan,
      owners: await dbs.reader.transaction(db, "rollback", (tx) =>
        readOwners(tx, scope)
      ),
      ...(await witness(db, scope)),
    })
  )
  if (shadow.status === "shadow-failed")
    return refused(
      dedupe([
        ...verdict.diagnostics,
        ...desired.diagnostics,
        ...shadow.diagnostics,
      ])
    )
  const target = shadow.value
  const diagnostics = dedupe([
    ...verdict.diagnostics,
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
  const mismatched = ownerMismatches(
    await dbs.reader.transaction(o.target, "rollback", (tx) =>
      readOwners(tx, scope)
    ),
    target.owners
  )
  if (mismatched.length > 0)
    return refused([
      ...diagnostics,
      applyDiagnostic("plan.owner-mismatch", "error", {
        count: mismatched.length,
        objects: mismatched
          .slice(0, OWNER_LIMIT)
          .concat(mismatched.length > OWNER_LIMIT ? ["…"] : [])
          .join(", "),
      }),
    ])
  const { actions } = target.enginePlan

  // 6. Нічого застосовувати лише тоді, коли немає ні кроків, ні нового
  // знімка, ні дрейфу. Дрейф без кроків (власник) — план із нулем кроків:
  // інакше дрейф не було б як прийняти, і кожен наступний план бачив би його
  if (actions.length === 0 && fromHash === model.hash && drift === null)
    return { status: "unchanged", diagnostics }

  // 7. Класи — від моделі вихідного стану плану, тобто живої цілі: з
  // порожньою моделлю кожна зміна типу стала б `destructive`
  const parse = await loadSqlParser()
  const unparsable = unparsableSteps(actions, parse)
  if (unparsable.length > 0) return refused([...diagnostics, ...unparsable])
  const steps = classifySteps(actions, live.extracted.model, parse)
  const lint = lintSteps(steps, parse)
  if (lint.length > 0) return refused([...diagnostics, ...lint])
  const permissions = requiredPermissions({ steps, drift })

  // 8–10. Доказ на копії. План доказу несе той самий дрейф, тож дозволи
  // `requiredPermissions` йому відповідають
  const proof = await prove(engine, dbs, o, witness, {
    scope,
    live,
    desired: target,
    model,
    plan: {
      fromHash,
      toHash: model.hash,
      scope,
      engine: engine.identity,
      steps,
      requiredPermissions: permissions,
      drift,
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
    resultCatalog: proof.resultCatalog,
  })
  return {
    status: "planned",
    artifact,
    diagnostics: dedupe([
      ...diagnostics,
      ...proof.diagnostics,
      applyDiagnostic("plan.schema-only-proof", "warning"),
    ]),
  }
}

/**
 * Перепис власників об'єктів, що є і в цілі, і в тіні. Та сама проєкція, що
 * в двигуна: власник, рівний ролі сесії своєї бази, — типовий. Тож об'єкт
 * тіні, яким володіє її роль сесії, в цілі має належати ролі сесії цілі, і
 * різні ролі адміністрування тіні й застосування хибної відмови не дають.
 * Об'єкт пресету провайдера, яким у тіні володіє інша роль (`public` —
 * `pg_database_owner`), порівнюється за іменем ролі.
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
 * відмовив діагностикою з id кроку (`stepId`, як у `classifySteps`).
 */
function unparsableSteps(
  actions: readonly EngineAction[],
  parse: SqlParser
): EngineDiagnostic[] {
  return actions.flatMap((action, index) => {
    const result = parse(action.sql)
    return result.ok
      ? []
      : [
          applyDiagnostic("plan.unparsable-step", "error", {
            step: stepId(index),
            message: result.message,
          }),
        ]
  })
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
    plan: ExecutablePlan
  }
): Promise<ProofResult> {
  const outcome = await engine.withTargetClone(
    o,
    p.live.extracted,
    p.scope,
    async (clone): Promise<ProofResult> => {
      const copy = await witness(clone, p.scope)
      const mismatch = cloneMismatch(engine, p.scope, p.live, copy)
      if (mismatch.length > 0) return { ok: false, diagnostics: mismatch }

      const run = await executePlan(dbs.scratch, clone, p.plan, {
        mode: "proof",
        planHash: PROOF_PLAN_HASH,
        allow: p.plan.requiredPermissions,
        snapshot: canonicalSnapshot(p.model),
      })
      if (run.status !== "committed")
        return { ok: false, diagnostics: run.diagnostics.map(asProofRefusal) }

      const after = await witness(clone, p.scope)
      const remaining = engine.plan(
        after.extracted.catalog,
        p.desired.extracted.catalog,
        p.scope
      ).actions
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
      return { ok: true, resultCatalog: after.extracted.model, diagnostics: [] }
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
 * Перевірка раннера перед `COMMIT` у режимі `proof` — це і є крок 10
 * доказу: відбиток копії після кроків проти бажаного без `owner`. Відмова
 * доказу називається кодом доказу, а не кодом застосування: на цілі ще
 * нічого не застосовувалось.
 */
function asProofRefusal(d: EngineDiagnostic): EngineDiagnostic {
  return d.code === "apply.verify-failed"
    ? applyDiagnostic("plan.fingerprint-disagrees", "error", {
        sections: d.params.sections ?? "",
      })
    : d
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
  const actions = engine.plan(
    copy.extracted.catalog,
    live.extracted.catalog,
    scope
  ).actions
  if (actions.length > 0)
    out.push(
      mismatch(
        "plan",
        `${actions.length} engine action(s), the first is \`${actions[0]!.sql}\``
      )
    )
  const differences = diffCatalogModels(
    live.extracted.model,
    copy.extracted.model
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
