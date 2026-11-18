import {
  KIND_REGISTRY,
  type GrantPurpose,
  type Project,
  type SqlFunctionDeclaration,
} from "simetra/model"
import { diagnostic, type Diagnostic, type RuleCode } from "../diagnostics"
import type { ParsedFunctionsFile, ParsedObject } from "../stages/files"
import { FUNCTION_CLASSES, functionIdentity, type VerbatimUnit } from "./units"

/**
 * Функція, яку називає декларація: пара `(schema, name)` після підстановки
 * `defaultSchema`. Пара, а не зклеєний `схема.ім'я`: ідентифікатори в лапках
 * можуть містити крапку, і `"a.b".c` та `a."b.c"` — різні функції (Р7).
 */
export interface DeclaredFunctionKey {
  schema: string
  name: string
}

/** Декларація, що резолвилась в одну дослівну одиницю `CREATE FUNCTION`. */
export interface DeclaredFunction {
  declaration: SqlFunctionDeclaration
  /** Файл `.functions.json`. */
  file: string
  /** JSON-pointer запису у файлі. */
  pointer: string
  /** Дослівна одиниця `CREATE FUNCTION` сусіднього `.sql`. */
  unit: VerbatimUnit
  key: DeclaredFunctionKey
}

interface DeclarationEntry {
  declaration: SqlFunctionDeclaration
  file: string
  sqlFile: string
  pointer: string
  key: DeclaredFunctionKey
}

const sameKey = (
  unit: Pick<VerbatimUnit, "schema" | "name">,
  key: DeclaredFunctionKey
) => unit.schema === key.schema && unit.name === key.name

/** Рядок для мапи, що не зливає пари з крапкою в ідентифікаторі. */
const tupleKey = (key: DeclaredFunctionKey) =>
  JSON.stringify([key.schema, key.name])

function entriesOf(
  functionsFiles: readonly ParsedFunctionsFile[],
  defaultSchema: string
): DeclarationEntry[] {
  return functionsFiles.flatMap((file) =>
    file.functions.map((declaration, index) => ({
      declaration,
      file: file.file,
      sqlFile: file.sqlFile,
      pointer: `/functions/${index}`,
      key: {
        schema: declaration.function.schema ?? defaultSchema,
        name: declaration.function.name,
      },
    }))
  )
}

/** Одиниці простору імен функцій Postgres (`pg_proc`) з цією парою. */
function sameNamed(
  key: DeclaredFunctionKey,
  units: readonly VerbatimUnit[]
): VerbatimUnit[] {
  return units.filter((u) => FUNCTION_CLASSES.has(u.class) && sameKey(u, key))
}

/**
 * Єдина одиниця, яку називає декларація: `CREATE FUNCTION` сусіднього `.sql`
 * без інших одиниць з тією самою парою в просторі `pg_proc` (функцій,
 * процедур, агрегатів у будь-якому файлі). Інакше `undefined`: декларація
 * розрізняє функцію лише ім'ям, тож перевантаження її не резолвить.
 */
function resolve(
  entry: DeclarationEntry,
  units: readonly VerbatimUnit[]
): VerbatimUnit | undefined {
  const named = sameNamed(entry.key, units)
  const [only] = named
  return named.length === 1 &&
    only!.class === "function" &&
    only!.file === entry.sqlFile
    ? only
    : undefined
}

/**
 * Декларації, що резолвились у функцію сусіднього `.sql` (спека декларацій
 * функцій §5.1). Нерезолвлена декларація сюди не входить: її причину називає
 * `checkDeclarations`.
 */
export function declaredFunctions(
  functionsFiles: readonly ParsedFunctionsFile[],
  units: readonly VerbatimUnit[],
  defaultSchema: string
): DeclaredFunction[] {
  return entriesOf(functionsFiles, defaultSchema).flatMap((entry) => {
    const unit = resolve(entry, units)
    return unit === undefined
      ? []
      : [
          {
            declaration: entry.declaration,
            file: entry.file,
            pointer: entry.pointer,
            unit,
            key: entry.key,
          },
        ]
  })
}

/** Форма платформи: функція, призначення якої задають метадані. */
export type PlatformForm = "setFunction" | "subscriptionHandler" | "dimension"

/**
 * Призначення `EXECUTE` кожної форми платформи: їх виводить генератор
 * (`buildFunctionExecuteUnits`), а перехід декларації у форму (Р12) порівнює
 * з ними викликачів. Функцію множини кличе політика від імені запиту (ролі
 * користувача, сервісна й команд); обробник — тригер, функцію значень виміру
 * — тіло `rights_dimension_values*` від власника, тож обом не потрібна жодна
 * роль API.
 */
