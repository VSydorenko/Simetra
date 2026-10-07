import {
  KIND_REGISTRY,
  type MetadataRef,
  type MovementDecl,
  type Project,
} from "simetra/model"
import type { Node } from "libpg-query"
import { diagnostic, toPointer, type Diagnostic } from "../diagnostics"
import type { SqlParser } from "../sql/parse"
import { functionIdentity, type VerbatimUnit } from "../sql/units"
import { objectKey, type ParsedObject } from "./files"
import { registerTargetError, type ResolvedReference } from "./identity"

/**
 * Стадія 5 (спека П2 §8.2): зв'язки між частинами моделі, які не видно в
 * одному файлі: повнота й вигляд джерел рухів та функції множини скоупів у
 * SQL-одиницях.
 */
export function checkLinks(
  objects: readonly ParsedObject[],
  references: readonly ResolvedReference[],
  project: Project,
  units: readonly VerbatimUnit[],
  parse: SqlParser
): Diagnostic[] {
  return [
    ...checkMovementSources(objects, references),
    ...checkMovementQueries(objects, parse),
    ...checkSetFunctions(project, units),
    ...checkSubscriptionHandlers(objects, project, units),
  ]
}

/**
 * Блок рухів — рівно один `SelectStmt` (`WITH … SELECT` і `UNION ALL` теж
 * він), що лише читає: тіло обгортки — `LANGUAGE sql`, і довільний оператор
 * там виконувався б під час читання рухів. Тому й усередині `SELECT` заборонені
 * CTE, що змінюють дані, `SELECT … INTO` і блокування рядків (`FOR UPDATE`,
 * `FOR SHARE`). Без `ORDER BY` порядок рядків недетермінований, тому лише
 * попередження: запит лишається чинним.
 */
function checkMovementQueries(
  objects: readonly ParsedObject[],
  parse: SqlParser
): Diagnostic[] {
  const found: Diagnostic[] = []
  for (const object of objects) {
    for (const block of object.movementBlocks ?? []) {
      const parsed = parse(block.sql)
      const select =
        parsed.ok && parsed.statements.length === 1
          ? (parsed.statements[0]!.stmt as Record<string, unknown>)
          : undefined
      const stmt = select?.SelectStmt as { sortClause?: unknown[] } | undefined
      const effect = stmt === undefined ? undefined : sideEffectOf(stmt)
      if (effect !== undefined) {
        found.push(
          diagnostic("posting.query-not-select", block.file, "", {
            line: block.line,
            detail: effect,
          })
        )
      } else if (stmt === undefined) {
        found.push(
          diagnostic("posting.query-not-select", block.file, "", {
            line: block.line,
            ...(parsed.ok
              ? {}
              : {
                  detail: `${parsed.message} (line ${block.line + 1 + lineOf(block.sql, parsed.offset)} of the file)`,
                }),
          })
        )
      } else if ((stmt.sortClause ?? []).length === 0) {
        found.push(
          diagnostic("posting.query-order-missing", block.file, "", {
            line: block.line,
          })
        )
      }
    }
  }
  return found
}

/** Вузли дерева, якими `SELECT` змінює дані. */
const WRITING_STATEMENTS: Readonly<Record<string, string>> = {
  InsertStmt: "INSERT",
  UpdateStmt: "UPDATE",
  DeleteStmt: "DELETE",
  MergeStmt: "MERGE",
}

/**
 * Перший побічний ефект у дереві `SELECT`, якщо він є: оператор, що змінює
 * дані (у `WITH` будь-якого рівня), `SELECT … INTO` чи блокування рядків у
 * будь-якому підзапиті.
 */
function sideEffectOf(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = sideEffectOf(item)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (typeof value !== "object" || value === null) return undefined
  const node = value as Record<string, unknown>
  for (const [key, child] of Object.entries(node)) {
    const writing = WRITING_STATEMENTS[key]
    if (writing !== undefined) return `${writing} is not allowed`
    if (key === "intoClause") return "SELECT INTO is not allowed"
    if (key === "lockingClause" && Array.isArray(child) && child.length > 0) {
      return "FOR UPDATE and FOR SHARE are not allowed"
    }
    const found = sideEffectOf(child)
    if (found !== undefined) return found
  }
  return undefined
}

