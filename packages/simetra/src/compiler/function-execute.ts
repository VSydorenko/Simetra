import { type DatabaseProvider, type GrantPurpose } from "simetra/model"
import { compareStrings, diagnostic, type Diagnostic } from "./diagnostics"
import type { PlatformFormSource } from "./sql/closed-forms"
import {
  PLATFORM_FORM_PURPOSES,
  type DeclaredFunction,
} from "./sql/declarations"
import { executeGrants } from "./sql/execute-grants"
import type { SqlParser } from "./sql/parse"
import { functionIdentity, qualifiedName } from "./sql/identity"
import {
  functionSignatureSql,
  generatedUnit,
  grantObjects,
  typeReferenceArgument,
  type SqlUnit,
  type VerbatimUnit,
} from "./sql/units"

/** Функції, `EXECUTE` яких виводить платформа (`buildFunctionExecuteUnits`). */
export interface FunctionExecuteSources {
  /** Форми платформи (`platformFormSources`); `membership` там немає. */
  forms: readonly PlatformFormSource[]
  /** Задекларовані функції (`declaredFunctions`). */
  declared: readonly DeclaredFunction[]
  /** Дослівні одиниці: `CREATE` кожного джерела й функції модулів видів. */
  units: readonly VerbatimUnit[]
  /** Файли об'єктів видів із закритим модулем (`closedModuleOwners`). */
  moduleOwners: ReadonlySet<string>
}

/**
 * `EXECUTE` функцій, ACL яких належить платформі (платформна спека §6.7,
 * спека декларацій функцій §5.1): форм платформи — з призначень форми
 * (`PLATFORM_FORM_PURPOSES`), задекларованих — з викликачів, недекларованих
 * функцій модуля виду — з порожніх призначень: модуль не приймає дослівних
 * грантів, тож інакше функція лишилася б з `EXECUTE` від `PUBLIC` і типових
 * привілеїв провайдера. Функцію множини `membership` сюди не передають: її
 * гранти дає генератор членства. Одна функція — одна група грантів:
 * форма перемагає декларацію (її помилку `sql.declaration-platform-form`
 * названо окремо), декларація — типову групу модуля. Підпис — з типів
 * аргументів `CREATE` функції: функція модуля може мати параметри, і грант
 * без них цілив би в іншу функцію.
 */
export function buildFunctionExecuteUnits(
  sources: FunctionExecuteSources,
  provider: DatabaseProvider,
  module: string,
  parse: SqlParser
): SqlUnit[] {
  return (
    executeTargets(sources)
      // Підпис з `%type` після зміни типу колонки цілив би в іншу функцію:
      // його помилку названо `checkExecuteTypeReferences`, гранту немає.
      .filter(({ unit }) => typeReferenceArgument(unit) === undefined)
      .flatMap(({ unit, purposes }) =>
        executeGrants(functionSignatureSql(unit), purposes, provider).map(
          (sql): SqlUnit => ({
            ...generatedUnit(sql, unit.schema, parse),
            module,
            generator: "functionExecute",
          })
        )
      )
      .sort((a, b) => compareStrings(a.identity, b.identity))
  )
}

/**
 * `sql.function-argument-type-reference`: функція, `EXECUTE` якої виводить
 * платформа, з аргументом `%type` (`typeReferenceArgument`, спека декларацій
 * функцій §5.1). Без гранту функція лишилася б з `EXECUTE` від `PUBLIC`, тож
 * це помилка, а не пропуск. Форму платформи без `CREATE` не названо: її
 * помилку вже дає відсутній `CREATE`.
 */
export function checkExecuteTypeReferences(
  sources: FunctionExecuteSources
): Diagnostic[] {
  return executeTargets(sources).flatMap(({ unit }) => {
    const argument = typeReferenceArgument(unit)
    return argument === undefined || unit.file === undefined
      ? []
      : [
          diagnostic("sql.function-argument-type-reference", unit.file, "", {
            identity: unit.identity,
            line: unit.line ?? 0,
            function: qualifiedName(unit.schema, unit.name),
            argument,
          }),
        ]
  })
}

type ExecuteTarget = Pick<VerbatimUnit, "identity" | "schema" | "name"> &
  Partial<Pick<VerbatimUnit, "file" | "line" | "tree">>

/**
 * Одна функція — одна група грантів: форма перемагає декларацію, декларація —
 * типову групу модуля.
 */
function executeTargets(
  sources: FunctionExecuteSources
): { unit: ExecuteTarget; purposes: readonly GrantPurpose[] }[] {
  const { forms, declared, units, moduleOwners } = sources
  const groups = new Map<
    string,
    { unit: ExecuteTarget; purposes: readonly GrantPurpose[] }
  >()
  const add = (unit: ExecuteTarget, purposes: readonly GrantPurpose[]) => {
    if (!groups.has(unit.identity))
      groups.set(unit.identity, { unit, purposes })
  }
  for (const { function: fn, form } of forms) {
    const named = units.filter(
      (u) =>
        u.class === "function" && u.schema === fn.schema && u.name === fn.name
    )
    // Форма — функція без аргументів (стадія 5); без єдиного `CREATE` її
    // помилку названо там же, а грант цілить у цю саму функцію `()`.
    add(
      named.length === 1
        ? named[0]!
        : { ...fn, identity: functionIdentity(fn.schema, fn.name, []) },
      PLATFORM_FORM_PURPOSES[form]
    )
  }
  for (const { unit, declaration } of declared) add(unit, declaration.callers)
  for (const unit of units)
    if (
      unit.class === "function" &&
      unit.ownerFile !== undefined &&
      moduleOwners.has(unit.ownerFile)
    )
      add(unit, [])
  return [...groups.values()]
}