export const PLATFORM_FORM_PURPOSES: Readonly<
  Record<PlatformForm, readonly GrantPurpose[]>
> = {
  setFunction: ["user", "service", "command"],
  subscriptionHandler: [],
  dimension: [],
}

export interface PlatformFormFunction {
  function: DeclaredFunctionKey
  form: PlatformForm
  purposes: readonly GrantPurpose[]
}

/**
 * Функції форм платформи (спека декларацій функцій §5.3): функції множини
 * видів скоупу, обробники підписок і функції значень вимірів доступу. Ключ —
 * ідентичність функції без аргументів; значення несе пару для порівняння з
 * декларацією. Одна функція в кількох формах — перша форма переліку, як у
 * генераторі. Згенерована функція множини (`membership`) — не дослівна.
 */
export function platformFormFunctions(
  objects: readonly ParsedObject[],
  project: Project | undefined
): ReadonlyMap<string, PlatformFormFunction> {
  const forms = new Map<string, PlatformFormFunction>()
  if (project === undefined) return forms
  const add = (
    fn: { schema?: string; name: string },
    form: PlatformForm
  ): void => {
    const key = { schema: fn.schema ?? project.defaultSchema, name: fn.name }
    const identity = functionIdentity(key.schema, key.name, [])
    if (forms.has(identity)) return
    forms.set(identity, {
      function: key,
      form,
      purposes: PLATFORM_FORM_PURPOSES[form],
    })
  }
  for (const kind of project.scopeKinds) {
    if (typeof kind.setFunction !== "string")
      add(kind.setFunction, "setFunction")
  }
  for (const object of objects) {
    const spec = KIND_REGISTRY[object.kind].subscription?.(object.data)
    if (spec !== undefined) add(spec.handler, "subscriptionHandler")
  }
  for (const dimension of project.accessDimensions) {
    if ("function" in dimension.values) {
      add(dimension.values.function, "dimension")
    }
  }
  return forms
}

/**
 * Правила резолву декларацій (спека декларацій функцій §5.1, §5.7): функції
 * немає в сусідньому `.sql` (`target-missing`), вона має перевантаження
 * (`overload`), її декларують два записи — в одному файлі після підстановки
 * `defaultSchema` чи в різних (`duplicate`), вона — форма платформи
 * (`platform-form`). Кожна діагностика — на запис файлу `.functions.json`.
 * `unparsed` — `.sql`, які не розібрано: їхні одиниці неповні, тож
 * відсутність цілі там не судиться.
 */
export function checkDeclarations(
  functionsFiles: readonly ParsedFunctionsFile[],
  units: readonly VerbatimUnit[],
  objects: readonly ParsedObject[],
  project: Project | undefined,
  unparsed: ReadonlySet<string>
): Diagnostic[] {
  if (project === undefined) return []
  const forms = [...platformFormFunctions(objects, project).values()]
  const seen = new Map<string, DeclarationEntry>()
  const found: Diagnostic[] = []
  for (const entry of entriesOf(functionsFiles, project.defaultSchema)) {
    const at = (code: RuleCode, extra: Record<string, string | number> = {}) =>
      found.push(
        diagnostic(code, entry.file, entry.pointer, {
          schema: entry.key.schema,
          name: entry.key.name,
          function: `${entry.key.schema}.${entry.key.name}`,
          ...extra,
        })
      )
    // Дубль судиться за парою після підстановки `defaultSchema`: записане
    // значення різне (`{ name }` і `{ schema, name }`), а функція та сама.
    const first = seen.get(tupleKey(entry.key))
    if (first === undefined) seen.set(tupleKey(entry.key), entry)
    else at("sql.declaration-duplicate", { first: first.file + first.pointer })
    const form = forms.find((f) => sameKey(f.function, entry.key))
    if (form !== undefined) {
      at("sql.declaration-platform-form", { form: form.form })
    }
    const named = sameNamed(entry.key, units)
    if (named.length > 1) {
      at("sql.declaration-overload", { count: named.length })
    } else if (
      !unparsed.has(entry.sqlFile) &&
      !named.some((u) => u.class === "function" && u.file === entry.sqlFile)
    ) {
      at("sql.declaration-target-missing", { sqlFile: entry.sqlFile })
    }
  }
  return found
}
