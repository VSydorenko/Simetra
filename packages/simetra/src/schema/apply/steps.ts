import type { AlterTableCmd, Node } from "libpg-query"
import type { SqlParser } from "simetra/compiler"
import type { CatalogModel, CatalogTable } from "simetra/model"
import type {
  EngineAction,
  EngineDiagnostic,
  EngineObjectRef,
  LockedTable,
} from "../engine"
import { applyDiagnostic } from "./diagnostic"
import type { DriftReport } from "./drift"
import {
  isLossless,
  parseType,
  stringsOf,
  typeGuards,
  typeOf,
  type ColumnType,
} from "./type-guard"

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

/**
 * Крок плану: дія двигуна чи крок наміру платформи з id, за яким дають
 * дозвіл, і класом.
 */
export interface PlanStep {
  /** `s1`, `s2`, … наскрізно: спершу кроки наміру, далі кроки двигуна. */
  id: string
  /**
   * Звідки крок: намір платформи (перейменування промоції, рішення 2 плану
   * П3-2a) виконується до diff двигуна, тож двигун своїх перейменувань не
   * вгадує.
   */
  origin: "intent" | "engine"
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
  /** Структурна форма `produces` від адаптера; у кроку наміру порожня. */
  produced: EngineObjectRef[]
  /** Структурна форма `destroys` від адаптера; у кроку наміру порожня. */
  destroyed: EngineObjectRef[]
  /** Структурна форма `consumes` від адаптера; у кроку наміру порожня. */
  consumed: EngineObjectRef[]
  dataLoss: boolean
  rewriteRisk: boolean
  /** SQL сторожів кроку; раннер виконує їх перед кроком. */
  guards: string[]
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
  "rule",
  "function",
  "procedure",
  "view",
])

/** Вид ідентичності — префікс рядка StableId до першої `:`. */
const kindOf = (id: string): string => id.split(":", 1)[0]!

/**
 * Підкоманди `ALTER TABLE`, що знімають гарантію. Режим `REPLICA` вимикає
 * тригер чи правило для звичайних сесій (вони спрацьовують лише за
 * `session_replication_role = replica`) — те саме, що `DISABLE`. `ENABLE` і
 * `ENABLE ALWAYS` гарантію лише повертають чи посилюють.
 */
const RELAXING_ALTERS: ReadonlySet<string> = new Set([
  "AT_DropNotNull",
  "AT_DropConstraint",
  "AT_DisableRowSecurity",
  "AT_NoForceRowSecurity",
  "AT_DisableTrig",
  "AT_DisableTrigAll",
  "AT_DisableTrigUser",
  "AT_EnableReplicaTrig",
  "AT_DisableRule",
  "AT_EnableReplicaRule",
])

