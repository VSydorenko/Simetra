import type { Project } from "simetra/model"
import {
  diagnostic,
  toPointer,
  type Diagnostic,
  type DiagnosticParams,
  type RuleCode,
} from "../diagnostics"
import { judgeQueryFunction, type HeadScope } from "../sql/heads"
import type { PlpgsqlParser } from "../sql/plpgsql"
import { functionIdentity, type VerbatimUnit } from "../sql/units"
import { PROJECT_FILE } from "../stages/files"
import {
  nullaryFunction,
  setFunctionClosedProblem,
  volatilityProblem,
} from "../sql/function-shape"

const ARROW = " → "

/**
 * Функція значень виміру доступу (спека прав §4.4, Р1a-14). Перевірка прав
 * кличе її в політиці, тож вона мусить мати закриту форму функції множини
 * скоупу й сама не читати прав: інакше право залежало б від права, а читання
 * захищених таблиць прав із `SECURITY DEFINER` обходило б їхній RLS. Тіло й
 * ланки судить суддя голів (`sql.head-not-allowed`, Р2c1-17): тут — лише
 * підпис, оболонка й таблиці системних довідників прав (`rightsTables`,
 * `схема.ім'я`) серед відношень, які суддя прочитав. Функція з діагностикою
 * підпису чи оболонки потрапляє в `skip`: судити її тіло вже безпідставно.
 */
export function checkDimensionFunctions(
  project: Project,
  units: readonly VerbatimUnit[],
  rightsTables: ReadonlySet<string>,
  scope: HeadScope,
  plpgsql: PlpgsqlParser,
  skip: Set<string>
): Diagnostic[] {
  const found: Diagnostic[] = []
  project.accessDimensions.forEach((dimension, index) => {
    if (!("function" in dimension.values)) return
    const pointer = toPointer(["accessDimensions", index, "values", "function"])
    const at = (code: RuleCode, params: DiagnosticParams) =>
      found.push(
        diagnostic(code, PROJECT_FILE, pointer, {
          dimension: dimension.name,
          ...params,
        })
      )
    const { schema = project.defaultSchema, name } = dimension.values.function
    const qualified = `${schema}.${name}`
    const identity = functionIdentity(schema, name, [])
    const fn = nullaryFunction(units, schema, name, {
      type: "uuid",
      setof: true,
    })
    if (fn === undefined) {
      skip.add(identity)
      at("rights.dimension-function-missing", { function: qualified })
      return
    }
    const problem = typeof fn === "string" ? fn : volatilityProblem(fn)
    const reason =
      typeof fn === "string" || problem !== undefined
        ? undefined
        : setFunctionClosedProblem(fn, units, schema, name, plpgsql)
    if (reason !== undefined || problem !== undefined) {
      skip.add(identity)
      at(
        "rights.dimension-function-signature",
        reason !== undefined
          ? { function: qualified, reason }
          : { function: qualified, problem: problem! }
      )
      return
    }
    const head = units.find((u) => u.identity === identity)
    if (head === undefined) return
    const { relations } = judgeQueryFunction(head, scope, [qualified])
    const reported = new Set<string>()
    for (const { chain, relation } of relations) {
      if (!rightsTables.has(relation) || reported.has(relation)) continue
      reported.add(relation)
      at("rights.dimension-function-reads-rights", {
        chain: chain.join(ARROW),
        object: relation,
      })
    }
  })
  return found
}