/**
 * Дослівний грант на об'єкт, правами якого володіє платформа (платформна спека §6.7):
 * на функцію чи таблицю, що є ціллю згенерованої одиниці `grant`.
 * Функцію звірено повною канонічною сигнатурою: грант на інше перевантаження
 * тієї самої назви — не її. `object` — лише цілі платформи: оператор на кілька
 * об'єктів, з яких платформі належить частина, `simetra fix` не вирізає
 * (`ownsWholeGrant`), бо разом із ним зник би законний грант. `flagged` —
 * одиниці з цією помилкою: тотожний згенерованому оператор інакше дістав би
 * ще й `sql.unit-duplicate`.
 */
export function generatedGrantConflicts(
  units: readonly SqlUnit[],
  parse: SqlParser
): { diagnostics: Diagnostic[]; flagged: ReadonlySet<SqlUnit> } {
  const owned = platformGrantTargets(units, parse)
  const diagnostics: Diagnostic[] = []
  const flagged = new Set<SqlUnit>()
  for (const unit of units) {
    if (unit.file === undefined || unit.class !== "grant") continue
    const objects = grantTargetKeys(unit, parse)
      .filter((target) => ownsTarget(owned, target))
      .map(targetName)
    if (objects.length === 0) continue
    flagged.add(unit)
    diagnostics.push(
      diagnostic("sql.generated-grant", unit.file, "", {
        identity: unit.identity,
        line: unit.line ?? 0,
        object: objects.join(", "),
      })
    )
  }
  return { diagnostics, flagged }
}

/**
 * Об'єкти, ACL яких належить платформі (платформна спека §6.7). Ключ —
 * `function|<сигнатура>` чи `table|<схема.ім'я>`: `grantTargetKeys`.
 * Функція — ціль будь-якої згенерованої одиниці `grant` (`functionExecute`,
 * членство, платформний шар); таблиця — лише таблиця з контрактом доступу,
 * тобто ціль грантів генератора `access`.
 */
export function platformGrantTargets(
  units: readonly Pick<
    SqlUnit,
    "class" | "name" | "sql" | "file" | "generator"
  >[],
  parse: SqlParser
): Set<string> {
  return new Set(
    units
      .filter((unit) => unit.file === undefined && unit.class === "grant")
      .flatMap((unit) =>
        grantTargetKeys(unit, parse).filter(
          (key) => key.startsWith("function|") || unit.generator === "access"
        )
      )
  )
}

/**
 * Чи ціль гранту — об'єкт платформи. `ON FUNCTION f` без списку аргументів
 * Postgres резолвить у єдину функцію з цим ім'ям, тож вона збігається з
 * функцією платформи тієї самої схеми й імені.
 */
export function ownsTarget(
  owned: ReadonlySet<string>,
  target: string
): boolean {
  if (owned.has(target)) return true
  if (!target.startsWith("function|") || target.endsWith(")")) return false
  return [...owned].some((o) => o.startsWith(`${target}(`))
}

const TARGET_KINDS: Readonly<Record<string, "function" | "table">> = {
  OBJECT_FUNCTION: "function",
  OBJECT_PROCEDURE: "function",
  OBJECT_ROUTINE: "function",
  OBJECT_TABLE: "table",
}

/**
 * Цілі гранту-функції чи гранту-таблиці; ціль іншого виду (схема, тип,
 * послідовність) платформі в цьому правилі не належить, тож ключа не має.
 */
export function grantTargetKeys(
  unit: Pick<SqlUnit, "class" | "name" | "sql">,
  parse: SqlParser
): string[] {
  if (unit.class !== "grant") return []
  const parsed = parse(unit.sql)
  const stmt = parsed.ok ? parsed.statements[0]?.stmt : undefined
  if (stmt === undefined || !("GrantStmt" in stmt)) return []
  const kind = TARGET_KINDS[stmt.GrantStmt.objtype ?? ""]
  if (kind === undefined) return []
  return grantObjects(unit.name).map((name) => `${kind}|${name}`)
}

const targetName = (target: string) => target.slice(target.indexOf("|") + 1)

/**
 * Чи `object` діагностики `sql.generated-grant` охоплює всі цілі гранту з
 * ім'ям одиниці `unitName`: лише такий оператор цілком суперечить платформі,
 * і його можна вирізати без втрати чужого гранту. Обидва списки будує один
 * `grantObjects` в одному порядку, тож досить порівняти їх як рядки.
 */
export function ownsWholeGrant(object: unknown, unitName: string): boolean {
  return object === grantObjects(unitName).join(", ")
}
