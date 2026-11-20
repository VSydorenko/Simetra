import type { FuncCall } from "libpg-query"
import { PLATFORM_SCHEMA, type DatabaseProvider } from "simetra/model"
import { diagnostic, type Diagnostic } from "../diagnostics"
import { BUILTIN_FUNCTIONS } from "./builtin-functions"
import { literalText, providerCalls } from "./command-context"
import { unitCalls, type ReferencedName } from "./dependencies"
import type { SqlParser } from "./parse"
import type { VerbatimUnit } from "./units"
import { sequenceCallTarget } from "./write-paths"

/*
 * Одиниці-вирази (спека прав §5.3): вирази метаданих прийнятих таблиць, подання,
 * вирази дослівних політик, складові агрегатів, тригери (`EXECUTE FUNCTION`,
 * `WHEN`) і `DEFAULT` доменів. Postgres обчислює їх на кожному записі чи
 * читанні, зокрема ролі API через PostgREST, тож виклики в них — дозвільний
 * перелік у будь-якому файлі, борг включно: денайліст записів сесії
 * (`set_config`, виконання тексту SQL) обходився б кожною новою функцією.
 */

/** Що одиниця-вираз може кликати, крім функцій платформи (спека прав §5.3). */
export interface ExpressionScope {
  builtins: ReadonlySet<string>
  /**
   * `схема.ім'я` функцій, процедур і агрегатів моделі в схемах застосунку (їхні
   * тіла судить перелік тіла, спека прав §6.1); збирач той самий, що в судді
   * тіла (`modelCallNames`).
   */
  models: ReadonlySet<string>
  /** `схема.ім'я` послідовностей моделі — для `nextval` у `DEFAULT`. */
  sequences: ReadonlySet<string>
  /**
   * Імена послідовностей платформи (`platformSequenceNames`): виклик
   * `nextval`/`setval` на них судить форма `sequence` Правила 1, тож тут він
   * другої діагностики не дає.
   */
  platformSequences: ReadonlySet<string>
  providerSchemas: ReadonlySet<string>
  providerFunctions: ReadonlySet<string>
  /**
   * Згенеровані функції, яких це правило не судить: їх судить
   * `sql.platform-function-call` (спека прав §5.3), тож друга діагностика була б
   * шумом.
   */
  generated: ReadonlySet<string>
}

export function expressionScope(
  units: readonly VerbatimUnit[],
  provider: DatabaseProvider,
  generated: ReadonlySet<string>,
  platformSequences: ReadonlySet<string>
): ExpressionScope {
  const calls = providerCalls(provider, units, generated)
  return {
    builtins: new Set(BUILTIN_FUNCTIONS),
    models: calls.models,
    sequences: new Set(
      units
        .filter((u) => u.class === "sequence")
        .map((u) => `${u.schema}.${u.name}`)
    ),
    platformSequences,
    providerSchemas: calls.schemas,
    providerFunctions: calls.allowed,
    generated,
  }
}

/**
 * Ім'я виклику поза переліком або `undefined`: вбудована з переліку
 * (некваліфікована чи `pg_catalog.`), функція моделі за `схема.ім'я`,
 * поіменна функція провайдера. Схему платформи й згенеровані функції судить
 * `sql.platform-function-call` (спека прав §5.3). Некваліфікований виклик не вбудованої — fail-closed: шлях
 * пошуку, за яким Postgres його зв'язав, статично не відомий.
 */
export function expressionCallProblem(
  call: ReferencedName,
  scope: ExpressionScope
): string | undefined {
  const { schema, name } = call
  if (schema === undefined) return scope.builtins.has(name) ? undefined : name
  const qualified = `${schema}.${name}`
  if (schema === "pg_catalog")
    return scope.builtins.has(name) ? undefined : qualified
  if (schema === PLATFORM_SCHEMA || scope.generated.has(qualified))
    return undefined
  if (scope.models.has(qualified)) return undefined
  if (scope.providerSchemas.has(schema))
    return scope.providerFunctions.has(qualified) ? undefined : qualified
  return qualified
}

