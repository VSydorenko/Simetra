import type { Node } from "libpg-query"
import { KIND_REGISTRY } from "simetra/model"
import { diagnostic, type Diagnostic } from "../diagnostics"
import type { ParsedObject } from "../stages/files"
import { FUNCTION_CLASSES, type RowRule, type VerbatimUnit } from "./units"

/** Чим функція виходить за закриту оболонку (спека промоції §9.4). */
export type ClosedShellProblem = "language" | "volatility" | "searchPath"

interface DefElem {
  defname?: string
  arg?: {
    String?: { sval?: string }
    Boolean?: { boolval?: boolean }
    VariableSetStmt?: {
      kind?: string
      name?: string
      args?: { A_Const?: { sval?: { sval?: string } } }[]
    }
  }
}

/**
 * Закрита оболонка функції (спека П2 §3, «Дослівний SQL»): мова `sql` чи
 * `plpgsql`, явна волатильність, `SECURITY DEFINER` лише з `SET search_path
 * = ''`. Оболонка — те, що компілятор може перевірити статично: тіло лишається
 * кодом застосунку, а мова C чи неявна `VOLATILE` ховали б від рамки те, що
 * функція робить. Не функція (процедура, інший оператор) — `undefined`:
 * оболонка описує лише `CREATE FUNCTION`.
 */
export function closedShellProblem(tree: Node): ClosedShellProblem | undefined {
  const fn = (
    tree as {
      CreateFunctionStmt?: {
        is_procedure?: boolean
        options?: { DefElem?: DefElem }[]
        sql_body?: unknown
      }
    }
  ).CreateFunctionStmt
  if (fn === undefined || fn.is_procedure === true) return undefined
  const options = (fn.options ?? []).flatMap((o) =>
    o.DefElem === undefined ? [] : [o.DefElem]
  )
  const option = (name: string) =>
    options.filter((o) => o.defname === name).at(-1)?.arg
  // Тіло стандарту SQL (`RETURN …`, `BEGIN ATOMIC`) без LANGUAGE — це `sql`.
  const language =
    option("language")?.String?.sval?.toLowerCase() ??
    (fn.sql_body === undefined ? undefined : "sql")
  if (language !== "sql" && language !== "plpgsql") return "language"
  if (option("volatility") === undefined) return "volatility"
  if (option("security")?.Boolean?.boolval === true) {
    // Останній `SET search_path` перемагає, як і в Postgres.
    const set = options
      .filter(
        (o) =>
          o.defname === "set" && o.arg?.VariableSetStmt?.name === "search_path"
      )
      .at(-1)?.arg?.VariableSetStmt
    const args = set?.args ?? []
    const empty =
      set?.kind === "VAR_SET_VALUE" &&
      args.length === 1 &&
      args[0]!.A_Const?.sval?.sval === ""
    if (!empty) return "searchPath"
  }
  return undefined
}

/**
 * Файли об'єктів, чий вид має факт `sqlModule: "closed"`: модуль такого
 * об'єкта приймає лише закриті форми. Вид — з `ownerFile` стадії 1, тож
 * перевірка не чекає моделі стадії 3.
 */
export function closedModuleOwners(
  objects: readonly ParsedObject[]
): ReadonlySet<string> {
  return new Set(
    objects
      .filter((o) => KIND_REGISTRY[o.kind].sqlModule === "closed")
      .map((o) => o.file)
  )
}

/**
 * Модуль об'єкта виду з фактом `sqlModule: "closed"` приймає лише функції в
 * закритій оболонці без перевантажень і правила рядка; блоки запиту рухів
 * вирізано до розбору, тож одиницями вони не стають. Решта класів —
 * `sql.statement-not-allowed` з підказкою властивості, що їх заміщує. Модуль
 * `debt` і спільні `sql/` тут не звужуються: це борг, його ратчет — окремо;
 * правило рядка поза модулем виду — помилка, бо воно належить таблиці
 * об'єкта, а таблиці боргу описані власними полями.
 */
export function checkSqlModules(
  objects: readonly ParsedObject[],
  units: readonly VerbatimUnit[],
  rowRules: readonly RowRule[]
): Diagnostic[] {
  const owners = closedModuleOwners(objects)
  const closed = (unit: { ownerFile?: string }) =>
    unit.ownerFile !== undefined && owners.has(unit.ownerFile)
  // Перевантаження рахуються серед усіх функцій схеми (простір `pg_proc`:
  // функції, процедури, агрегати), а не лише модуля: інакше друга сигнатура
  // в спільному файлі чи процедура з тим самим ім'ям обходила б заборону.
  const functionsByName = new Map<string, number>()
  for (const unit of units) {
    if (!FUNCTION_CLASSES.has(unit.class)) continue
    const key = `${unit.schema}.${unit.name}`
    functionsByName.set(key, (functionsByName.get(key) ?? 0) + 1)
  }
  const found: Diagnostic[] = []
  for (const rule of rowRules) {
    if (closed(rule)) continue
    found.push(
      diagnostic("sql.row-rule-outside-module", rule.file, "", {
        table: `${rule.schema}.${rule.table}`,
        line: rule.line,
      })
    )
  }
  for (const unit of units) {
    if (!closed(unit)) continue
    if (unit.class !== "function") {
      found.push(
        diagnostic("sql.statement-not-allowed", unit.file, "", {
          statement: Object.keys(unit.tree as object)[0] ?? "unknown",
          line: unit.line,
          detail: "kindModule",
          class: unit.class,
        })
      )
      continue
    }
    const problem = closedShellProblem(unit.tree as Node)
    if (problem !== undefined) {
      found.push(
        diagnostic("sql.closed-shell", unit.file, "", {
          function: `${unit.schema}.${unit.name}`,
          line: unit.line,
          problem,
        })
      )
    }
    if ((functionsByName.get(`${unit.schema}.${unit.name}`) ?? 0) > 1) {
      found.push(
        diagnostic("sql.function-overload", unit.file, "", {
          function: `${unit.schema}.${unit.name}`,
          identity: unit.identity,
          line: unit.line,
        })
      )
    }
  }
  return found
}
