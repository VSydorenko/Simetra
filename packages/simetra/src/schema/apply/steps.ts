import {
  localize,
  type Node,
  type RuleCode,
  type SqlParser,
} from "simetra/compiler"
import type { CatalogModel } from "simetra/model"
import type { EngineAction, EngineDiagnostic, LockedTable } from "../engine"

/**
 * Класи кроків плану (платформна спека §6.6, рішення 10 плану П3-1).
 * `dataStep` є в типі заради патчів даних; П3-1 його не породжує.
 */
export const STEP_CLASSES = [
  "catalogOnly",
  "tableRewrite",
  "validationScan",
  "dataStep",
  "relaxation",
  "destructive",
] as const
export type StepClass = (typeof STEP_CLASSES)[number]

/** Крок плану: дія двигуна з id, за яким дають дозвіл, і класом. */
export interface PlanStep {
  /** `s1`, `s2`, … у порядку двигуна. */
  id: string
  sql: string
  verb: EngineAction["verb"]
  class: StepClass
  lockClass: string
  transactionality: EngineAction["transactionality"]
  newSegmentBefore: boolean
  lockedTables: LockedTable[]
  produces: string[]
  consumes: string[]
  destroys: string[]
  dataLoss: boolean
  rewriteRisk: boolean
}

/**
 * Види, чиє знищення — втрата даних навіть тоді, коли пізніший крок
 * відтворює об'єкт: відтворена таблиця порожня, а послідовність починає
 * лічильник наново.
 */
const DATA_KINDS: ReadonlySet<string> = new Set([
  "table",
  "column",
  "sequence",
  "materializedView",
])

/** Об'єкти без даних: зняти й створити знову в тому самому плані — заміна. */
const REPLACEABLE_KINDS: ReadonlySet<string> = new Set([
  "constraint",
  "index",
  "policy",
  "trigger",
  "function",
  "procedure",
  "view",
])

/** Вид ідентичності — префікс рядка StableId до першої `:`. */
const kindOf = (id: string): string => id.split(":", 1)[0]!

/** Підкоманди `ALTER TABLE`, що знімають гарантію. */
const RELAXING_ALTERS: ReadonlySet<string> = new Set([
  "AT_DropNotNull",
  "AT_DropConstraint",
  "AT_DisableRowSecurity",
  "AT_NoForceRowSecurity",
  "AT_DisableTrig",
  "AT_DisableTrigAll",
  "AT_DisableTrigUser",
])

/** Підкоманди `ALTER TABLE`, що перевіряють наявні рядки. */
const SCANNING_ALTERS: ReadonlySet<string> = new Set([
  "AT_SetNotNull",
  "AT_ValidateConstraint",
])

/**
 * `ALTER DOMAIN` має ті самі зміни гарантій, що й таблиця, — на всіх
 * колонках домену одразу. Підтип — літера з `gram.y`: `N` DROP NOT NULL,
 * `X` DROP CONSTRAINT, `O` SET NOT NULL, `C` ADD CONSTRAINT, `V` VALIDATE.
 */
const RELAXING_DOMAIN_ALTERS: ReadonlySet<string> = new Set(["N", "X"])
const SCANNING_DOMAIN_ALTERS: ReadonlySet<string> = new Set(["O", "V"])

type Effect = "relaxation" | "validationScan" | undefined

interface Named {
  schema: string
  name: string
}

/** Що про вихідний стан знає модель цілі, а оператор — ні. */
interface Facts {
  uniqueIndexes: readonly Named[]
  tables: readonly Named[]
}

/**
 * Ім'я з дерева, кваліфіковане чи ні. Двигун кваліфікує все, тож
 * некваліфіковане ім'я шукається в усіх схемах цілі: краще суворіший клас,
 * ніж пропущене послаблення чи сканування.
 */
const has = (
  list: readonly Named[],
  schema: string | undefined,
  name: string
): boolean =>
  list.some(
    (n) => n.name === name && (schema === undefined || n.schema === schema)
  )

/** `NOT VALID` — обмеження без сканування наявних рядків. */
function scansOnAdd(def: Node | undefined): boolean {
  return !(
    def !== undefined &&
    "Constraint" in def &&
    def.Constraint.skip_validation === true
  )
}