/** Видалення об'єктів, що тримають інваріанти, а не дані. */
const RELAXING_DROPS: ReadonlySet<string> = new Set([
  "OBJECT_POLICY",
  "OBJECT_TRIGGER",
  "OBJECT_RULE",
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

/** Що оператор робить із даними й гарантіями, від найсильнішого. */
type Effect = "destructive" | "relaxation" | "validationScan"

interface Named {
  schema: string
  name: string
}

/** Що про вихідний стан знає модель цілі, а оператор — ні. */
interface Facts {
  /** Індекси, які модель цілі знає, з їхньою унікальністю. */
  indexes: readonly (Named & { unique: boolean })[]
  tables: readonly CatalogTable[]
  /** Ідентичності `table:<схема>.<ім'я>`, які створює сам план. */
  createdTables: ReadonlySet<string>
  /** Тип колонки вихідного стану; `undefined` — колонки не видно або тип не розібрано. */
  columnType(table: CatalogTable, column: string): ColumnType | undefined
}

/**
 * Ім'я з дерева, кваліфіковане чи ні. Двигун кваліфікує все, тож
 * некваліфіковане ім'я шукається в усіх схемах цілі: краще суворіший клас,
 * ніж пропущене послаблення чи сканування.
 */
const find = <T extends Named>(
  list: readonly T[],
  schema: string | undefined,
  name: string
): T | undefined =>
  list.find(
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

const sameType = (a: ColumnType, b: ColumnType): boolean =>
  a.name === b.name &&
  a.mods.length === b.mods.length &&
  a.mods.every((m, i) => m === b.mods[i])

/**
 * `USING` без втрат — лише відсутній або `<та сама колонка>::<новий тип>`:
 * будь-який інший вираз може змінити значення.
 */
function isPlainUsing(
  using: Node | undefined,
  column: string,
  to: ColumnType
): boolean {
  if (using === undefined) return true
  if (!("TypeCast" in using)) return false
  const { arg, typeName } = using.TypeCast
  if (arg === undefined || !("ColumnRef" in arg)) return false
  const fields = arg.ColumnRef.fields ?? []
  const cast = typeOf(typeName)
  return (
    fields.length === 1 &&
    stringsOf(fields)[0] === column &&
    cast !== undefined &&
    sameType(cast, to)
  )
}

/**
 * Зміна типу колонки втрачає дані, якщо перехід не з переліку без втрат.
 * Старий тип — з моделі вихідного стану: колонки там не видно (атрибут
 * типізованої таблиці в `ALTER TYPE … ALTER ATTRIBUTE`, стороння таблиця),
 * тож доказу збереження немає — `destructive`.
 */
function changesTypeLossily(
  table: CatalogTable | undefined,
  cmd: AlterTableCmd,
  facts: Facts
): boolean {
  const column = cmd.name
  const def =
    cmd.def !== undefined && "ColumnDef" in cmd.def
      ? cmd.def.ColumnDef
      : undefined
  const from =
    table === undefined || column === undefined
      ? undefined
      : facts.columnType(table, column)
  const to = typeOf(def?.typeName)
  return (
    from === undefined ||
    to === undefined ||
    column === undefined ||
    !isLossless(from, to) ||
    !isPlainUsing(def?.raw_default, column, to)
  )
}

function statementEffects(stmt: Node, facts: Facts): Effect[] {
  if ("AlterTableStmt" in stmt) {
    const { relation, cmds } = stmt.AlterTableStmt
    const table =
      relation?.relname === undefined
        ? undefined
        : find(facts.tables, relation.schemaname, relation.relname)
    return (cmds ?? []).flatMap((node): Effect[] => {
      if (!("AlterTableCmd" in node)) return []
      const cmd = node.AlterTableCmd
      const { subtype, def } = cmd
      if (subtype === undefined) return []
      // І `ALTER TABLE … ALTER TYPE`, і `ALTER TYPE … ALTER ATTRIBUTE … TYPE`
      if (subtype === "AT_AlterColumnType")
        return changesTypeLossily(table, cmd, facts) ? ["destructive"] : []
      if (RELAXING_ALTERS.has(subtype)) return ["relaxation"]
      if (
        SCANNING_ALTERS.has(subtype) ||
        (subtype === "AT_AddConstraint" && scansOnAdd(def))
      )
        return ["validationScan"]
      return []
    })
  }
  if ("AlterDomainStmt" in stmt) {
    const { subtype, def } = stmt.AlterDomainStmt
    if (subtype === undefined) return []
    if (RELAXING_DOMAIN_ALTERS.has(subtype)) return ["relaxation"]
    if (
      SCANNING_DOMAIN_ALTERS.has(subtype) ||
      (subtype === "C" && scansOnAdd(def))
    )
      return ["validationScan"]
    return []
  }
  if ("DropStmt" in stmt) {
    const { removeType, objects } = stmt.DropStmt
    if (removeType !== undefined && RELAXING_DROPS.has(removeType))
      return ["relaxation"]
    if (removeType !== "OBJECT_INDEX") return []
    // Унікальність знятого індексу знає лише модель цілі: в операторі її
    // немає. Індекса, якого модель не бачить (опції зберігання, tablespace,
    // `ON ONLY` модель не несе), класифікатор не вважає неунікальним: краще
    // зайвий дозвіл, ніж знята без дозволу гарантія унікальності — те саме
    // правило, що «старого типу колонки не видно — destructive»
    const relaxing = (objects ?? []).some((object) => {
      const names = "List" in object ? stringsOf(object.List.items) : []
      const name = names.at(-1)
      const known =
        name === undefined ? undefined : find(facts.indexes, names.at(-2), name)
      return known === undefined || known.unique
    })
    return relaxing ? ["relaxation"] : []
  }
  if ("IndexStmt" in stmt) {
    const { unique, relation } = stmt.IndexStmt
    if (unique !== true || relation?.relname === undefined) return []
    // Унікальний індекс на таблиці, яку створює сам план, нічого не сканує.
    // Таблицю, якої модель не знає і план не створює, вважаємо наявною:
    // невідоме отримує найсуворіший клас
    const { schemaname, relname } = relation
    const createdHere =
      find(facts.tables, schemaname, relname) === undefined &&
      [...facts.createdTables].some((id) =>
        schemaname === undefined
          ? id.endsWith(`.${relname}`)
          : id === `table:${schemaname}.${relname}`
      )
    return createdHere ? [] : ["validationScan"]
  }
  return []
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
 * рішення 10. Зміна типу з втратами — вище за `tableRewrite`: переписування
 * таблиці не каже, чи збереглися значення.
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
  const effects = stmts.flatMap((stmt) => statementEffects(stmt, facts))
  if (effects.includes("destructive")) return "destructive"
  if (action.rewriteRisk) return "tableRewrite"
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
 * Тип колонки з моделі: рядок `format_type()` розбирає той самий парсер, що
 * й оператор, тож обидва боки зводяться до одного дерева типу.
 */
function columnTypeReader(
  parse: SqlParser
): (table: CatalogTable, column: string) => ColumnType | undefined {
  return (table, column) => {
    const type = table.columns.find((c) => c.name === column)?.type
    return type === undefined ? undefined : typeOf(parseType(type, parse))
  }
}

/**
 * Id кроку за його позицією в плані: `s1`, `s2`, … Одне місце для правила —
 * за цими id дають дозвіл і їх називають діагностики плану.
 */
export const stepId = (index: number): string => `s${index + 1}`

/**
 * Крок наміру платформи (рішення 3 плану П3-2a): лише перейменування й
 * інші зміни каталогу без даних, тож клас і блокування сталі. Таблиці —
 * у старих іменах: раннер блокує їх до першого кроку, коли нових імен ще
 * немає.
 */
export function intentStep(
  sql: string,
  lockedTables: LockedTable[]
): Omit<PlanStep, "id"> {
  return {
    origin: "intent",
    sql,
    verb: "alter",
    class: "catalogOnly",
    lockClass: "accessExclusive",
    transactionality: "transactional",
    newSegmentBefore: false,
    lockedTables,
    produces: [],
    consumes: [],
    destroys: [],
    produced: [],
    destroyed: [],
    consumed: [],
    dataLoss: false,
    rewriteRisk: false,
    guards: [],
  }
}

/**
 * Класи кроків із прапорів двигуна й дерева розбору. `target` — модель
 * каталогу цілі, тобто вихідного стану плану: лише вона знає, чи знятий
 * індекс унікальний, чи таблиця вже існує і який тип мала колонка.
 * `offset` — кількість кроків наміру перед кроками двигуна: нумерація
 * наскрізна, тож дозвіл на `s<N>` однозначний у всьому плані.
 * `noReplacement` — id кроків, для яких виняток «заміна» не діє: під
 * промоцією прийнятий об'єкт, перевизначений під тим самим ім'ям, — це
 * видалення плюс створення (рішення 3 плану П3-2a).
 */
export function classifySteps(
  actions: readonly EngineAction[],
  target: CatalogModel,
  parse: SqlParser,
  offset = 0,
  o: { noReplacement?: ReadonlySet<string> } = {}
): PlanStep[] {
  const facts: Facts = {
    indexes: target.tables.flatMap((t) =>
      t.indexes.map((i) => ({
        schema: t.schema,
        name: i.name,
        unique: i.unique,
      }))
    ),
    tables: target.tables,
    createdTables: new Set(
      actions.flatMap((a) => a.produces.filter((id) => id.startsWith("table:")))
    ),
    columnType: columnTypeReader(parse),
  }
  return actions.map((action, index) => {
    const id = stepId(offset + index)
    const base = baseClass(action, parsed(id, action.sql, parse), facts)
    // Виняток не перекриває втрату даних: `destructive` сюди не доходить
    const cls =
      base === "relaxation" &&
      o.noReplacement?.has(id) !== true &&
      isReplacement(action, actions.slice(index + 1))
        ? "catalogOnly"
        : base
    return {
      id,
      origin: "engine",
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
      produced: action.produced,
      destroyed: action.destroyed,
      consumed: action.consumed,
      dataLoss: action.dataLoss,
      rewriteRisk: action.rewriteRisk,
      guards: guardsOf(typeGuards({ id, sql: action.sql }, target, parse)),
    }
  })
}

/**
 * Сторожі кроку; відмову побудувати сторожа план збирає окремо тим самим
 * `typeGuards`, тож крок без сторожів тут ще не означає «перевіряти нічого».
 */
const guardsOf = (result: ReturnType<typeof typeGuards>): string[] =>
  "guards" in result ? result.guards : []

const isCascade = (behavior: string | undefined): boolean =>
  behavior === "DROP_CASCADE"

/** `OBJECT_FOREIGN_TABLE` → `FOREIGN TABLE`. */
const objectWords = (objtype: string | undefined): string =>
  objtype === "OBJECT_MATVIEW"
    ? "MATERIALIZED VIEW"
    : (objtype ?? "").replace(/^OBJECT_/, "").replace(/_/g, " ")

/**
 * Оператори, у яких `CASCADE` знищує чи відбирає залежне, яке план не
 * називає (платформна спека §6.6): DROP, видалення колонки, атрибута чи
 * обмеження, TRUNCATE, REVOKE привілеїв і ролей. `ADD`/`RENAME ATTRIBUTE
 * … CASCADE` і `ALTER ATTRIBUTE … TYPE … CASCADE` лише поширюють зміну на
 * типізовані таблиці; останню класифікує правило зміни типу.
 */
function cascadeVerbs(stmt: Node): string[] {
  if ("DropStmt" in stmt)
    return isCascade(stmt.DropStmt.behavior)
      ? [`DROP ${objectWords(stmt.DropStmt.removeType)}`]
      : []
  if ("DropOwnedStmt" in stmt)
    return isCascade(stmt.DropOwnedStmt.behavior) ? ["DROP OWNED"] : []
  if ("TruncateStmt" in stmt)
    return isCascade(stmt.TruncateStmt.behavior) ? ["TRUNCATE"] : []
  if ("GrantStmt" in stmt)
    return stmt.GrantStmt.is_grant !== true &&
      isCascade(stmt.GrantStmt.behavior)
      ? ["REVOKE"]
      : []
  // `REVOKE роль FROM роль … CASCADE` відкликає й членство чи гранти, видані
  // через цю роль, — так само залежне, якого план не називає
  if ("GrantRoleStmt" in stmt)
    return stmt.GrantRoleStmt.is_grant !== true &&
      isCascade(stmt.GrantRoleStmt.behavior)
      ? ["REVOKE ROLE"]
      : []
  if ("AlterDomainStmt" in stmt)
    return stmt.AlterDomainStmt.subtype === "X" &&
      isCascade(stmt.AlterDomainStmt.behavior)
      ? ["ALTER DOMAIN … DROP CONSTRAINT"]
      : []
  if ("AlterTableStmt" in stmt) {
    const { objtype, cmds } = stmt.AlterTableStmt
    const alter = `ALTER ${objectWords(objtype)}`
    return (cmds ?? []).flatMap((node) => {
      if (!("AlterTableCmd" in node)) return []
      const { subtype, behavior } = node.AlterTableCmd
      if (!isCascade(behavior)) return []
      if (subtype === "AT_DropConstraint") return [`${alter} … DROP CONSTRAINT`]
      if (subtype === "AT_DropColumn")
        return [
          `${alter} … DROP ${objtype === "OBJECT_TYPE" ? "ATTRIBUTE" : "COLUMN"}`,
        ]
      return []
    })
  }
  return []
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
  return steps.flatMap((step) => {
    const verbs = [
      ...new Set(parsed(step.id, step.sql, parse).flatMap(cascadeVerbs)),
    ]
    return [
      ...(verbs.length > 0
        ? [
            applyDiagnostic("apply.cascade", "error", {
              step: step.id,
              verb: verbs.join(", "),
            }),
          ]
        : []),
      ...(step.transactionality === "nonTransactional"
        ? [
            applyDiagnostic("apply.non-transactional", "error", {
              step: step.id,
            }),
          ]
        : []),
      ...(step.newSegmentBefore
        ? [applyDiagnostic("apply.commit-boundary", "error", { step: step.id })]
        : []),
    ]
  })
}

const NEEDS_PERMISSION: ReadonlySet<StepClass> = new Set<StepClass>([
  "destructive",
  "relaxation",
])

/**
 * Токен `allow`, що приймає дрейф плану (платформна спека §6.6). Не
 * збігається з жодним id кроку, бо ті мають форму `s<N>`.
 */
export const DRIFT_PERMISSION = "drift"

/**
 * Пункт дозволу промоції (рішення 8 плану П3-2a): токен `access:`,
 * `delete:` чи `remove:` і те, що людина переглядає перед дозволом.
 */
export interface PermissionItem {
  token: string
  summary: string[]
}

/** Що в плані дозволяють: кроки, дрейф і пункти промоції. */
export interface PermissionSubject {
  steps: readonly PlanStep[]
  drift: DriftReport | null
  promotion: { permissionItems: readonly PermissionItem[] } | null
}

/**
 * Групи токенів промоції в порядку перегляду: спершу зміна доступу, потім
 * семантика видалення, далі видалене з дозволом.
 */
const PROMOTION_GROUPS = ["access:", "delete:", "remove:"] as const

const groupOf = (token: string): number =>
  PROMOTION_GROUPS.findIndex((prefix) => token.startsWith(prefix))

/**
 * Порядок пунктів промоції: група, усередині — за кодовими одиницями, а не
 * за локаллю, щоб порядок не залежав від машини.
 */
export function comparePermissionItems(
  a: PermissionItem,
  b: PermissionItem
): number {
  const group = groupOf(a.token) - groupOf(b.token)
  if (group !== 0) return group
  return a.token < b.token ? -1 : a.token > b.token ? 1 : 0
}

/**
 * Пункти, яким потрібен явний дозвіл: дрейф першим — його переглядають до
 * кроків, бо кроки показують, що станеться з об'єктами, які дрейфнули, —
 * далі пункти промоції (`access:`, `delete:`, `remove:`), бо вони кажуть,
 * чим стане таблиця, а не як туди дійти, і насамкінець id кроків у порядку
 * плану.
 */
export function requiredPermissions(plan: PermissionSubject): string[] {
  const promotion = [...(plan.promotion?.permissionItems ?? [])]
    .sort(comparePermissionItems)
    .map((i) => i.token)
  return [
    ...(plan.drift === null ? [] : [DRIFT_PERMISSION]),
    ...new Set(promotion),
    ...plan.steps.filter((s) => NEEDS_PERMISSION.has(s.class)).map((s) => s.id),
  ]
}

/**
 * Дозволи `allow` проти плану. Пункти рахуються тут із кроків, дрейфу й
 * пунктів промоції, а не беруться з поля `requiredPermissions` артефакту:
 * поле лише показ. Зайвий пункт — теж відмова: дозвіл на крок, якого немає
 * чи який дозволу не потребує, на дрейф чи пункт промоції, яких план не має,
 * означає, що автор дозволяв інший план.
 */
export function checkPermissions(
  plan: PermissionSubject,
  allow: readonly string[]
): EngineDiagnostic[] {
  const required = requiredPermissions(plan)
  const allowed = new Set(allow)
  const missing = required.filter((id) => !allowed.has(id))
  const unknown = [...allowed].filter((id) => !required.includes(id))
  return [
    ...(missing.length > 0
      ? [
          applyDiagnostic("apply.permission-required", "error", {
            items: missing.join(", "),
          }),
        ]
      : []),
    ...(unknown.length > 0
      ? [
          applyDiagnostic("apply.permission-unknown", "error", {
            items: unknown.join(", "),
          }),
        ]
      : []),
  ]
}
