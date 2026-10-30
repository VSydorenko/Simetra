import {
  KIND_REGISTRY,
  MEMBERSHIP_SET_FUNCTION,
  standardLogicalName,
  type MetadataRef,
  type MovementDecl,
  type PhysicalSnapshot,
  type Project,
  type SubscriptionSpec,
} from "simetra/model"
import type { Node } from "libpg-query"
import { derivedFunctions } from "../contracts"
import { diagnostic, toPointer, type Diagnostic } from "../diagnostics"
import { movementWrapperName } from "../movement-functions"
import { CURRENT_USER_FUNCTION } from "../platform/names"
import { closedShellProblem } from "../sql/closed-forms"
import { checkDefinerReads } from "../sql/definer-reads"
import { checkGeneratedCalls } from "../sql/function-body"
import { checkDimensionFunctions } from "../rights/dimension-functions"
import {
  nullaryFunction,
  setFunctionClosedProblem,
  volatilityProblem,
} from "../sql/function-shape"
import {
  blockHeadKey,
  checkDomainChecks,
  checkHeads,
  headFunctionIdentities,
  headScope,
} from "../sql/heads"
import type { SqlParser } from "../sql/parse"
import { nonContentStandardNames } from "../mechanics-units"
import type { PlpgsqlFunction, PlpgsqlParser } from "../sql/plpgsql"
import { sideEffectOf } from "../sql/query-shape"
import { plpgsqlExpressionTrees } from "../sql/rewrite/plpgsql-body"
import { functionIdentity, type VerbatimUnit } from "../sql/units"
import { objectKey, type ParsedObject } from "./files"
import { registerTargetError, type ResolvedReference } from "./identity"

/**
 * Стадія 5 (спека П2 §8.2): зв'язки між частинами моделі, які не видно в
 * одному файлі: повнота й вигляд джерел рухів, функцій множини скоупів і
 * функцій значень вимірів доступу в SQL-одиницях, судження голів дозвільним
 * переліком (Р2c1-17), виклики згенерованих функцій, що пишуть, і читання
 * таблиць під RLS від імені власника.
 */
export function checkLinks(
  objects: readonly ParsedObject[],
  references: readonly ResolvedReference[],
  project: Project,
  physical: PhysicalSnapshot,
  units: readonly VerbatimUnit[],
  parse: SqlParser,
  plpgsql: PlpgsqlParser,
  membershipFunctions: ReadonlySet<string>,
  rightsTables: ReadonlySet<string>
): Diagnostic[] {
  const scope = headScope(
    objects,
    references,
    project,
    physical,
    units,
    membershipFunctions,
    parse,
    plpgsql
  )
  // Голова з діагностикою оболонки не судиться далі: друга діагностика на
  // одну причину була б шумом.
  const skip = new Set<string>()
  const heads = headFunctionIdentities(objects, project, units)
  const shells = [
    ...checkMovementSources(objects, references),
    ...checkMovementQueries(objects, parse, skip),
    ...checkSetFunctions(objects, project, units, plpgsql, skip),
    ...checkSubscriptionHandlers(
      objects,
      project,
      physical,
      units,
      parse,
      plpgsql,
      skip
    ),
    ...checkDimensionFunctions(
      project,
      units,
      rightsTables,
      scope,
      plpgsql,
      skip
    ),
  ]
  return [
    ...shells,
    ...checkPolicyCurrentUser(units),
    ...checkHeads(objects, project, units, scope, skip),
    ...checkDomainChecks(units, scope),
    // У голові такий виклик — уже `call` судді голів: одна діагностика.
    ...checkGeneratedCalls(
      units.filter((u) => !heads.has(u.identity)),
      writingGenerated(objects, references, project, physical),
      parse,
      plpgsql
    ),
    ...checkDefinerReads(objects, project, physical, units, parse, plpgsql),
  ]
}

/**
 * `схема.ім'я` згенерованих функцій схем застосунку, що не лише читають
 * (Р2c1-38): оболонка проведення, перерахунок підсумків, обгортки рухів,
 * функції носіїв і ефектів. Функція членства лише читає; недійсне членство
 * не генерується, а його помилку вже названо.
 */
