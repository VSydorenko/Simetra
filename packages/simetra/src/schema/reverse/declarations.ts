import {
  FUNCTIONS_SCHEMA_FILE,
  FUNCTION_CLASSES,
  callersOfRole,
  closedShellProblem,
  diagnostic,
  grantTargetKeys,
  guardArgsOf,
  identityKey,
  isSecurityDefiner,
  isTriggerFunction,
  metadataRights,
  ownsTarget,
  readSqlUnits,
  type Diagnostic,
  type IdSource,
  type Node,
  type PlpgsqlParser,
  type SchemaPathResolver,
  type SqlParser,
  type VerbatimUnit,
} from "simetra/compiler"
import {
  FUNCTIONS_FILE_SUFFIX,
  SQL_FUNCTION_CALLERS,
  formatSqlFunctionsFile,
  sqlFunctionsFileSchema,
  type CatalogUnit,
  type DatabaseProvider,
  type MetadataKind,
  type SqlFunctionCaller,
  type SqlFunctionDeclaration,
} from "simetra/model"
import type { ExecuteFacts, FunctionExecuteFact } from "./execute-facts"
import { isGeneratedPath } from "./identity"
import { explicitVolatility } from "./units"

/**
 * Декларації definer-функцій у зворотній генерації (спека декларацій функцій
 * §5.5): викликачі — з фактів каталогу бази (одиниці extract не несуть
 * типового `PUBLIC`, ADP, грантора й опції передачі), `check` — з доведеного
 * запобіжника тіла, дослівні гранти `EXECUTE` задекларованої функції не
 * пишуться.
 */

/** Пара `(schema, name)` кортежем: ім'я в лапках може містити крапку. */
export const tupleKey = (schema: string, name: string) =>
  JSON.stringify([schema, name])

/** Об'єкт теки за міткою виду: ім'я для `check.object` і дії за словом чи UUID. */
export interface KindContract {
  kind: MetadataKind
  name: string
  /** Рядок дії в запобіжнику (слово чи UUID) → ім'я дії в метаданих. */
  actions: ReadonlyMap<string, string>
}

export type KindsByLabel = ReadonlyMap<string, KindContract[]>

/** Мітки видів об'єктів скомпільованої теки — з контрактів прав. */
export function kindsByLabel(
  metadata: ReturnType<typeof metadataRights>
): KindsByLabel | undefined {
  if (metadata === undefined) return undefined
  const found = new Map<string, KindContract[]>()
  for (const contract of metadata.rights) {
    const object = metadata.objects.find((o) => o.id === contract.objectId)
    if (object === undefined) continue
    const list = found.get(contract.kindLabel) ?? []
    list.push({
      kind: object.kind,
      name: object.name,
      actions: new Map(contract.actions.map((a) => [a.action, a.name])),
    })
    found.set(contract.kindLabel, list)
  }
  return found
}

/** Записана декларація: файл, запис і куди писати `check`-діагностику. */
export interface WrittenDeclaration {
  /** `<основа>.functions.json` поруч із `.sql` функції. */
  path: string
  schema: string
  name: string
  declaration: SqlFunctionDeclaration
}

export interface DeclareInput {
  /** Одиниці каталогу після фільтра платформи. */
  units: readonly CatalogUnit[]
  facts: ExecuteFacts | undefined
  provider: DatabaseProvider
  defaultSchema: string
  parse: SqlParser
  plpgsql: PlpgsqlParser
  newId: IdSource
  schemaPath: SchemaPathResolver
  /**
   * `.sql` функції, що ляже у власний файл теки: ідентичність → шлях.
   * Функція в sidecar таблиці чи в колізії шляхів сюди не потрапляє.
   */
  functionPaths: ReadonlyMap<string, string>
  /** Ідентичності одиниць, які описує збережений файл (`describedElsewhere`). */
  described: ReadonlySet<string>
  existing: ReadonlyMap<string, string>
  /**
   * Функції форм платформи теки (`tupleKey`: функція множини, функція
   * значень виміру, обробник підписки): їхній `EXECUTE` виводять метадані, а
   * декларація на них — `sql.declaration-platform-form`.
   */
  platformForms: ReadonlySet<string>
  /**
   * Мітки видів підсумкової теки з контрактів прав її метаданих; кличеться
   * лише коли є що розв'язувати. `undefined` — метадані контрактів не дають.
   */
  kinds: () => Promise<KindsByLabel | undefined>
}

export interface FunctionDeclarations {
  /** Нові `<основа>.functions.json`: шлях → вміст. */
  files: Map<string, string>
  /** Одиниці `GRANT`/`REVOKE EXECUTE` задекларованих функцій: у теку не йдуть. */
  dropped: Set<CatalogUnit>
  diagnostics: Diagnostic[]
  written: WrittenDeclaration[]
}