/**
 * Дозвільний перелік виразів: одиниці, чиї виклики Postgres виконує на
 * записі, читанні чи побудові агрегату. Агрегат — складові (`SFUNC`…): їх
 * виконує роль, що кличе агрегат; тригер — `EXECUTE FUNCTION` і `WHEN`; домен —
 * лише `DEFAULT` (`CHECK` домену судить суворіше правило голів
 * `checkDomainChecks`).
 */
const EXPRESSION_CLASSES: ReadonlySet<VerbatimUnit["class"]> = new Set([
  "view",
  "materializedView",
  "policy",
  "aggregate",
  "trigger",
  "domain",
])

/** Чи судить одиниця свої виклики як вираз (спека прав §5.3). */
export function isExpressionUnit(unit: Pick<VerbatimUnit, "class">): boolean {
  return EXPRESSION_CLASSES.has(unit.class)
}

/**
 * Дерево домену без обмежень, для яких `keep` хибне. Домен судять два
 * правила: `DEFAULT` — дозвільний перелік виразів, решту (`CHECK`) — правило
 * голів (`checkDomainChecks`) і контекст команди, тож кожне бачить свою частину.
 */
function domainTree(
  tree: unknown,
  keep: (contype: string | undefined) => boolean
): unknown {
  const domain = (
    tree as {
      CreateDomainStmt?: {
        constraints?: { Constraint?: { contype?: string } }[]
      }
    }
  ).CreateDomainStmt
  return {
    CreateDomainStmt: {
      ...domain,
      constraints: (domain?.constraints ?? []).filter((c) =>
        keep(c.Constraint?.contype)
      ),
    },
  }
}

/** Те, що судить дозвільний перелік виразів: для домену — лише `DEFAULT`. */
function expressionTree(unit: VerbatimUnit): unknown {
  return unit.class === "domain"
    ? domainTree(unit.tree, (c) => c === "CONSTR_DEFAULT")
    : unit.tree
}

/**
 * Дерево одиниці без частини, яку судить дозвільний перелік виразів: для
 * домену — без `DEFAULT`; решта (`CHECK`) лишається судді запису сесії.
 */
export function treeBeyondExpressions(unit: VerbatimUnit): unknown {
  return unit.class === "domain"
    ? domainTree(unit.tree, (c) => c !== "CONSTR_DEFAULT")
    : unit.tree
}

/** Виклики `setval`/`nextval` дерева, які судить форма `sequence` Правила 1. */
function sequenceFormCalls(
  value: unknown,
  platform: ReadonlySet<string>
): ReferencedName[] {
  if (Array.isArray(value))
    return value.flatMap((v) => sequenceFormCalls(v, platform))
  if (typeof value !== "object" || value === null) return []
  const node = value as Record<string, unknown>
  const call = node.FuncCall as FuncCall | undefined
  const own: ReferencedName[] = []
  if (call !== undefined && sequenceCallTarget(call, platform) !== undefined) {
    const names = (call.funcname ?? []).map((n) =>
      "String" in n ? (n.String.sval ?? "") : ""
    )
    const name = names.at(-1) ?? ""
    own.push(names.length > 1 ? { schema: names.at(-2)!, name } : { name })
  }
  return [
    ...own,
    ...Object.values(node).flatMap((v) => sequenceFormCalls(v, platform)),
  ]
}

const callKey = (call: ReferencedName) => `${call.schema ?? ""}.${call.name}`

function tally(calls: readonly ReferencedName[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const call of calls)
    counts.set(callKey(call), (counts.get(callKey(call)) ?? 0) + 1)
  return counts
}

/**
 * Одиниці-вирази будь-якого файлу, борг включно: одна діагностика
 * `sql.expression-call-not-allowed` на кожен виклик поза переліком. Виклик
 * `nextval`/`setval` на послідовність платформи судить форма `sequence`
 * Правила 1 (одне правило — одне місце): тут його немає, поки кожен виклик
 * цього імені в одиниці — з тих, що судить вона.
 */
