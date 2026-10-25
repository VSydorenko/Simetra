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
import { DYNAMIC_SQL_BUILTINS } from "../sql/reach"
import type { SqlParser } from "../sql/parse"
import type { PlpgsqlParser } from "../sql/plpgsql"
import { functionIdentity, type VerbatimUnit } from "../sql/units"
import { PROJECT_FILE } from "../stages/files"
import {
  bodyHasUnqualifiedRelation,
  nullaryFunction,
  setFunctionClosedProblem,
  volatilityProblem,
  type FunctionNode,
  type SetFunctionReason,
} from "../sql/function-shape"

const PLATFORM = CURRENT_USER_FUNCTION.schema
const CURRENT_USER = `${PLATFORM}.${CURRENT_USER_FUNCTION.name}`
const ARROW = " → "

/** Причина закритої форми функції виміру й ланок понад причини функції множини. */
type DimensionFunctionReason = SetFunctionReason | "viewUnqualified"

const FUNCTION_CLASSES: ReadonlySet<string> = new Set(["function"])
const VIEW_CLASSES: ReadonlySet<string> = new Set(["view", "materializedView"])

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
 * дійсного членства — листи, їхні тіла пише компілятор. Таблиці системних
 * довідників прав (`rightsTables`, `схема.ім'я`) — теж дані прав.
 */
export function checkDimensionFunctions(
  project: Project,
  units: readonly VerbatimUnit[],
  membershipFunctions: ReadonlySet<string>,
  rightsTables: ReadonlySet<string>,
  parse: SqlParser,
  plpgsql: PlpgsqlParser
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
    const fn = nullaryFunction(units, schema, name, {
      type: "uuid",
      setof: true,
    })
    if (fn === undefined) {
      at("rights.dimension-function-missing", { function: qualified })
      return
    }
    const problem = typeof fn === "string" ? fn : volatilityProblem(fn)
    const reason: DimensionFunctionReason | undefined =
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
    walk(head, qualified, units, membershipFunctions, rightsTables, parse, at)
  })
  return found
}

/**
 * Функції значень вимірів доступу й кожна ланка їхніх ланцюжків — тим самим
 * обходом, що їх судить: оболонку цих функцій задає лише `CREATE`, тож
 * окремий `ALTER FUNCTION` на будь-яку з них — помилка (Р2c1-10,
 * `sql.function-settings-shell`).
 */
export function dimensionFunctionUnits(
  project: Project,
  units: readonly VerbatimUnit[],
  parse: SqlParser
): VerbatimUnit[] {
  return project.accessDimensions.flatMap((dimension) => {
    if (!("function" in dimension.values)) return []
    const { schema = project.defaultSchema, name } = dimension.values.function
    const head = units.find(
      (u) => u.identity === functionIdentity(schema, name, [])
    )
    if (head === undefined) return []
    // Діагностики тут не потрібні — лише одиниці, яких досягає обхід.
    return walk(
      head,
      `${schema}.${name}`,
      units,
      new Set(),
      new Set(),
      parse,
      () => {}
    ).filter((u) => u.class === "function")
  })
}

/**
 * Обхід у ширину від функції виміру за викликами й за відношеннями-
 * представленнями проєкту: представлення читає свої таблиці від імені
 * власника так само, як функція. Відвідані одиниці — множина: цикл (його
 * окремо відхиляє порядок створення) не зациклює обхід.
 */