const FACTED: ReadonlySet<string> = new Set(["function", "procedure"])

const joined = (list: readonly string[]) =>
  list.length === 0 ? "none" : list.join(", ")

/** Файл декларацій у канонічній формі; `$schema` — як у решти службових файлів. */
export function renderFunctionsFile(
  path: string,
  entries: readonly SqlFunctionDeclaration[],
  schemaPath: SchemaPathResolver
): string {
  return formatSqlFunctionsFile({
    $schema: schemaPath(path, FUNCTIONS_SCHEMA_FILE),
    functions: [...entries],
  })
}

interface FunctionTree {
  parameters?: unknown[]
  returnType?: { names?: { String?: { sval?: string } }[]; setof?: boolean }
}

/** Без аргументів і `RETURNS SETOF uuid`: ознака функції множини скоупу. */
function setOfUuid(unit: VerbatimUnit): boolean {
  const fn = (unit.tree as { CreateFunctionStmt?: FunctionTree })
    .CreateFunctionStmt
  const names = (fn?.returnType?.names ?? []).map((n) => n.String?.sval)
  return (
    fn !== undefined &&
    (fn.parameters ?? []).length === 0 &&
    fn.returnType?.setof === true &&
    names.at(-1) === "uuid" &&
    (names.length === 1 || (names.length === 2 && names[0] === "pg_catalog"))
  )
}

interface Derived {
  callers: SqlFunctionCaller[]
  /** Ролі без сесії, що мали дієвий `EXECUTE`, — у викликачі не йдуть. */
  anonymous: string[]
}

/**
 * Викликачі з дієвого `EXECUTE` ролей профілю (знімок): роль має `EXECUTE`
 * **і** `USAGE` на схему — інакше компілятор додав би їй `USAGE` разом з
 * виведеним грантом і розширив доступ. Роль без сесії викликачем не стає:
 * definer-функції без сесії немає.
 */
function derivedCallers(
  fact: FunctionExecuteFact,
  provider: DatabaseProvider
): Derived {
  const purposes = new Set<SqlFunctionCaller>()
  const anonymous: string[] = []
  for (const [role, executes] of Object.entries(fact.executeByRole)) {
    if (!executes || fact.schemaUsageByRole[role] !== true) continue
    for (const purpose of callersOfRole(role, provider) ?? []) {
      if (!(SQL_FUNCTION_CALLERS as readonly string[]).includes(purpose))
        continue
      if (purpose === "anonymous") anonymous.push(role)
      else purposes.add(purpose as SqlFunctionCaller)
    }
  }
  return {
    callers: SQL_FUNCTION_CALLERS.filter((p) => purposes.has(p)),
    anonymous,
  }
}

/**
 * Запис ACL, який декларація не відтворює: отримувач поза ролями профілю,
 * грантор не власник, опція передачі. Власник — сам собі, поза рахунком.
 */
function foreignGrants(
  fact: FunctionExecuteFact,
  provider: DatabaseProvider
): { role: string; reason: string }[] {
  const found: { role: string; reason: string }[] = []
  for (const entry of fact.acl) {
    if (entry.grantee === fact.owner) continue
    const reasons = [
      ...(entry.grantee !== "PUBLIC" &&
      callersOfRole(entry.grantee, provider) === undefined
        ? ["the role is not a role of the provider profile"]
        : []),
      ...(entry.grantor !== fact.owner
        ? [`granted by ${entry.grantor}, not by the owner`]
        : []),
      ...(entry.grantable ? ["with grant option"] : []),
    ]
    if (reasons.length > 0)
      found.push({ role: entry.grantee, reason: reasons.join("; ") })
  }
  return found
}

/** Декларації збереженого файлу (не згенерований шлях) — для звірки викликачів. */
function keptDeclarations(
  existing: ReadonlyMap<string, string>,
  defaultSchema: string
): Map<string, { file: string; pointer: string; callers: string[] }> {
  const found = new Map<
    string,
    { file: string; pointer: string; callers: string[] }
  >()
  for (const [path, text] of existing) {
    if (!path.endsWith(FUNCTIONS_FILE_SUFFIX) || isGeneratedPath(path)) continue
    const file = parseFile(text)
    file?.functions.forEach((declaration, index) =>
      found.set(
        tupleKey(
          declaration.function.schema ?? defaultSchema,
          declaration.function.name
        ),
        {
          file: path,
          pointer: `/functions/${index}`,
          callers: declaration.callers,
        }
      )
    )
  }
  return found
}