function statementEffect(stmt: Node, facts: Facts): Effect {
  if ("AlterTableStmt" in stmt) {
    let effect: Effect
    for (const node of stmt.AlterTableStmt.cmds ?? []) {
      if (!("AlterTableCmd" in node)) continue
      const { subtype, def } = node.AlterTableCmd
      if (subtype === undefined) continue
      if (RELAXING_ALTERS.has(subtype)) return "relaxation"
      if (
        SCANNING_ALTERS.has(subtype) ||
        (subtype === "AT_AddConstraint" && scansOnAdd(def))
      )
        effect = "validationScan"
    }
    return effect
  }
  if ("AlterDomainStmt" in stmt) {
    const { subtype, def } = stmt.AlterDomainStmt
    if (subtype === undefined) return undefined
    if (RELAXING_DOMAIN_ALTERS.has(subtype)) return "relaxation"
    if (
      SCANNING_DOMAIN_ALTERS.has(subtype) ||
      (subtype === "C" && scansOnAdd(def))
    )
      return "validationScan"
    return undefined
  }
  if ("DropStmt" in stmt) {
    const { removeType, objects } = stmt.DropStmt
    if (removeType === "OBJECT_POLICY" || removeType === "OBJECT_TRIGGER")
      return "relaxation"
    if (removeType !== "OBJECT_INDEX") return undefined
    // Унікальність знятого індексу знає лише модель цілі: в операторі її немає
    const unique = (objects ?? []).some((object) => {
      const names = "List" in object ? stringsOf(object.List.items) : []
      const name = names.at(-1)
      return name !== undefined && has(facts.uniqueIndexes, names.at(-2), name)
    })
    return unique ? "relaxation" : undefined
  }
  if ("IndexStmt" in stmt) {
    const { unique, relation } = stmt.IndexStmt
    // Унікальний індекс на таблиці, яку створює сам план, нічого не сканує
    return unique === true &&
      relation?.relname !== undefined &&
      has(facts.tables, relation.schemaname, relation.relname)
      ? "validationScan"
      : undefined
  }
  return undefined
}

function stringsOf(items: readonly Node[] | undefined): string[] {
  return (items ?? []).flatMap((item) =>
    "String" in item && item.String.sval !== undefined ? [item.String.sval] : []
  )
}

function parsed(step: string, sql: string, parse: SqlParser): Node[] {
  const result = parse(sql)
  // SQL двигуна, якого не розбирає парсер тієї самої мажорної версії, — дефект
  // адаптера: без дерева ні клас, ні CASCADE не визначити
  if (!result.ok)
    throw new Error(`plan step ${step} does not parse: ${result.message}`)
  return result.statements.map((s) => s.stmt)
}

/**
 * Базовий клас без винятку «заміна»: перший збіг зверху за таблицею
 * рішення 10.
 */
function baseClass(
  action: EngineAction,
  stmts: readonly Node[],
  facts: Facts
): StepClass {
  if (
    action.dataLoss ||
    action.destroys.some((id) => DATA_KINDS.has(kindOf(id)))
  )
    return "destructive"
  if (action.rewriteRisk) return "tableRewrite"
  const effects = stmts.map((stmt) => statementEffect(stmt, facts))
  if (effects.includes("relaxation")) return "relaxation"
  if (effects.includes("validationScan")) return "validationScan"
  return "catalogOnly"
}

/**
 * Заміна: крок знімає лише об'єкти без даних, і кожен знову створює пізніший
 * крок. Порожній `destroys` (DROP NOT NULL, DISABLE TRIGGER) заміною не є:
 * відтворювати нічого, гарантія просто знята.
 */
function isReplacement(
  action: EngineAction,
  later: readonly EngineAction[]
): boolean {
  if (action.destroys.length === 0) return false
  const produced = new Set(later.flatMap((a) => a.produces))
  return action.destroys.every(
    (id) => REPLACEABLE_KINDS.has(kindOf(id)) && produced.has(id)
  )
}

/**
 * Класи кроків із прапорів двигуна й дерева розбору. `target` — модель
 * каталогу цілі, тобто вихідного стану плану: лише вона знає, чи знятий
 * індекс унікальний і чи таблиця вже існує.
 */