function writingGenerated(
  objects: readonly ParsedObject[],
  references: readonly ResolvedReference[],
  project: Project,
  physical: PhysicalSnapshot
): ReadonlySet<string> {
  return new Set(
    derivedFunctions(
      objects,
      references,
      physical,
      movementWrapperName,
      project.scopeKinds
    )
      .filter((fn) => fn.reads !== true && fn.membership !== true)
      .map((fn) => `${fn.schema}.${fn.name}`)
  )
}

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
    names.length === 2 &&
    names[0] === CURRENT_USER_FUNCTION.schema &&
    names[1] === CURRENT_USER_FUNCTION.name
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
 * виклик запам'ятовується за вузлом, а обхід іде далі: решта дерева
 * перевіряється так само. Аргументів у виклику немає — функція їх не бере,
 * тож у коректному SQL перевіряти нічого.
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
  parse: SqlParser,
  skip: Set<string>
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
      if (effect !== undefined || stmt === undefined) {
        skip.add(blockHeadKey(block))
      }
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
  plpgsql: PlpgsqlParser,
  skip: Set<string>
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
    const before = found.length
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
        : setFunctionClosedProblem(fn, units, schema, name, plpgsql)
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
    if (found.length > before) skip.add(functionIdentity(schema, name, []))
  })
  return found
}

/**
 * Обробник підписки — функція без аргументів з `RETURNS trigger` у закритій
 * оболонці (спека промоції §9.3–§9.4) будь-де в `.sql` проєкту; тригер на неї
 * генерує `compiler/subscription-units.ts`. Як і функція множини, підпис
 * читається з дерева розбору, а не з тексту.
 */
function checkSubscriptionHandlers(
  objects: readonly ParsedObject[],
  project: Project,
  physical: PhysicalSnapshot,
  units: readonly VerbatimUnit[],
  parse: SqlParser,
  plpgsql: PlpgsqlParser,
  skip: Set<string>
): Diagnostic[] {
  const found: Diagnostic[] = []
  for (const object of objects) {
    const spec = KIND_REGISTRY[object.kind].subscription?.(object.data)
    if (spec === undefined) continue
    const schema = spec.handler.schema ?? project.defaultSchema
    const { name } = spec.handler
    const fn = `${schema}.${name}`
    const identity = functionIdentity(schema, name, [])
    const handler = nullaryFunction(units, schema, name, {
      type: "trigger",
      setof: false,
    })
    if (handler === undefined) {
      skip.add(identity)
      found.push(
        diagnostic("subscription.handler-missing", object.file, "/handler", {
          function: fn,
        })
      )
    } else if (typeof handler === "string") {
      skip.add(identity)
      found.push(
        diagnostic("subscription.handler-signature", object.file, "/handler", {
          function: fn,
          problem: handler,
        })
      )
    } else {
      // Обробник не буває боргом (спека промоції §9.4): оболонка перевіряється
      // тут, хоч би де лежав файл, — у спільному `sql/` теж.
      const unit = units.find((u) => u.identity === identity)
      const problem =
        unit === undefined
          ? undefined
          : closedShellProblem(
              { tree: unit.tree as Node, sql: unit.sql },
              plpgsql
            )
      if (problem !== undefined) {
        skip.add(identity)
        found.push(
          diagnostic(
            "subscription.handler-not-closed",
            object.file,
            "/handler",
            { function: fn, problem }
          )
        )
      } else if (unit !== undefined) {
        const mechanics = beforeWriteMechanics(spec, objects, project)
        const carriers = beforeWriteCarriers(spec, objects, physical)
        // Рядок таблиці провайдера тригери платформи переносять у
        // «Користувачі» (Р2c1-39), тож `RETURN OLD` чи копія запису змінили б
        // таблицю виду повз команду й без механіки в джерела.
        const provider =
          spec.event === "beforeWrite" &&
          spec.sources.some((source) => "providerTable" in source)
        const parsed =
          mechanics.size === 0 && carriers.copies.size === 0 && !provider
            ? undefined
            : plpgsql(unit.sql)
        if (parsed?.ok === true && parsed.fn !== undefined) {
          const forbidden = new Set([...mechanics, ...carriers.assigned])
          for (const { problem, column } of assignmentProblems(
            parsed.fn,
            forbidden,
            parse
          )) {
            found.push(
              column !== undefined && carriers.assigned.has(column)
                ? diagnostic(
                    "subscription.handler-assigns-carrier",
                    object.file,
                    "/handler",
                    { column }
                  )
                : diagnostic(
                    "subscription.handler-assigns-mechanics",
                    object.file,
                    "/handler",
                    { function: fn, problem }
                  )
            )
          }
          for (const column of copyReads(parsed.fn, carriers.copies, parse)) {
            found.push(
              diagnostic(
                "subscription.handler-reads-carrier",
                object.file,
                "/handler",
                { column }
              )
            )
          }
        }
      }
    }
  }
  return found
}

/**
 * Фізичні імена колонок механіки джерел підписки `beforeWrite` (спека промоції
 * §9.3); порожньо для іншої події. Результат `AFTER`-обробника Postgres
 * ігнорує, а `beforeDelete` не має `NEW`, тож зламати механіку може лише
 * `beforeWrite`. Колонки — з реєстру виду, як і в самої механіки: таблиця
 * провайдера й `CustomTable` їх не мають, хоч би як звалися їхні колонки.
 */