/** 0-базний рядок усередині тексту за індексом UTF-16. */
function lineOf(text: string, offset: number): number {
  return text.slice(0, offset).split("\n").length - 1
}

/**
 * Функція множини скоупу має бути в SQL-одиницях проєкту: компілятор не
 * створює її сам, бо вона залежить від того, як застосунок визначає доступні
 * значення. Підпис перевіряється за деревом розбору, а не за текстом.
 */
function checkSetFunctions(
  project: Project,
  units: readonly VerbatimUnit[]
): Diagnostic[] {
  const found: Diagnostic[] = []
  project.scopeKinds.forEach((kind, index) => {
    const schema = kind.setFunction.schema ?? project.defaultSchema
    const name = kind.setFunction.name
    const pointer = toPointer(["scopeKinds", index, "setFunction"])
    const fn = nullaryFunction(units, schema, name, {
      type: "uuid",
      setof: true,
    })
    if (fn === undefined) {
      found.push(
        diagnostic("scope.set-function-missing", "project.meta.json", pointer, {
          function: `${schema}.${name}`,
        })
      )
      return
    }
    const problem = typeof fn === "string" ? fn : volatilityProblem(fn)
    if (problem !== undefined) {
      found.push(
        diagnostic(
          "scope.set-function-signature",
          "project.meta.json",
          pointer,
          {
            function: `${schema}.${name}`,
            problem,
          }
        )
      )
    }
  })
  return found
}

interface FunctionNode {
  parameters?: unknown[]
  returnType?: {
    names?: { String?: { sval?: string } }[]
    setof?: boolean
    arrayBounds?: unknown[]
  }
  options?: {
    DefElem?: { defname?: string; arg?: { String?: { sval?: string } } }
  }[]
}

/**
 * Функція без аргументів, що повертає `[SETOF] <тип>` (лише ім'я,
 * `pg_catalog.` — допустимий префікс): спільна частина підпису функції
 * множини й обробника підписки. Повертає вузол функції або причину.
 */
function nullaryReturning(
  tree: Node,
  returns: { type: string; setof: boolean }
): FunctionNode | string {
  const fn = (tree as { CreateFunctionStmt?: FunctionNode }).CreateFunctionStmt
  if (fn === undefined) return "it is not a function"
  const modes = (fn.parameters ?? []).map(
    (p) =>
      (p as { FunctionParameter?: { mode?: string } }).FunctionParameter?.mode
  )
  if (modes.includes("FUNC_PARAM_TABLE")) return "it returns a table"
  if (modes.some((m) => m === "FUNC_PARAM_OUT" || m === "FUNC_PARAM_INOUT")) {
    return "it has OUT parameters"
  }
  if (modes.length > 0) return "it takes arguments"
  const returned = fn.returnType
  const names = (returned?.names ?? []).map((n) => n.String?.sval)
  const matches =
    names.length > 0 &&
    names[names.length - 1] === returns.type &&
    (names.length === 1 || (names.length === 2 && names[0] === "pg_catalog")) &&
    (returned?.setof === true) === returns.setof &&
    (returned?.arrayBounds ?? []).length === 0
  if (!matches) {
    return `it does not return ${returns.setof ? "SETOF " : ""}${returns.type}`
  }
  return fn
}

/**
 * Функція `<схема>.<ім'я>` без аргументів серед SQL-одиниць: `undefined` —
 * функції з таким ім'ям немає, рядок — причина невідповідності підпису.
 */
function nullaryFunction(
  units: readonly VerbatimUnit[],
  schema: string,
  name: string,
  returns: { type: string; setof: boolean }
): FunctionNode | string | undefined {
  const sameName = units.filter(
    (u) => u.class === "function" && u.schema === schema && u.name === name
  )
  if (sameName.length === 0) return undefined
  const exact = sameName.find(
    (u) => u.identity === functionIdentity(schema, name, [])
  )
  return exact === undefined
    ? "it takes arguments"
    : nullaryReturning(exact.tree as Node, returns)
}

/** Функція множини читає дані, тож мусить бути STABLE. */
function volatilityProblem(fn: FunctionNode): string | undefined {
  const volatility = (fn.options ?? [])
    .map((o) => o.DefElem)
    .find((o) => o?.defname === "volatility")?.arg?.String?.sval
  // Без ключового слова Postgres бере VOLATILE.
  return volatility === "stable" ? undefined : "it is not STABLE"
}