export function classifySteps(
  actions: readonly EngineAction[],
  target: CatalogModel,
  parse: SqlParser
): PlanStep[] {
  const facts: Facts = {
    uniqueIndexes: target.tables.flatMap((t) =>
      t.indexes
        .filter((i) => i.unique)
        .map((i) => ({ schema: t.schema, name: i.name }))
    ),
    tables: target.tables,
  }
  return actions.map((action, index) => {
    const id = `s${index + 1}`
    const base = baseClass(action, parsed(id, action.sql, parse), facts)
    // Виняток не перекриває втрату даних: `destructive` сюди не доходить
    const cls =
      base === "relaxation" && isReplacement(action, actions.slice(index + 1))
        ? "catalogOnly"
        : base
    return {
      id,
      sql: action.sql,
      verb: action.verb,
      class: cls,
      lockClass: action.lockClass,
      transactionality: action.transactionality,
      newSegmentBefore: action.newSegmentBefore,
      lockedTables: action.lockedTables,
      produces: action.produces,
      consumes: action.consumes,
      destroys: action.destroys,
      dataLoss: action.dataLoss,
      rewriteRisk: action.rewriteRisk,
    }
  })
}

function applyError(
  code: RuleCode,
  params: Record<string, string | number>
): EngineDiagnostic {
  return {
    code,
    severity: "error",
    message: localize({ code, params }, "en").message,
    params,
  }
}

/**
 * `CASCADE` будь-де в дереві: у `DROP`, у підкоманді `ALTER TABLE … DROP`, у
 * `TRUNCATE`. Літерал `'CASCADE'` лежить у `sval`, а не в `behavior`.
 */
function hasCascade(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(hasCascade)
  if (typeof node !== "object" || node === null) return false
  return Object.entries(node).some(([field, value]) =>
    field === "behavior" ? value === "DROP_CASCADE" : hasCascade(value)
  )
}

/**
 * Відмови, які не знімає жоден дозвіл: `CASCADE` знищив би залежні об'єкти,
 * яких план не називає, а нетранзакційний крок і крок після межі коміту не
 * вміщаються в одну транзакцію раннера (рішення 5). `commitBoundaryAfter` без
 * споживача лишається в транзакції: на PG17 `ADD VALUE` у ній дозволено.
 */
export function lintSteps(
  steps: readonly PlanStep[],
  parse: SqlParser
): EngineDiagnostic[] {
  return steps.flatMap((step) => [
    ...(parsed(step.id, step.sql, parse).some(hasCascade)
      ? [applyError("apply.cascade", { step: step.id })]
      : []),
    ...(step.transactionality === "nonTransactional"
      ? [applyError("apply.non-transactional", { step: step.id })]
      : []),
    ...(step.newSegmentBefore
      ? [applyError("apply.commit-boundary", { step: step.id })]
      : []),
  ])
}

const NEEDS_PERMISSION: ReadonlySet<StepClass> = new Set<StepClass>([
  "destructive",
  "relaxation",
])

/** Id кроків, яким потрібен явний дозвіл, у порядку плану. */
export function requiredPermissions(steps: readonly PlanStep[]): string[] {
  return steps.filter((s) => NEEDS_PERMISSION.has(s.class)).map((s) => s.id)
}

/**
 * Дозволи `allow` проти плану. Зайвий id — теж відмова: дозвіл на крок,
 * якого немає чи який дозволу не потребує, означає, що автор дозволяв інший
 * план.
 */
export function checkPermissions(
  steps: readonly PlanStep[],
  allow: readonly string[]
): EngineDiagnostic[] {
  const required = requiredPermissions(steps)
  const allowed = new Set(allow)
  const missing = required.filter((id) => !allowed.has(id))
  const unknown = [...allowed].filter((id) => !required.includes(id))
  return [
    ...(missing.length > 0
      ? [applyError("apply.permission-required", { steps: missing.join(", ") })]
      : []),
    ...(unknown.length > 0
      ? [applyError("apply.permission-unknown", { steps: unknown.join(", ") })]
      : []),
  ]
}