function beforeWriteMechanics(
  spec: SubscriptionSpec,
  objects: readonly ParsedObject[],
  project: Project
): ReadonlySet<string> {
  if (spec.event !== "beforeWrite") return new Set()
  const style = project.naming.attributeCase
  // Авторство — механіка (Р-A1-9): під командою його примушує тригер
  // авторства, тож присвоєння в обробнику або губилося б, або підмінило б
  // автора поза командою.
  const standard = nonContentStandardNames(style)
  const names = new Set<string>()
  for (const source of spec.sources) {
    if (!("ref" in source)) continue
    const target = objects.find(
      (o) =>
        objectKey(o.kind, o.name) ===
        objectKey(source.ref.kind, source.ref.name)
    )
    if (target === undefined) continue
    for (const def of KIND_REGISTRY[target.kind].standardColumns(target.data)) {
      if (standard.has(standardLogicalName(def, style))) {
        names.add(def.physicalName.toLowerCase())
      }
    }
  }
  return names
}

/**
 * Колонки носіїв прав на основних таблицях джерел підписки `beforeWrite`
 * (спека прав §5.2, Р2a2-9): `copies` — копії носіїв, `assigned` — копії й
 * колонки першого кроку шляху, з яких тригер носіїв їх виводить. Порядок
 * `BEFORE`-тригерів задають імена, тож обробник, що спрацював після тригера
 * носіїв, присвоєнням копії чи кроку розійшовся б із джерелом, а копії в
 * `NEW` до тригера носіїв на `INSERT` — значення запиту, а не виведені.
 * Підписок на таблицях ТЧ не буває, тож лише основна таблиця; `AFTER` не
 * змінює рядка, і його не обмежує й текст спеки.
 */
function beforeWriteCarriers(
  spec: SubscriptionSpec,
  objects: readonly ParsedObject[],
  physical: PhysicalSnapshot
): { copies: ReadonlySet<string>; assigned: ReadonlySet<string> } {
  const copies = new Set<string>()
  const assigned = new Set<string>()
  if (spec.event !== "beforeWrite") return { copies, assigned }
  for (const source of spec.sources) {
    if (!("ref" in source)) continue
    const target = objects.find(
      (o) =>
        objectKey(o.kind, o.name) ===
        objectKey(source.ref.kind, source.ref.name)
    )
    const table = physical.tables.find(
      (t) =>
        target?.id !== undefined &&
        t.origin.objectId === target.id &&
        t.origin.tabularSectionId === undefined &&
        t.origin.part === undefined
    )
    for (const column of table?.columns ?? []) {
      const copyOf = column.origin.copyOf
      if (copyOf === undefined) continue
      copies.add(column.name.toLowerCase())
      assigned.add(column.name.toLowerCase())
      assigned.add(copyOf.through.toLowerCase())
    }
  }
  return { copies, assigned }
}

/**
 * Пряме читання копії `NEW.<копія>` у будь-якому виразі обробника (Р2a2-9).
 * Запис цілком (`to_jsonb(NEW)`, `NEW.*`, `NEW` аргументом) — звичайний
 * патерн журналу, тож дозволений. Ціль присвоєння — не читання: її судить
 * перевірка присвоєнь. Динамічний SQL сюди не доходить: його відкидає
 * закрита оболонка. Нерозбірний вираз — теж: розбір тіла оболонки вже
 * пройшов.
 */
function copyReads(
  fn: PlpgsqlFunction,
  copies: ReadonlySet<string>,
  parse: SqlParser
): string[] {
  if (copies.size === 0) return []
  const read = new Set<string>()
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    if (typeof value !== "object" || value === null) return
    const node = value as Record<string, unknown>
    const ref = node.ColumnRef as
      { fields?: { String?: { sval?: string } }[] } | undefined
    const fields = (ref?.fields ?? []).map((f) => f.String?.sval?.toLowerCase())
    const [record, column] = fields
    if (
      fields.length === 2 &&
      record === "new" &&
      column !== undefined &&
      copies.has(column)
    ) {
      read.add(column)
    }
    for (const inner of Object.values(node)) visit(inner)
  }
  for (const tree of plpgsqlExpressionTrees(fn, parse)) visit(tree)
  return [...read]
}

/**
 * Чим обробник ламає механіку чи носії: запис у `NEW` цілком (`NEW :=`,
 * `SELECT … INTO NEW`) чи в заборонену колонку (`column`), або `RETURN` не
 * `NEW` і не `NULL`. Рядок, що
 * його повертає пізніший `BEFORE`-тригер, і є рядком для запису, тож `RETURN
 * OLD` чи копія запису затерли б версію й дату, які поставила механіка.
 *
 * Спосіб зібрати `NEW`, якого дерево не показує, — відмова, а не пропуск:
 * змінна чи псевдонім з ім'ям `new` затіняє запис тригера (тоді `RETURN new`
 * повертає інше), а `CALL` з `NEW` аргументом пише в нього через `INOUT`
 * без цілі в дереві.
 */