/**
 * Обробник підписки — функція без аргументів з `RETURNS trigger` (спека
 * промоції §9.3) будь-де в `.sql` проєкту; тригер на неї генерує П3. Як і
 * функція множини, підпис читається з дерева розбору, а не з тексту.
 */
function checkSubscriptionHandlers(
  objects: readonly ParsedObject[],
  project: Project,
  units: readonly VerbatimUnit[]
): Diagnostic[] {
  const found: Diagnostic[] = []
  for (const object of objects) {
    const spec = KIND_REGISTRY[object.kind].subscription?.(object.data)
    if (spec === undefined) continue
    const schema = spec.handler.schema ?? project.defaultSchema
    const { name } = spec.handler
    const fn = `${schema}.${name}`
    const handler = nullaryFunction(units, schema, name, {
      type: "trigger",
      setof: false,
    })
    if (handler === undefined) {
      found.push(
        diagnostic("subscription.handler-missing", object.file, "/handler", {
          function: fn,
        })
      )
    } else if (typeof handler === "string") {
      found.push(
        diagnostic("subscription.handler-signature", object.file, "/handler", {
          function: fn,
          problem: handler,
        })
      )
    }
  }
  return found
}

/**
 * Кожен оголошений регістр документа має рівно одне джерело рухів: рухи
 * конструктора або один блок запиту. Два джерела чи блок для неоголошеного
 * регістра — помилка, а не тихий вибір одного: інакше обгортка проведення
 * писала б не те, що прочитає автор.
 */
function checkMovementSources(
  objects: readonly ParsedObject[],
  references: readonly ResolvedReference[]
): Diagnostic[] {
  const found: Diagnostic[] = []
  const byKey = new Map(objects.map((o) => [objectKey(o.kind, o.name), o]))
  const blocksByDocument = new Map<string, ResolvedReference[]>()
  for (const reference of references) {
    if (reference.role !== "posting.movementsBlock") continue
    const list = blocksByDocument.get(reference.from.objectId) ?? []
    list.push(reference)
    blocksByDocument.set(reference.from.objectId, list)
  }

  for (const object of objects) {
    const data = object.data as {
      registerMovements?: MetadataRef[]
      posting?: { movements: MovementDecl[] }
    }
    const blocks = blocksByDocument.get(object.id ?? "") ?? []
    const declaredIds = new Set<string>()

    ;(data.registerMovements ?? []).forEach((ref, index) => {
      const register = byKey.get(objectKey(ref.kind, ref.name))
      // Неіснуючий, не регістр чи незалежний регістр — це вже помилка стадій
      // 2 і 4; вимагати від нього джерело рухів — друга діагностика на одну причину.
      if (
        register === undefined ||
        registerTargetError(register) !== undefined
      ) {
        return
      }
      if (register.id !== undefined) declaredIds.add(register.id)

      const constructorCount = (data.posting?.movements ?? []).filter(
        (m) =>
          objectKey(m.register.kind, m.register.name) ===
          objectKey(ref.kind, ref.name)
      ).length
      const blockCount = blocks.filter((b) => b.to.id === register.id).length
      const pointer = toPointer(["registerMovements", index])
      if (constructorCount + blockCount === 0) {
        found.push(
          diagnostic("posting.source-missing", object.file, pointer, {
            name: register.name,
          })
        )
      } else if (blockCount > 1 || (blockCount === 1 && constructorCount > 0)) {
        found.push(
          diagnostic("posting.source-ambiguous", object.file, pointer, {
            name: register.name,
            sources:
              constructorCount > 0
                ? "constructor movements and a query block"
                : "several query blocks",
          })
        )
      }
    })

    for (const block of blocks) {
      if (declaredIds.has(block.to.id)) continue
      const target = objects.find((o) => o.id === block.to.id)
      found.push(
        diagnostic(
          "posting.register-undeclared",
          block.from.file,
          block.from.pointer,
          {
            name: target?.name ?? "",
            line: block.line ?? 0,
          }
        )
      )
    }
  }
  return found
}
