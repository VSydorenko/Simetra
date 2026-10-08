import {
  KIND_REGISTRY,
  MEMBERSHIP_SET_FUNCTION,
  type MetadataRef,
  type MovementDecl,
  type Project,
} from "simetra/model"
import type { Node } from "libpg-query"
import { diagnostic, toPointer, type Diagnostic } from "../diagnostics"
import { closedShellProblem } from "../sql/closed-forms"
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
    ...checkSetFunctions(objects, project, units, parse),
    ...checkSubscriptionHandlers(objects, project, units),
    ...checkPolicyCurrentUser(units),
  ]
}

/** Ім'я функції поточного користувача в дереві розбору (С9). */
const CURRENT_USER_FUNCTION = ["simetra", "current_user_id"] as const

/**
 * Поточний користувач у `USING` і `WITH CHECK` дослівної політики — лише
 * некорельований підзапит `(select simetra.current_user_id())` (С9): голий
 * виклик рахується на кожен рядок, бо `SECURITY DEFINER` не інлайниться, а
 * підзапит без жодної іншої частини стає init plan і рахується раз на запит.
 * Лінтер провайдера цієї функції не знає, тож перевіряє платформа. Ім'я
 * порівнюється з деревом розбору: парсер уже звів неквотовані імена до
 * нижнього регістру, тож `SIMETRA.Current_User_Id()` і
 * `"simetra"."current_user_id"()` — той самий виклик, а `"Simetra"` — інша
 * схема. Лише одиниці з файлів: згенерованих політик ще немає (П3), а
 * генератор писатиме обгортку сам.
 */
function checkPolicyCurrentUser(units: readonly VerbatimUnit[]): Diagnostic[] {
  const found: Diagnostic[] = []
  for (const unit of units) {
    if (unit.class !== "policy") continue
    const policy = (unit.tree as { CreatePolicyStmt?: Record<string, unknown> })
      .CreatePolicyStmt
    if (policy === undefined) continue
    for (const [key, clause] of [
      ["qual", "USING"],
      ["with_check", "WITH CHECK"],
    ] as const) {
      if (hasBareCurrentUser(policy[key], new Set())) {
        found.push(
          diagnostic("sql.bare-current-user", unit.file, "", {
            policy: unit.identity,
            clause,
            line: unit.line,
          })
        )
      }
    }
  }
  return found
}

function isCurrentUserCall(node: unknown): boolean {
  const call = (node as { FuncCall?: { funcname?: unknown[] } } | null)
    ?.FuncCall
  const names = (call?.funcname ?? []).map(
    (n) => (n as { String?: { sval?: string } }).String?.sval
  )
  return (
    names.length === CURRENT_USER_FUNCTION.length &&
    names.every((name, i) => name === CURRENT_USER_FUNCTION[i])
  )
}

/**
 * Виклик у дозволеній обгортці: `EXPR_SUBLINK`, чий `SelectStmt` має лише
 * одну ціль без псевдоніма — сам виклик. Будь-яка інша частина (`FROM`,
 * `WHERE`, `LIMIT`, `UNION`…) робить підзапит іншим, ніж форма С9.
 */
function wrappedCall(node: Record<string, unknown>): unknown {
  const sublink = node.SubLink as
    { subLinkType?: string; subselect?: { SelectStmt?: object } } | undefined
  if (sublink?.subLinkType !== "EXPR_SUBLINK") return undefined
  const select = sublink.subselect?.SelectStmt as
    Record<string, unknown> | undefined
  if (select === undefined) return undefined
  const { targetList, limitOption, op, ...rest } = select
  if (
    Object.keys(rest).length > 0 ||
    limitOption !== "LIMIT_OPTION_DEFAULT" ||
    op !== "SETOP_NONE" ||
    !Array.isArray(targetList) ||
    targetList.length !== 1
  ) {
    return undefined
  }
  const target = (targetList[0] as { ResTarget?: Record<string, unknown> })
    .ResTarget
  // Позиція — не частина форми; псевдонім (`name`) чи індексація — вже інша.
  if (
    target === undefined ||
    Object.keys(target).some((k) => k !== "val" && k !== "location")
  ) {
    return undefined
  }
  return isCurrentUserCall(target.val) ? target.val : undefined
}

/**
 * Чи є в дереві виклик поточного користувача поза обгорткою. Обгорнутий
 * виклик запам'ятовується за вузлом, а обхід іде далі: аргументи й решта
 * дерева перевіряються так само.
 */
function hasBareCurrentUser(value: unknown, wrapped: Set<unknown>): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => hasBareCurrentUser(item, wrapped))
  }
  if (typeof value !== "object" || value === null) return false
  if (isCurrentUserCall(value) && !wrapped.has(value)) return true
  const node = value as Record<string, unknown>
  const call = wrappedCall(node)
  if (call !== undefined) wrapped.add(call)
  return Object.values(node).some((child) => hasBareCurrentUser(child, wrapped))
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
 * Функція множини скоупу має бути в SQL-одиницях проєкту: як застосунок
 * визначає доступні значення, знає лише він. Підпис перевіряється за деревом
 * розбору, а не за текстом. Виняток — `setFunction: "membership"`: функцію
 * генерує компілятор з довідника членства виду, тож перевіряється лише
 * наявність такого довідника.
 */