export function checkExpressionCalls(
  units: readonly VerbatimUnit[],
  scope: ExpressionScope,
  parse: SqlParser
): Diagnostic[] {
  return units.flatMap((unit) => {
    if (!isExpressionUnit(unit)) return []
    const tree = expressionTree(unit)
    const all = unitCalls({ tree }, parse)
    const total = tally(all)
    const judged = tally(sequenceFormCalls(tree, scope.platformSequences))
    const calls = new Set(
      all.flatMap((call) => {
        const problem = expressionCallProblem(call, scope)
        return problem === undefined ||
          (judged.get(callKey(call)) ?? 0) >= (total.get(callKey(call)) ?? 0)
          ? []
          : [problem]
      })
    )
    return [...calls].map((call) =>
      diagnostic("sql.expression-call-not-allowed", unit.file, "", {
        unit: unit.identity,
        call,
        line: unit.line,
      })
    )
  })
}

interface CallNode {
  funcname?: { String?: { sval?: string } }[]
  args?: unknown[]
}

function isNextval(call: CallNode): boolean {
  const names = (call.funcname ?? []).map((f) => f.String?.sval)
  return (
    names.at(-1) === "nextval" &&
    (names.length === 1 || (names.length === 2 && names[0] === "pg_catalog"))
  )
}

function nextvalCalls(value: unknown): CallNode[] {
  if (Array.isArray(value)) return value.flatMap(nextvalCalls)
  if (typeof value !== "object" || value === null) return []
  const node = value as Record<string, unknown>
  const call = node.FuncCall as CallNode | undefined
  const own = call !== undefined && isNextval(call) ? [call] : []
  return [...own, ...Object.values(node).flatMap(nextvalCalls)]
}

/** Приведення літерала лише до `regclass` (чи без приведення). */
function regclassLiteral(arg: unknown): string | undefined {
  const cast = (arg as { TypeCast?: { typeName?: unknown } } | undefined)
    ?.TypeCast
  if (cast !== undefined) {
    const names = (
      (cast.typeName as { names?: { String?: { sval?: string } }[] })?.names ??
      []
    ).map((n) => n.String?.sval)
    if (
      names.at(-1) !== "regclass" ||
      (names.length > 1 && names[0] !== "pg_catalog")
    )
      return undefined
  }
  return literalText(arg)
}

/**
 * Чи кожен `nextval` дерева — `nextval('<схема>.<послідовність>'[::regclass])`
 * над послідовністю моделі поза схемою платформи (спека прав §5.3). Лише для
 * `columns[].default` прийнятої таблиці: так Postgres описує колонку
 * `serial`, а `nextval` загалом поза переліком вбудованих — він змінює
 * послідовність поза транзакцією і називає її текстом.
 */
export function modelSequenceDefault(
  tree: unknown,
  scope: ExpressionScope,
  parse: SqlParser
): boolean {
  const calls = nextvalCalls(tree)
  return (
    calls.length > 0 &&
    calls.every((call) => {
      if (call.args?.length !== 1) return false
      const text = regclassLiteral(call.args[0])
      if (text === undefined) return false
      // Ім'я послідовності розбирає сам Postgres-розбирач: лапки й регістр
      // ідентифікаторів — за його правилами, як у вводі `regclass`.
      const parsed = parse(`SELECT FROM ${text}`)
      if (!parsed.ok || parsed.statements.length !== 1) return false
      const from = (
        parsed.statements[0]!.stmt as {
          SelectStmt?: {
            fromClause?: {
              RangeVar?: {
                catalogname?: string
                schemaname?: string
                relname?: string
              }
            }[]
          }
        }
      ).SelectStmt?.fromClause
      const range = from?.length === 1 ? from[0]!.RangeVar : undefined
      return (
        range?.schemaname !== undefined &&
        range.catalogname === undefined &&
        range.schemaname !== PLATFORM_SCHEMA &&
        scope.sequences.has(`${range.schemaname}.${range.relname}`)
      )
    })
  )
}