function parseFile(text: string) {
  try {
    const parsed = sqlFunctionsFileSchema.safeParse(JSON.parse(text))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

/** `id` наявних згенерованих записів: повторний прийом його не міняє (Р7). */
function existingIds(
  existing: ReadonlyMap<string, string>,
  defaultSchema: string
): Map<string, string> {
  const ids = new Map<string, string>()
  for (const [path, text] of existing) {
    if (!path.endsWith(FUNCTIONS_FILE_SUFFIX) || !isGeneratedPath(path))
      continue
    for (const declaration of parseFile(text)?.functions ?? [])
      if (declaration.id !== undefined)
        ids.set(
          tupleKey(
            declaration.function.schema ?? defaultSchema,
            declaration.function.name
          ),
          declaration.id
        )
  }
  return ids
}

/**
 * Кроки 1–6 спеки §5.5 для кожної definer-функції теки. Кожна definer-функція
 * мусить мати факт `EXECUTE` (fail-closed: без нього «без викликачів» було б
 * мовчазним звуженням), і ACL кожної перевіряється на гранти, яких декларація
 * не відтворює, — з декларацією чи без.
 */
export async function declareFunctions(
  input: DeclareInput
): Promise<FunctionDeclarations> {
  const { facts, provider, parse, plpgsql } = input
  const result: FunctionDeclarations = {
    files: new Map(),
    dropped: new Set(),
    diagnostics: [],
    written: [],
  }
  const functionLike = input.units.filter(
    (u) =>
      u.class === "function" ||
      u.class === "procedure" ||
      u.class === "aggregate" ||
      u.class === "functionSettings"
  )
  const read = readSqlUnits(
    // Текст з явними типовими атрибутами, яких вимагає закрита оболонка, а
    // каталог не друкує (`explicitVolatility`): інакше definer-функція з
    // типовою VOLATILE мовчки лишалася б без декларації
    functionLike.map((u) => ({
      file: u.identity,
      text: explicitVolatility(u, parse),
      schema: "",
    })),
    parse,
    []
  ).units
  const verbatim = new Map(read.map((u) => [u.identity, u]))
  const parsed = [...verbatim.values()]
  const namedCount = (
    schema: string,
    name: string,
    classes: ReadonlySet<string> = FUNCTION_CLASSES
  ) =>
    input.units.filter(
      (u) => classes.has(u.class) && u.schema === schema && u.name === name
    ).length
  const kept = keptDeclarations(input.existing, input.defaultSchema)
  const ids = existingIds(input.existing, input.defaultSchema)
  const report = (
    code: Parameters<typeof diagnostic>[0],
    file: string,
    params: Record<string, string | number>
  ) => result.diagnostics.push(diagnostic(code, file, "", params))
  const checked = new Set<string>()
  const pending: {
    declaration: SqlFunctionDeclaration
    resolve: (kinds: KindsByLabel | undefined) => void
  }[] = []

  for (const catalogUnit of functionLike) {
    if (catalogUnit.class !== "function" && catalogUnit.class !== "procedure")
      continue
    const unit = verbatim.get(catalogUnit.identity)
    // Тригерну функцію Postgres не дає викликати напряму: це не RPC, ролям
    // API вона не відкрита, і факт її `EXECUTE` нічого не вирішує
    if (
      unit === undefined ||
      isTriggerFunction(unit) ||
      !isSecurityDefiner(unit, parsed)
    )
      continue
    const { schema, name } = unit
    if (input.platformForms.has(tupleKey(schema, name))) continue
    const label = `${schema}.${name}`
    const named = facts?.functions.filter(
      (f) => f.schema === schema && f.name === name
    )
    const count = namedCount(schema, name)
    // Факти є лише в функцій і процедур, не в агрегатів
    const withFacts = namedCount(schema, name, FACTED)
    // Факт кожної definer-функції обов'язковий; перевантаження — рівно стільки
    // фактів, скільки функцій (ключ факту — аргументи ідентичності каталогу,
    // а не текст одиниці).
    // Перевантаження ділять ім'я: помилку фактів і чужі гранти — раз на ім'я
    const nameKey = tupleKey(schema, name)
    const firstOfName = !checked.has(nameKey)
    checked.add(nameKey)
    if (named === undefined || named.length !== withFacts) {
      if (firstOfName)
        report("introspect.definer-acl-changed", "", {
          check: "fact",
          function: label,
        })
      continue
    }
    for (const fact of firstOfName ? named : [])
      for (const grant of foreignGrants(fact, provider))
        report("introspect.definer-foreign-grant", "", {
          function: `${label}(${fact.identityArguments})`,
          role: grant.role,
          reason: grant.reason,
        })
    const fact = named[0]!
    const derived = derivedCallers(fact, provider)

    if (input.described.has(unit.identity)) {
      // Збережений файл не переписується: його декларація не має повернути
      // право, яке з бази відкликано (Р13)
      const declaration = kept.get(tupleKey(schema, name))
      if (declaration !== undefined && count === 1) {
        const declared = [...declaration.callers].sort()
        const actual = [...derived.callers].sort()
        if (declared.join() !== actual.join())
          result.diagnostics.push(
            diagnostic(
              "introspect.definer-callers-drift",
              declaration.file,
              declaration.pointer,
              {
                function: label,
                declared: joined(declared),
                actual: joined(actual),
              }
            )
          )
      }
      // Збережений файл викликачем без сесії не описує, але план відкличе
      // цей `EXECUTE`: про це теж попереджаємо
      for (const role of derived.anonymous)
        report("introspect.definer-anonymous-dropped", "", {
          function: label,
          role,
        })
      continue
    }
    const sqlPath = input.functionPaths.get(unit.identity)
    const args = guardArgsOf(unit, plpgsql, parse)
    const shell = closedShellProblem(
      { tree: unit.tree as Node, sql: unit.sql },
      plpgsql
    )
    // Перевантаження, процедура, sidecar таблиці, оболонка поза закритою
    // формою: декларації немає (Р5, Р9), гранти лишаються дослівними, а
    // запобіжник у тілі компіляція відмовить — причину називаємо тут
    const blocker =
      count !== 1
        ? "the function is overloaded"
        : unit.class !== "function"
          ? "a procedure cannot be declared"
          : sqlPath === undefined
            ? "the function has no file of its own"
            : shell !== undefined
              ? `the shell is not closed (${shell})`
              : undefined
    if (blocker !== undefined || sqlPath === undefined) {
      if (args !== undefined)
        report("introspect.definer-check-unknown", "", {
          function: label,
          reason: `the call guard cannot be declared: ${blocker ?? "no file"}`,
        })
      continue
    }
    // Лише власник і без запобіжника: декларації немає, `REVOKE` лишається
    // дослівним; із запобіжником — декларація без викликачів, інакше виклик
    // запобіжника поза формою відмовила б компіляція. Анонімна роль без сесії
    // теж не пропуск: дослівний `GRANT … TO anon` ніхто б не відкликав, тож
    // функція отримує декларацію без викликачів і попередження (§5.5 п.2)
    if (
      derived.callers.length === 0 &&
      derived.anonymous.length === 0 &&
      args === undefined
    )
      continue

    for (const role of derived.anonymous)
      report("introspect.definer-anonymous-dropped", "", {
        function: label,
        role,
      })
    const path = sqlPath.replace(/\.sql$/, FUNCTIONS_FILE_SUFFIX)
    const onBehalfOfUser = derived.callers.some(
      (c) => c === "user" || c === "command"
    )
    const unknown = (reason: string, guarded = false) => {
      if (onBehalfOfUser || guarded)
        report("introspect.definer-check-unknown", path, {
          function: label,
          reason,
        })
      return undefined
    }
    const declaration: SqlFunctionDeclaration = {
      id: ids.get(tupleKey(schema, name)) ?? input.newId(),
      function: { schema, name },
      callers: derived.callers,
    }
    if (args === undefined) {
      unknown("no call guard of the proven form as the first statement")
    } else {
      // Мітку й дію розв'язують контракти прав метаданих теки (`metadataRights`), а їх
      // будують, коли зібрано всі функції
      pending.push({
        declaration,
        resolve: (kinds) => {
          // Мітка виду унікальна в теці (`identity.kind-label-duplicate`)
          const [contract] = kinds?.get(args.kindLabel) ?? []
          const action = contract?.actions.get(args.action)
          if (kinds === undefined)
            unknown("the metadata do not build rights contracts", true)
          else if (contract === undefined)
            unknown(
              `kind label ${args.kindLabel} is not an object of the folder`,
              true
            )
          else if (action === undefined)
            unknown(
              `action ${args.action} is not an action of ${contract.kind} ${contract.name}`,
              true
            )
          else
            declaration.check = {
              action,
              object: { kind: contract.kind, name: contract.name },
              ...(args.target === null
                ? {}
                : args.form === "require"
                  ? { row: args.target }
                  : { scope: args.target }),
            }
        },
      })
    }
    if (setOfUuid(unit))
      report("introspect.definer-platform-form-candidate", path, {
        function: label,
      })

    result.written.push({ path, schema, name, declaration })

    // Гранти цієї функції відтворює генератор: дослівних не пишемо ніде
    const own = new Set([`function|${identityKey(unit.identity)}`])
    for (const grant of input.units) {
      const keys = grantTargetKeys(grant, parse)
      if (keys.length > 0 && keys.every((key) => ownsTarget(own, key)))
        result.dropped.add(grant)
    }
  }

  if (pending.length > 0) {
    const kinds = await input.kinds()
    for (const item of pending) item.resolve(kinds)
  }

  const byPath = new Map<string, SqlFunctionDeclaration[]>()
  for (const w of result.written)
    byPath.set(w.path, [...(byPath.get(w.path) ?? []), w.declaration])
  for (const [path, entries] of byPath)
    result.files.set(path, renderFunctionsFile(path, entries, input.schemaPath))
  return result
}