function checkSetFunctions(
  objects: readonly ParsedObject[],
  project: Project,
  units: readonly VerbatimUnit[],
  parse: SqlParser
): Diagnostic[] {
  const found: Diagnostic[] = []
  project.scopeKinds.forEach((kind, index) => {
    const pointer = toPointer(["scopeKinds", index, "setFunction"])
    const declared = kind.setFunction
    if (declared === MEMBERSHIP_SET_FUNCTION) {
      const catalog = objects.some((object) => {
        const { membership, scope } = object.data as {
          membership?: unknown
          scope?: string
        }
        return membership !== undefined && scope === kind.name
      })
      if (!catalog) {
        found.push(
          diagnostic("scope.membership-missing", "project.meta.json", pointer, {
            kind: kind.name,
          })
        )
      }
      return
    }
    const schema = declared.schema ?? project.defaultSchema
    const name = declared.name
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
    const reason =
      problem !== undefined || typeof fn === "string"
        ? undefined
        : setFunctionClosedProblem(fn, units, schema, name, parse)
    if (reason !== undefined) {
      found.push(
        diagnostic(
          "scope.set-function-signature",
          "project.meta.json",
          pointer,
          { function: `${schema}.${name}`, reason }
        )
      )
    } else if (problem !== undefined) {
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
    DefElem?: {
      defname?: string
      arg?: {
        String?: { sval?: string }
        Boolean?: { boolval?: boolean }
        List?: { items?: { String?: { sval?: string } }[] }
      }
    }
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

/** Чим функція множини виходить за закриту форму (`params.reason`). */
export type SetFunctionReason =
  "language" | "security" | "searchPath" | "unqualified"

/**
 * Функція множини — `LANGUAGE sql SECURITY DEFINER SET search_path = ''` із
 * відношеннями, кваліфікованими схемою: RLS-політики викликають її над
 * таблицями з RLS, тож виклик від імені користувача зациклив би політику, а
 * порожній search_path не лишає простору для підміни імен. Оболонку
 * `search_path` читає спільний `closedShellProblem`, щоб не дублювати його.
 * Тіло, яке не розбирається, не перевіряється: його відхилить тіньова база.
 */
function setFunctionClosedProblem(
  fn: FunctionNode,
  units: readonly VerbatimUnit[],
  schema: string,
  name: string,
  parse: SqlParser
): SetFunctionReason | undefined {
  const option = (key: string) =>
    (fn.options ?? []).map((o) => o.DefElem).filter((o) => o?.defname === key)
  const language = option("language")[0]?.arg?.String?.sval?.toLowerCase()
  if (language !== "sql") return "language"
  if (option("security")[0]?.arg?.Boolean?.boolval !== true) return "security"
  const tree = units.find(
    (u) => u.identity === functionIdentity(schema, name, [])
  )?.tree
  if (tree !== undefined && closedShellProblem(tree as Node) === "searchPath") {
    return "searchPath"
  }
  // `AS` — список рядків; для `LANGUAGE sql` перший і є тілом.
  const body = option("as")[0]?.arg?.List?.items?.[0]?.String?.sval
  if (body === undefined) return undefined
  const parsed = parse(body)
  if (!parsed.ok) return undefined
  return hasUnqualifiedRelation(
    parsed.statements.map((s) => s.stmt),
    new Set()
  )
    ? "unqualified"
    : undefined
}

/**
 * Некваліфіковане відношення в дереві: `RangeVar` без схеми, ім'я якого не CTE
 * в області видимості. Виклики функцій (`auth.uid()`) — не `RangeVar`.
 */
function hasUnqualifiedRelation(
  value: unknown,
  ctes: ReadonlySet<string>
): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => hasUnqualifiedRelation(item, ctes))
  }
  if (typeof value !== "object" || value === null) return false
  const node = value as Record<string, unknown>
  const clause = node.withClause as
    { ctes?: { CommonTableExpr?: { ctename?: string } }[] } | undefined
  const visible =
    clause === undefined
      ? ctes
      : new Set([
          ...ctes,
          ...(clause.ctes ?? []).flatMap((c) =>
            c.CommonTableExpr?.ctename === undefined
              ? []
              : [c.CommonTableExpr.ctename]
          ),
        ])
  if (
    typeof node.relname === "string" &&
    node.schemaname === undefined &&
    !visible.has(node.relname)
  ) {
    return true
  }
  return Object.values(node).some((child) =>
    hasUnqualifiedRelation(child, visible)
  )
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
 * Обробник підписки — функція без аргументів з `RETURNS trigger` у закритій
 * оболонці (спека промоції §9.3–§9.4) будь-де в `.sql` проєкту; тригер на неї
 * генерує П3. Як і функція множини, підпис читається з дерева розбору, а не з
 * тексту.
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
    } else {
      // Обробник не буває боргом (спека промоції §9.4): оболонка перевіряється
      // тут, хоч би де лежав файл, — у спільному `sql/` теж.
      const tree = units.find(
        (u) => u.identity === functionIdentity(schema, name, [])
      )?.tree
      const problem =
        tree === undefined ? undefined : closedShellProblem(tree as Node)
      if (problem !== undefined) {
        found.push(
          diagnostic(
            "subscription.handler-not-closed",
            object.file,
            "/handler",
            { function: fn, problem }
          )
        )
      }
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