function walk(
  head: VerbatimUnit,
  headName: string,
  units: readonly VerbatimUnit[],
  membershipFunctions: ReadonlySet<string>,
  rightsTables: ReadonlySet<string>,
  parse: SqlParser,
  at: (code: RuleCode, params: DiagnosticParams) => void
): VerbatimUnit[] {
  const readsRights = (chain: readonly string[], object: string) =>
    at("rights.dimension-function-reads-rights", {
      chain: chain.join(ARROW),
      object,
    })
  const visited = new Set<string>([head.identity])
  const reached: VerbatimUnit[] = [head]
  const queue: Step[] = [{ unit: head, chain: [headName] }]
  const named = (classes: ReadonlySet<string>, name: string, schema?: string) =>
    units.filter(
      (u) =>
        classes.has(u.class) &&
        u.name === name &&
        (schema === undefined || u.schema === schema)
    )
  const enqueue = (unit: VerbatimUnit, chain: readonly string[]) => {
    if (visited.has(unit.identity)) return
    visited.add(unit.identity)
    reached.push(unit)
    const next = [...chain, `${unit.schema}.${unit.name}`]
    if (unit.class === "function") {
      const language = routineLanguage(unit.tree as Node)
      if (language !== "sql") {
        readsRights(next, language === "plpgsql" ? "plpgsql" : "unknown")
        return
      }
      const reason = linkProblem(unit, parse)
      if (reason !== undefined) {
        at("rights.dimension-function-signature", {
          function: `${unit.schema}.${unit.name}`,
          reason,
        })
      }
    }
    queue.push({ unit, chain: next })
  }
  for (let step = queue.shift(); step !== undefined; step = queue.shift()) {
    const { unit, chain } = step
    // Представлення не має власного `search_path`: імена в ньому зв'язуються
    // під час створення з `search_path` сесії, якого компілятор не знає.
    const view = VIEW_CLASSES.has(unit.class)
    let unqualified = false
    for (const relation of unitRelations(unit, parse)) {
      if (relation.schema === undefined) {
        unqualified ||= view
        continue
      }
      const qualified = `${relation.schema}.${relation.name}`
      if (relation.schema === PLATFORM || rightsTables.has(qualified)) {
        readsRights(chain, qualified)
        continue
      }
      for (const target of named(
        VIEW_CLASSES,
        relation.name,
        relation.schema
      )) {
        enqueue(target, chain)
      }
    }
    for (const call of unitCalls(unit, parse)) {
      if (call.schema === undefined || call.schema === "pg_catalog") {
        if (DYNAMIC_SQL_BUILTINS.has(call.name)) {
          readsRights(chain, "dynamic")
          continue
        }
        // З `search_path = ''` (його має кожна функція ланцюжка)
        // некваліфікований виклик розв'язується лише в `pg_catalog`. У
        // представленні — будь-де, навіть у схемі платформи, тож там
        // вбудована функція пишеться як `pg_catalog.<ім'я>`.
        if (call.schema === undefined) unqualified ||= view
        continue
      }
      const callee = `${call.schema}.${call.name}`
      // Перевантаження за типами аргументів компілятор не розрізняє, тож
      // судить кожну одиницю проєкту з таким ім'ям — і тоді, коли ім'я
      // збігається зі згенерованою функцією членства: довіра — лише самій
      // згенерованій.
      const project = named(FUNCTION_CLASSES, call.name, call.schema)
      if (project.length > 0) {
        for (const target of project) enqueue(target, chain)
        continue
      }
      if (callee === CURRENT_USER || membershipFunctions.has(callee)) continue
      if (call.schema === PLATFORM) readsRights(chain, callee)
      else readsRights([...chain, callee], "unknown")
    }
    if (unqualified) {
      at("rights.dimension-function-signature", {
        function: chain.at(-1) ?? "",
        reason: "viewUnqualified",
      })
    }
  }
  return reached
}

/**
 * Закрита форма ланки: `SET search_path = ''`, рядкове тіло й кваліфіковані
 * відношення. `STABLE` і `SECURITY DEFINER` вимагає лише функція виміру —
 * ланка виконується в її контексті; але без порожнього `search_path` ланки
 * некваліфіковане ім'я непомітно спрямувалося б у схему платформи. Тіло
 * стандарту SQL зв'язує імена під час створення з `search_path` сесії, тож
 * його компілятор не судить і відхиляє (fail-closed).
 */
function linkProblem(
  unit: VerbatimUnit,
  parse: SqlParser
): DimensionFunctionReason | undefined {
  const tree = unit.tree as Node
  if (!hasEmptySearchPath(tree)) return "searchPath"
  const fn = (tree as { CreateFunctionStmt?: FunctionNode }).CreateFunctionStmt
  if (fn === undefined) return undefined
  if (fn.sql_body !== undefined) return "sqlBody"
  return bodyHasUnqualifiedRelation(fn, parse) ? "unqualified" : undefined
}
