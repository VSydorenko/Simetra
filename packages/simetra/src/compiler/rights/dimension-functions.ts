import type { Node } from "libpg-query"
import type { Project } from "simetra/model"
import {
  diagnostic,
  toPointer,
  type Diagnostic,
  type DiagnosticParams,
  type RuleCode,
} from "../diagnostics"
import { CURRENT_USER_FUNCTION } from "../platform/names"
import { hasEmptySearchPath, routineLanguage } from "../sql/closed-forms"
import { unitCalls, unitRelations } from "../sql/dependencies"
import type { SqlParser } from "../sql/parse"
import type { PlpgsqlParser } from "../sql/plpgsql"
import { functionIdentity, type VerbatimUnit } from "../sql/units"
import {
  bodyHasUnqualifiedRelation,
  nullaryFunction,
  setFunctionClosedProblem,
  volatilityProblem,
  type FunctionNode,
  type SetFunctionReason,
} from "../stages/links"

const PLATFORM = CURRENT_USER_FUNCTION.schema
const CURRENT_USER = `${PLATFORM}.${CURRENT_USER_FUNCTION.name}`
const ARROW = " → "

/** Ланка ланцюжка в черзі обходу: одиниця й шлях імен до неї від виміру. */
interface Step {
  unit: VerbatimUnit
  chain: readonly string[]
}

/**
 * Функція значень виміру доступу (спека прав §4.4, Р1a-14). Перевірка прав
 * кличе її в політиці, тож вона мусить мати закриту форму функції множини
 * скоупу й сама не читати прав: інакше право залежало б від права, а читання
 * захищених таблиць прав із `SECURITY DEFINER` обходило б їхній RLS. Що функція
 * читає, видно лише транзитивно, тож обхід іде за викликами дослівних
 * sql-функцій проєкту, і кожна ланка теж має закриту оболонку. Тіла plpgsql
 * компілятор не читає (динамічний SQL і `PERFORM` ховають читання), тож
 * plpgsql чи невідома кваліфікована функція в ланцюжку — помилка (fail-closed).
 * Зі схеми платформи дозволено лише `current_user_id()`; згенеровані функції
 * дійсного членства — листи, їхні тіла пише компілятор.
 */
export function checkDimensionFunctions(
  project: Project,
  units: readonly VerbatimUnit[],
  membershipFunctions: ReadonlySet<string>,
  parse: SqlParser,
  plpgsql: PlpgsqlParser
): Diagnostic[] {
  const found: Diagnostic[] = []
  project.accessDimensions.forEach((dimension, index) => {
    if (!("function" in dimension.values)) return
    const pointer = toPointer(["accessDimensions", index, "values", "function"])
    const at = (code: RuleCode, params: DiagnosticParams) =>
      found.push(
        diagnostic(code, "project.meta.json", pointer, {
          dimension: dimension.name,
          ...params,
        })
      )
    const { schema = project.defaultSchema, name } = dimension.values.function
    const qualified = `${schema}.${name}`
    const fn = nullaryFunction(units, schema, name, {
      type: "uuid",
      setof: true,
    })
    if (fn === undefined) {
      at("rights.dimension-function-missing", { function: qualified })
      return
    }
    const problem = typeof fn === "string" ? fn : volatilityProblem(fn)
    const reason =
      typeof fn === "string" || problem !== undefined
        ? undefined
        : setFunctionClosedProblem(fn, units, schema, name, parse, plpgsql)
    // Спершу закрита форма: без неї мова чи search_path роблять обхід
    // безпідставним.
    if (reason !== undefined) {
      at("rights.dimension-function-signature", { function: qualified, reason })
      return
    }
    if (problem !== undefined) {
      at("rights.dimension-function-signature", {
        function: qualified,
        problem,
      })
      return
    }
    const head = units.find(
      (u) => u.identity === functionIdentity(schema, name, [])
    )
    if (head === undefined) return
    walk(head, qualified, units, membershipFunctions, parse, at)
  })
  return found
}

/**
 * Обхід у ширину від функції виміру. Відвідані одиниці — множина: цикл
 * викликів (його окремо відхиляє порядок створення) не зациклює обхід.
 */
function walk(
  head: VerbatimUnit,
  headName: string,
  units: readonly VerbatimUnit[],
  membershipFunctions: ReadonlySet<string>,
  parse: SqlParser,
  at: (code: RuleCode, params: DiagnosticParams) => void
): void {
  const readsRights = (chain: readonly string[], object: string) =>
    at("rights.dimension-function-reads-rights", {
      chain: chain.join(ARROW),
      object,
    })
  const visited = new Set<string>([head.identity])
  const queue: Step[] = [{ unit: head, chain: [headName] }]
  for (let step = queue.shift(); step !== undefined; step = queue.shift()) {
    const { unit, chain } = step
    for (const relation of unitRelations(unit, parse)) {
      if (relation.schema === PLATFORM) {
        readsRights(chain, `${relation.schema}.${relation.name}`)
      }
    }
    for (const call of unitCalls(unit, parse)) {
      // З `search_path = ''` (його має кожна ланка) некваліфікований виклик
      // розв'язується лише в `pg_catalog`.
      if (call.schema === undefined || call.schema === "pg_catalog") continue
      const callee = `${call.schema}.${call.name}`
      if (callee === CURRENT_USER || membershipFunctions.has(callee)) continue
      const next = [...chain, callee]
      const project = units.filter(
        (u) =>
          u.class === "function" &&
          u.schema === call.schema &&
          u.name === call.name
      )
      if (project.length === 0) {
        readsRights(
          call.schema === PLATFORM ? chain : next,
          call.schema === PLATFORM ? callee : "unknown"
        )
        continue
      }
      // Перевантаження за типами аргументів компілятор не розрізняє, тож
      // судить кожну одиницю з таким ім'ям.
      for (const candidate of project) {
        if (visited.has(candidate.identity)) continue
        visited.add(candidate.identity)
        const language = routineLanguage(candidate.tree as Node)
        if (language !== "sql") {
          readsRights(next, language === "plpgsql" ? "plpgsql" : "unknown")
          continue
        }
        const reason = linkProblem(candidate, parse)
        if (reason !== undefined) {
          at("rights.dimension-function-signature", {
            function: callee,
            reason,
          })
        }
        queue.push({ unit: candidate, chain: next })
      }
    }
  }
}

/**
 * Закрита форма ланки: `SET search_path = ''` і кваліфіковані відношення.
 * `STABLE` і `SECURITY DEFINER` вимагає лише функція виміру — ланка
 * виконується в її контексті; але без порожнього `search_path` ланки
 * некваліфіковане ім'я непомітно спрямувалося б у схему платформи.
 */
function linkProblem(
  unit: VerbatimUnit,
  parse: SqlParser
): SetFunctionReason | undefined {
  const tree = unit.tree as Node
  if (!hasEmptySearchPath(tree)) return "searchPath"
  const fn = (tree as { CreateFunctionStmt?: FunctionNode }).CreateFunctionStmt
  return fn !== undefined && bodyHasUnqualifiedRelation(fn, parse)
    ? "unqualified"
    : undefined
}