function assignmentProblems(
  fn: PlpgsqlFunction,
  forbidden: ReadonlySet<string>,
  parse: SqlParser
): { problem: string; column?: string }[] {
  const problems: { problem: string; column?: string }[] = []
  // Запис тригера `new` є в списку змінних завжди; другий — уже затінення.
  const shadows =
    fn.variables.filter((v) => v.name.toLowerCase() === "new").length -
    1 +
    fn.aliases.filter((a) => a.toLowerCase() === "new").length
  if (shadows > 0) problems.push({ problem: "declares a variable named NEW" })
  for (const statement of fn.statements) {
    if (statement.type === "declare") continue
    for (const name of statement.target?.variable.split(", ") ?? []) {
      const [record, column, ...rest] = name.toLowerCase().split(".")
      if (
        record === "new" &&
        rest.length === 0 &&
        (column === undefined || forbidden.has(column))
      ) {
        problems.push({
          problem: name.toLowerCase(),
          ...(column === undefined ? {} : { column }),
        })
      }
    }
    if (statement.type === "call") {
      for (const e of statement.expressions) {
        const passed = callPassesNew(e.query, forbidden, fn.aliases, parse)
        if (passed !== undefined) problems.push({ problem: e.query, ...passed })
      }
    }
    if (statement.type !== "return") continue
    const { returns } = statement
    const allowed =
      returns !== undefined &&
      ("null" in returns || returns.variable.toLowerCase() === "new")
    // `RETURN;` без виразу не повертає ні запису, ні копії.
    if (!allowed && statement.expressions.length > 0) {
      problems.push({
        problem: `RETURN ${statement.expressions.map((e) => e.query).join(" ")}`,
      })
    }
  }
  return problems
}

/**
 * Чи може обробник `beforeWrite` змінити колонки `columns` рядка (Р-A2-17):
 * той самий аналіз присвоєнь, що й діагностика механіки, з будь-якою
 * проблемою як «присвоює» — `NEW :=` чи `RETURN` іншого запису теж підміняють
 * колонку. Нерозбірне тіло — теж «присвоює» (fail-closed): ядро тоді бере
 * замок ієрархії завжди, а не пропускає гонку. `sql` — `CREATE FUNCTION`
 * обробника, `columns` — фізичні імена в нижньому регістрі.
 */
export function handlerAssigns(
  sql: string,
  columns: ReadonlySet<string>,
  parse: SqlParser,
  plpgsql: PlpgsqlParser
): boolean {
  const parsed = plpgsql(sql)
  if (!parsed.ok || parsed.fn === undefined) return true
  return assignmentProblems(parsed.fn, columns, parse).length > 0
}

/**
 * `CALL` згадує `NEW` чи псевдонім будь-де в аргументах. Параметр `INOUT` пише
 * в аргумент-змінну без цілі в дереві, а дістатися `NEW` можна й через
 * псевдонім (`r.version`), і через мітку функції (`f.new.version`): ціль
 * псевдоніма дерево не зберігає, тож підозрілий кожен. Дозволено лише пряме
 * `new.<незаборонена колонка>`; пряма заборонена дає свою `column`. Вкладене
 * теж рахується — суворіше, зате без розбору сигнатури процедури;
 * нерозбірний текст — теж відмова. `undefined` — виклик нічого не пише.
 */
function callPassesNew(
  query: string,
  forbidden: ReadonlySet<string>,
  aliases: readonly string[],
  parse: SqlParser
): { column?: string } | undefined {
  const parsed = parse(query)
  if (!parsed.ok) return {}
  const suspect = new Set(["new", ...aliases.map((a) => a.toLowerCase())])
  const visit = (value: unknown): { column?: string } | undefined => {
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = visit(item)
        if (found !== undefined) return found
      }
      return undefined
    }
    if (typeof value !== "object" || value === null) return undefined
    const node = value as Record<string, unknown>
    const ref = node.ColumnRef as
      { fields?: { String?: { sval?: string } }[] } | undefined
    if (ref !== undefined) {
      // `*` (`A_Star`) імені не має: `NEW.*` упізнає перше поле.
      const fields = (ref.fields ?? []).map((f) =>
        f.String?.sval === undefined ? undefined : f.String.sval.toLowerCase()
      )
      if (fields.some((f) => f !== undefined && suspect.has(f))) {
        const [record, column] = fields
        const direct =
          fields.length === 2 &&
          record === "new" &&
          column !== undefined &&
          !suspect.has(column)
        if (!direct) return {}
        if (forbidden.has(column)) return { column }
      }
    }
    return visit(Object.values(node))
  }
  return visit(parsed.statements.map((s) => s.stmt))
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
