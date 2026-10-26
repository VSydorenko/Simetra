import {
  PLATFORM_SCHEMA,
  PROVIDER_EXPRESSION_FUNCTIONS,
  PROVIDER_FUNCTIONS,
  PROVIDER_SCHEMAS,
  type DatabaseProvider,
} from "simetra/model"
import { diagnostic, type Diagnostic } from "../diagnostics"
import { BUILTIN_FUNCTIONS } from "./builtin-functions"
import { literalText } from "./command-context"
import { unitCalls, type ReferencedName } from "./dependencies"
import type { SqlParser } from "./parse"
import type { VerbatimUnit } from "./units"

/*
 * Одиниці-вирази (Р2c1-55): вирази метаданих прийнятих таблиць, подання й
 * вирази дослівних політик. Postgres обчислює їх на кожному записі чи
 * читанні, зокрема ролі API через PostgREST, тож виклики в них — дозвільний
 * перелік у будь-якому файлі, борг включно: денайліст записів сесії
 * (`set_config`, виконання тексту SQL) обходився б кожною новою функцією.
 */

/** Що одиниця-вираз може кликати, крім функцій платформи (Р2c1-38). */
export interface ExpressionScope {
  builtins: ReadonlySet<string>
  /** `схема.ім'я` функцій моделі: їхні тіла судить перелік тіла (Р2c1-37). */
  models: ReadonlySet<string>
  /** `схема.ім'я` послідовностей моделі — для `nextval` у `DEFAULT`. */
  sequences: ReadonlySet<string>
  providerSchemas: ReadonlySet<string>
  providerFunctions: ReadonlySet<string>
  /**
   * Згенеровані функції, яких це правило не судить: їх судить
   * `sql.platform-function-call` (Р2c1-38), тож друга діагностика була б
   * шумом.
   */
  generated: ReadonlySet<string>
}

export function expressionScope(
  units: readonly VerbatimUnit[],
  provider: DatabaseProvider,
  generated: ReadonlySet<string>
): ExpressionScope {
  const named = (cls: VerbatimUnit["class"]) =>
    new Set(
      units.filter((u) => u.class === cls).map((u) => `${u.schema}.${u.name}`)
    )
  return {
    builtins: new Set(BUILTIN_FUNCTIONS),
    models: named("function"),
    sequences: named("sequence"),
    providerSchemas: new Set(PROVIDER_SCHEMAS[provider]),
    providerFunctions: new Set([
      ...PROVIDER_FUNCTIONS[provider],
      ...PROVIDER_EXPRESSION_FUNCTIONS[provider],
    ]),
    generated,
  }
}

/**
 * Ім'я виклику поза переліком або `undefined`: вбудована з переліку
 * (некваліфікована чи `pg_catalog.`), функція моделі за `схема.ім'я`,
 * поіменна функція провайдера. Схему платформи й згенеровані функції судить
 * Р2c1-38. Некваліфікований виклик не вбудованої — fail-closed: шлях
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

const EXPRESSION_CLASSES: ReadonlySet<VerbatimUnit["class"]> = new Set([
  "view",
  "materializedView",
  "policy",
])

/** Чи судить одиниця свої виклики як вираз (Р2c1-55). */
export function isExpressionUnit(unit: Pick<VerbatimUnit, "class">): boolean {
  return EXPRESSION_CLASSES.has(unit.class)
}

/**
 * Подання й політики будь-якого файлу, борг включно: одна діагностика
 * `sql.expression-call-not-allowed` на кожен виклик поза переліком.
 */
export function checkExpressionCalls(
  units: readonly VerbatimUnit[],
  scope: ExpressionScope,
  parse: SqlParser
): Diagnostic[] {
  return units.flatMap((unit) => {
    if (!isExpressionUnit(unit)) return []
    const calls = new Set(
      unitCalls(unit, parse).flatMap((call) => {
        const problem = expressionCallProblem(call, scope)
        return problem === undefined ? [] : [problem]
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
 * над послідовністю моделі поза схемою платформи (Р2c1-55). Лише для
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
