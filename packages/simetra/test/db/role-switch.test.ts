// Статичний тест моделі з'єднання тестів (спека профілю §10.3, запобіжники
// 1–3). Перемикання ролі сесії, `session authorization` і `set_config` — лише
// в дозволених формах і в місцях, названих поіменно нижче: дозволений
// перелік, а не чорний список, тож нова форма чи нове місце — збій, доки його
// не названо з причиною. Так само тримаються літерал ролі `postgres` у SQL
// файлів `db` і параметр `options` адреси тестів.
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  COMMAND_SETTING,
  RIGHTS_MAINTENANCE_SETTING,
  SESSION_CLAIMS_SETTING,
} from "simetra/model"
import ts from "typescript"
import { describe, expect, it } from "vitest"

const REPO = fileURLToPath(new URL("../../../../", import.meta.url))

// DB-тести, помічники, unit-тести й продовий код обох пакетів
const ROOTS = [
  "packages/simetra/src",
  "packages/simetra/test",
  "packages/simetra/bench",
  "packages/designer/src",
  "packages/designer/test",
]

/** Перші аргументи `set_config`, дозволені літералом у будь-якому файлі. */
const ALLOWED_SETTINGS = [
  "statement_timeout",
  "lock_timeout",
  "idle_in_transaction_session_timeout",
  "transaction_timeout",
  "search_path",
  "TimeZone",
  "bytea_output",
  "row_security",
  "jit",
  SESSION_CLAIMS_SETTING,
  COMMAND_SETTING,
  RIGHTS_MAINTENANCE_SETTING,
]

/** Сталі налаштувань, дозволені підстановкою першим аргументом `set_config`. */
const SETTING_CONSTANTS = [
  "SESSION_CLAIMS_SETTING",
  "COMMAND_SETTING",
  "RIGHTS_MAINTENANCE_SETTING",
]

/** Файли, де `set_config($1` — форма помічника, а не обхід переліку. */
const PARAMETER_SETTING_FILES = [
  "packages/simetra/test/db/connection.ts",
  "packages/simetra/test/db/rights-seed.ts",
]

// Цілі `SET LOCAL ROLE ${…}`, дозволені без винятку в тестах і помічниках:
// роль платформи, роль запиту профілю (індекс — профіль, не літеральний
// ключ), власник профілю прогону чи тегована роль прогону. Ні власник чужого
// профілю (на Supabase `postgres`), ні роль входу ціллю не бувають
const ALLOWED_TARGET =
  /^(PLATFORM_ROLES\.|testRoleFor\(|PROVIDER_API_ROLES\[(?!["'`])[^\]]+\]|PROVIDER_OWNER_ROLES\[testProvider\(\)\]|readRoleOf\(|testRoleName\()/

interface Exception {
  file: string
  reason: string
  /** Задача плану ПГ-2b, що прибирає тимчасовий виняток. */
  task?: number
  /** Лише в тілах цих функцій файла; без поля — у всьому файлі. */
  within?: string[]
}

const EXPECTED_SQL = "expected SQL or data of the compiler or vet checks"

const ROLE_SWITCH_EXCEPTIONS: Exception[] = [
  // Місця, які модель з'єднання вводить сама
  {
    file: "packages/simetra/test/db/connection.ts",
    reason:
      "the helpers of the connection model: the escape to the superuser, another login in the transaction, the return to the start role, the request and command roles, the named settings",
    within: [
      "asStackSuperuser",
      "asSessionLogin",
      "restoreOwnerRole",
      "superuserClient",
      "asRole",
      "commandAs",
      "commandSteps",
      "setLocalSetting",
    ],
  },
  {
    file: "packages/simetra/test/db/connection.test.ts",
    reason: "the statement order of the connection-model helpers",
  },
  {
    file: "packages/simetra/test/db/role-switch.test.ts",
    reason: "this test: the reasons of its exceptions name the forms",
  },
  {
    file: "packages/simetra/test/db/profile.ts",
    reason:
      "SUPERUSER_PRELUDE: the one form the superuser connections of the guard and the sweep take",
  },
  {
    file: "packages/simetra/test/db/profile.test.ts",
    reason: "the statements of SUPERUSER_PRELUDE",
  },
  {
    file: "packages/simetra/test/db/auth.ts",
    reason:
      "signUp on postgres: the insert of the auth login role from the login superuser, and the return to the caller's session_user and current_user",
    within: ["signUpBetterAuth"],
  },
  {
    file: "packages/simetra/test/db/pgtap.ts",
    reason:
      "the runner's own marker and claims set_config($1, SET LOCAL ROLE of the suite's request role, and the forms it refuses inside a suite",
  },
  {
    file: "packages/simetra/test/db/pgtap.test.ts",
    reason:
      "the statement order of the runner and the role switches it refuses inside a suite",
  },
  // Продовий SQL з власних спек
  {
    file: "packages/simetra/src/schema/apply/postgres-cluster.ts",
    reason: "the superuser prelude of `roles` (ПГ-2a)",
  },
  {
    file: "packages/designer/src/schema-engine/apply-database.ts",
    reason: "ApplyDatabase.statement runs without a start role (ПГ-2a)",
  },
  {
    file: "packages/simetra/src/compiler/messages.ts",
    reason: "the text of the diagnostic that names the forbidden forms",
  },
  {
    file: "packages/simetra/src/model/schemas/project.ts",
    reason: "the list of forbidden settings (role, session_authorization)",
  },
  {
    file: "packages/simetra/src/server/runtime.ts",
    reason: "SET LOCAL ROLE of the read role from the runtime state",
  },
  {
    file: "packages/simetra/src/server/transaction.ts",
    reason: "SET LOCAL ROLE of the command role",
  },
  {
    file: "packages/simetra/src/schema/apply/settings.ts",
    reason: "set_config of the settings list of the project",
  },
  {
    file: "packages/simetra/src/schema/apply/function-checks.ts",
    reason: "set_config from proconfig",
  },
  {
    file: "packages/simetra/src/schema/apply/rights-maintenance.ts",
    reason: "MAINTENANCE_ON, its parameter is RIGHTS_MAINTENANCE_SETTING",
  },
  {
    file: "packages/simetra/src/compiler/mechanics-units.ts",
    reason:
      "the row-version setting per relation and synchronous_commit of the mechanics units",
  },
  // Unit-тести: форми — очікуваний SQL чи дані перевірок компілятора й `vet`
  ...[
    "packages/simetra/src/compiler/__tests__/closed-forms.test.ts",
    "packages/simetra/src/compiler/__tests__/function-body.test.ts",
    "packages/simetra/src/compiler/__tests__/event-subscriptions.test.ts",
    "packages/simetra/src/compiler/__tests__/heads.test.ts",
    "packages/simetra/src/compiler/__tests__/stage-integrity.test.ts",
    "packages/simetra/src/compiler/__tests__/mechanics-units.test.ts",
    "packages/simetra/src/schema/apply/__tests__/execute.test.ts",
    "packages/simetra/src/schema/apply/__tests__/state.test.ts",
    "packages/simetra/src/server/__tests__/harness.ts",
    "packages/simetra/src/server/__tests__/runtime.test.ts",
    "packages/simetra/src/server/__tests__/read-runtime.test.ts",
    "packages/designer/src/schema-engine/__tests__/read-only.test.ts",
  ].map((file) => ({ file, reason: EXPECTED_SQL })),
  // DB-тести, прив'язані до стека
  {
    file: "packages/designer/src/schema-engine/__tests__/execute-plan.supabase.db.test.ts",
    reason: "ALTER ROLE … SET role of API_LOGIN: a Supabase regression",
  },
  {
    file: "packages/simetra/test/db/subscriptions.supabase.db.test.ts",
    reason:
      "APP_ROLE, AUTH_SERVICE_ROLE: roles of the Supabase provider (§10.5)",
  },
  {
    file: "packages/designer/src/__tests__/roles-tool.postgres.db.test.ts",
    reason:
      "the roles tool on a tagged cluster (ПГ-2a): its check reads as the superuser, a database-level SET role is the case under test, and a login role reaches a request role only by SET ROLE",
  },
  // Тимчасові: форми переписує задача, що володіє файлом
  {
    file: "packages/simetra/test/db/rights-guards.db.test.ts",
    reason:
      "SET ROLE postgres, SET SESSION AUTHORIZATION, RESET ROLE of the owner-login cases",
    task: 7,
  },
  {
    file: "packages/simetra/test/db/command-grants.db.test.ts",
    reason:
      "SET ROLE postgres, SET SESSION AUTHORIZATION, RESET ROLE of the runtime-login cases",
    task: 7,
  },
  {
    file: "packages/designer/src/__tests__/roles-tool.db.test.ts",
    reason: "SET LOCAL ROLE authenticated and a role returned by a helper",
    task: 12,
  },
  {
    file: "packages/simetra/test/db/rights-write.db.test.ts",
    reason:
      "SET LOCAL ROLE of the Supabase service role by a literal key: the cases go to rights-write.supabase (Р5)",
    task: 7,
  },
  {
    file: "packages/simetra/test/db/mechanics.db.test.ts",
    reason: "SET LOCAL ROLE of a table row parameter",
    task: 8,
  },
  {
    file: "packages/simetra/test/db/row-version.db.test.ts",
    reason: "SET LOCAL ROLE of a table row parameter",
    task: 8,
  },
]

// Літерал ролі `postgres` у SQL файлів `db`: ім'я — дані профілю
// (`PROVIDER_OWNER_ROLES[testProvider()]`). Тимчасові — до задачі-власника
const POSTGRES_LITERAL_EXCEPTIONS: Exception[] = [
  ...(
    [
      ["packages/simetra/test/db/rights-guards.db.test.ts", 7],
      ["packages/simetra/test/db/command-grants.db.test.ts", 7],
      [
        "packages/designer/src/schema-engine/__tests__/engine-census.db.test.ts",
        10,
      ],
      [
        "packages/designer/src/schema-engine/__tests__/engine-extract.db.test.ts",
        10,
      ],
      [
        "packages/designer/src/schema-engine/__tests__/fingerprint.db.test.ts",
        10,
      ],
      [
        "packages/designer/src/schema-engine/__tests__/build-plan.db.test.ts",
        11,
      ],
      [
        "packages/designer/src/schema-engine/__tests__/build-plan-provider.db.test.ts",
        11,
      ],
      [
        "packages/designer/src/schema-engine/__tests__/build-plan-promotion.db.test.ts",
        11,
      ],
      [
        "packages/designer/src/schema-engine/__tests__/execute-plan.db.test.ts",
        11,
      ],
      ["packages/designer/src/__tests__/apply-lifecycle.db.test.ts", 12],
      ["packages/designer/src/__tests__/apply-tools.db.test.ts", 12],
      ["packages/designer/src/__tests__/database-tools.db.test.ts", 12],
      ["packages/designer/src/__tests__/roles-tool.db.test.ts", 12],
    ] as const
  ).map(([file, task]) => ({
    file,
    reason: "the Supabase owner role postgres in SQL or an expected message",
    task,
  })),
]

// `options` адреси тестів дописує лише `withSessionOptions`, DSN ролі входу
// будує лише `loginUrl`
const OPTIONS_EXCEPTIONS: Exception[] = [
  {
    file: "packages/simetra/test/db/connection.ts",
    reason: "the two helpers that own the options parameter and the login",
    within: ["loginUrl", "withSessionOptions"],
  },
  {
    file: "packages/simetra/test/db/profile.ts",
    reason: "the profile data that defines the start role of the test URL",
  },
  ...[
    "packages/simetra/test/db/connection.test.ts",
    "packages/simetra/test/db/profile.test.ts",
    "packages/simetra/test/db/stack-guard.test.ts",
    "packages/simetra/test/db/role-switch.test.ts",
  ].map((file) => ({
    file,
    reason: "asserts the shape of the test URL or names the forms",
  })),
  {
    file: "packages/designer/src/__tests__/support/db.ts",
    reason: "throughPoolerAs derives the user of the pooler from the login",
    within: ["throughPoolerAs"],
  },
  {
    file: "packages/designer/src/__tests__/data-tools.db.test.ts",
    reason:
      "options go on env.login, a login role URL without -c role=, not on the test URL",
  },
]

function sources(dir: string): string[] {
  return readdirSync(join(REPO, dir), { withFileTypes: true }).flatMap(
    (entry) => {
      const path = `${dir}/${entry.name}`
      if (entry.isDirectory())
        return entry.name === "node_modules" || entry.name === "dist"
          ? []
          : sources(path)
      return /\.tsx?$/.test(entry.name) ? [path] : []
    }
  )
}

interface Source {
  file: string
  /** Текст з коментарями, заміненими пробілами: позиції ті самі, що в AST. */
  code: string
  ast: ts.SourceFile
}

// AST, а не regex: шаблон `/*` у рядку (glob) інакше «відкрив» би коментар
function parse(
  file: string,
  text: string = readFileSync(join(REPO, file), "utf8")
): Source {
  const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  // Одиниці UTF-16, як і позиції AST
  const units = text.split("")
  const visit = (node: ts.Node): void => {
    for (const range of [
      ...(ts.getLeadingCommentRanges(text, node.getFullStart()) ?? []),
      ...(ts.getTrailingCommentRanges(text, node.getEnd()) ?? []),
    ])
      for (let i = range.pos; i < range.end; i++)
        if (units[i] !== "\n") units[i] = " "
    ts.forEachChild(node, visit)
  }
  visit(ast)
  return { file, code: units.join(""), ast }
}

const SOURCES = ROOTS.flatMap(sources)
  .sort()
  .map((file) => parse(file))
const BY_FILE = new Map(SOURCES.map((s) => [s.file, s]))

/** Файли тестів і помічників: дозволені форми діють лише в них. */
function isTestSource(file: string): boolean {
  return (
    file.includes("/__tests__/") ||
    file.startsWith("packages/simetra/test/") ||
    file.startsWith("packages/designer/test/") ||
    file.startsWith("packages/simetra/bench/")
  )
}

/** Файли проєкту `db`: без `.supabase.` і `.postgres.` у назві. */
function isDbFile(file: string): boolean {
  return (
    file.endsWith(".db.test.ts") &&
    !file.includes(".supabase.") &&
    !file.includes(".postgres.")
  )
}

interface Hit {
  file: string
  line: number
  index: number
  text: string
}

function hitsOf(source: Source, pattern: RegExp): Hit[] {
  return [...source.code.matchAll(pattern)].map((match) => ({
    file: source.file,
    line: source.code.slice(0, match.index).split("\n").length,
    index: match.index,
    text: source.code
      .slice(match.index, match.index + 90)
      .split("\n")[0]!
      .trim(),
  }))
}

// Діапазони тіл названих функцій файла: оголошення функції чи стала з
// функцією
function functionRanges(
  source: Source,
  names: readonly string[]
): [number, number][] {
  const ranges: [number, number][] = []
  const visit = (node: ts.Node): void => {
    const name =
      ts.isFunctionDeclaration(node) && node.name !== undefined
        ? node.name.text
        : ts.isVariableDeclaration(node) &&
            ts.isIdentifier(node.name) &&
            node.initializer !== undefined &&
            (ts.isArrowFunction(node.initializer) ||
              ts.isFunctionExpression(node.initializer))
          ? node.name.text
          : undefined
    if (name !== undefined && names.includes(name))
      ranges.push([node.getStart(), node.getEnd()])
    ts.forEachChild(node, visit)
  }
  visit(source.ast)
  return ranges
}

/**
 * Перевірка з дозволеним переліком місць: збіг, якого не покриває виняток, —
 * порушення; виняток без жодного збігу у своєму файлі — застарілий.
 */
function check(
  hits: readonly Hit[],
  exceptions: readonly Exception[]
): { violations: string[]; stale: string[] } {
  const used = new Set<Exception>()
  const violations: string[] = []
  for (const hit of hits) {
    const exception = exceptions.find(
      (e) =>
        e.file === hit.file &&
        (e.within === undefined ||
          functionRanges(BY_FILE.get(e.file)!, e.within).some(
            ([from, to]) => hit.index >= from && hit.index < to
          ))
    )
    if (exception === undefined)
      violations.push(`${hit.file}:${hit.line}: ${hit.text}`)
    else used.add(exception)
  }
  const stale = exceptions
    .filter((e) => !used.has(e))
    .map((e) => `${e.file}: ${e.reason}`)
  return { violations, stale }
}

const targetOf = (text: string): string => text.trim().replace(/!$/, "")

/** Сталі з дозволеною ціллю, які експортує помічник тестів `source`. */
function helperConstantsOf(source: Source): string[] {
  return source.ast.statements.flatMap((statement) =>
    ts.isVariableStatement(statement) &&
    statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      ? statement.declarationList.declarations.flatMap((d) =>
          ts.isIdentifier(d.name) &&
          d.initializer !== undefined &&
          ALLOWED_TARGET.test(targetOf(d.initializer.getText()))
            ? [d.name.text]
            : []
        )
      : []
  )
}

const HELPER_CONSTANTS = new Set(
  SOURCES.filter(
    (s) =>
      s.file.endsWith(".support.ts") ||
      s.file.includes("/support/") ||
      s.file.startsWith("packages/simetra/test/db/")
  ).flatMap(helperConstantsOf)
)

interface Declaration {
  name: string
  /** Область видимості: блок, файл, цикл чи функція параметра. */
  scope: [number, number]
  at: number
  /** Ініціалізатор сталої; без нього (параметр, `let`, деструктуризація) — будь-яка роль. */
  target?: string
}

function declarationsOf(source: Source): Declaration[] {
  const found: Declaration[] = []
  const scopeOf = (node: ts.Node): [number, number] => {
    let scope: ts.Node = node.parent
    while (
      !ts.isBlock(scope) &&
      !ts.isSourceFile(scope) &&
      !ts.isModuleBlock(scope) &&
      !ts.isCaseBlock(scope) &&
      !ts.isForStatement(scope) &&
      !ts.isForOfStatement(scope) &&
      !ts.isForInStatement(scope) &&
      !ts.isFunctionLike(scope)
    )
      scope = scope.parent
    return [scope.getStart(), scope.getEnd()]
  }
  const bind = (
    name: ts.BindingName,
    scope: [number, number],
    target?: string
  ): void => {
    if (ts.isIdentifier(name))
      found.push({ name: name.text, scope, at: name.getStart(), target })
    else
      for (const element of name.elements)
        if (!ts.isOmittedExpression(element)) bind(element.name, scope)
  }
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)) {
      const constant =
        ts.isVariableDeclarationList(node.parent) &&
        (node.parent.flags & ts.NodeFlags.Const) !== 0
      bind(
        node.name,
        scopeOf(node),
        constant && ts.isIdentifier(node.name) && node.initializer !== undefined
          ? targetOf(node.initializer.getText())
          : undefined
      )
    } else if (ts.isParameter(node))
      bind(node.name, [node.parent.getStart(), node.parent.getEnd()])
    ts.forEachChild(node, visit)
  }
  visit(source.ast)
  return found
}

/**
 * Чи ім'я `name`, видиме в позиції `at`, — стала з дозволеною ціллю (чи
 * стала від такої сталої), або імпортована стала помічника. Видиме
 * оголошення — найглибше, область якого містить позицію: параметр чи `let`
 * з тим самим ім'ям у тій області дав би будь-яку роль.
 */
function allowedAt(
  source: Source,
  name: string,
  at: number,
  depth = 0
): boolean {
  const visible = declarationsOf(source)
    .filter((d) => d.name === name && d.scope[0] <= at && at < d.scope[1])
    .sort((a, b) => a.scope[1] - a.scope[0] - (b.scope[1] - b.scope[0]))[0]
  if (visible === undefined) return importedHelperConstant(source, name)
  const target = visible.target
  if (target === undefined) return false
  if (ALLOWED_TARGET.test(target)) return true
  return (
    /^\w+$/.test(target) &&
    depth < 8 &&
    allowedAt(source, target, visible.at, depth + 1)
  )
}

function importedHelperConstant(source: Source, name: string): boolean {
  if (!HELPER_CONSTANTS.has(name)) return false
  return source.ast.statements.some((statement) => {
    const bindings = ts.isImportDeclaration(statement)
      ? statement.importClause?.namedBindings
      : undefined
    return (
      bindings !== undefined &&
      ts.isNamedImports(bindings) &&
      bindings.elements.some((e) => e.name.text === name)
    )
  })
}

const ROLE_FORM = /\b(re)?set\s+(local\s+|session\s+)?role\b/gi
const SESSION_AUTH = /session[\s_]+authorization/gi
const SET_CONFIG = /set_config\s*\(/gi

/** `SET LOCAL ROLE ${ціль}` з дозволеною ціллю, у тесті чи помічнику. */
function allowedRoleSwitch(source: Source, hit: Hit): boolean {
  if (!isTestSource(source.file)) return false
  const rest = source.code.slice(hit.index)
  const form = /^set\s+local\s+role\s+"?\$\{/i.exec(rest)
  if (form === null) return false
  const end = rest.indexOf("}", form[0].length)
  if (end < 0) return false
  const target = targetOf(rest.slice(form[0].length, end))
  return (
    ALLOWED_TARGET.test(target) ||
    (/^\w+$/.test(target) && allowedAt(source, target, hit.index))
  )
}

/** `set_config(` з дозволеним першим аргументом. */
function allowedSetConfig(source: Source, hit: Hit): boolean {
  const rest = source.code.slice(hit.index).replace(/^set_config\s*\(\s*/i, "")
  const literal = /^'([^']*)'/.exec(rest)
  if (literal !== null && ALLOWED_SETTINGS.includes(literal[1]!)) return true
  const constants = SETTING_CONSTANTS.join("|")
  if (
    new RegExp(
      `^('?\\$\\{(${constants})\\}'?|\\$\\{(literal|sqlLiteral)\\((${constants})\\)\\})\\s*,`
    ).test(rest)
  )
    return true
  return /^\$1\b/.test(rest) && PARAMETER_SETTING_FILES.includes(source.file)
}

function roleSwitchHitsOf(source: Source): Hit[] {
  return [
    ...hitsOf(source, ROLE_FORM).filter(
      (hit) => !allowedRoleSwitch(source, hit)
    ),
    ...hitsOf(source, SESSION_AUTH),
    ...hitsOf(source, SET_CONFIG).filter(
      (hit) => !allowedSetConfig(source, hit)
    ),
  ]
}

function roleSwitchHits(): Hit[] {
  return SOURCES.flatMap(roleSwitchHitsOf)
}

function postgresLiteralHits(): Hit[] {
  return SOURCES.filter((s) => isDbFile(s.file)).flatMap((source) =>
    hitsOf(source, /\b(role|to|for\s+role)\s+"?postgres\b/gi)
  )
}

function optionsHits(): Hit[] {
  return SOURCES.filter((s) => isTestSource(s.file)).flatMap((source) => {
    const found = [
      ...hitsOf(source, /options=/g),
      ...hitsOf(source, /searchParams\.\w+\(\s*["'`]options["'`]/g),
      ...hitsOf(source, /\.username\s*=(?!=)/g),
    ]
    // Ключ `options:` у конфігу клієнта чи пулу поряд з `connectionString`
    const visit = (node: ts.Node): void => {
      if (ts.isObjectLiteralExpression(node)) {
        const keys = node.properties.flatMap((p) =>
          p.name !== undefined && ts.isIdentifier(p.name) ? [p.name.text] : []
        )
        if (keys.includes("connectionString") && keys.includes("options"))
          found.push({
            file: source.file,
            line:
              source.ast.getLineAndCharacterOfPosition(node.getStart()).line +
              1,
            index: node.getStart(),
            text: "options: next to connectionString",
          })
      }
      ts.forEachChild(node, visit)
    }
    visit(source.ast)
    return found
  })
}

describe("role switches in the sources", () => {
  const hits = roleSwitchHits()

  it("finds the sources and the forms", () => {
    expect(BY_FILE.has("packages/simetra/test/db/connection.ts")).toBe(true)
    expect(hits.length).toBeGreaterThan(0)
  })

  it("switch the session role only in allowed forms or named places", () => {
    expect(check(hits, ROLE_SWITCH_EXCEPTIONS).violations).toEqual([])
  })

  it("name no exception without a match in its file", () => {
    expect(check(hits, ROLE_SWITCH_EXCEPTIONS).stale).toEqual([])
  })
})

describe("the postgres role literal in the SQL of db files", () => {
  const hits = postgresLiteralHits()

  it("appears only in the named files", () => {
    expect(check(hits, POSTGRES_LITERAL_EXCEPTIONS).violations).toEqual([])
  })

  it("names no exception without a match in its file", () => {
    expect(check(hits, POSTGRES_LITERAL_EXCEPTIONS).stale).toEqual([])
  })
})

describe("the options parameter of the test URL", () => {
  const hits = optionsHits()

  it("is set only by withSessionOptions, a login only by loginUrl", () => {
    expect(check(hits, OPTIONS_EXCEPTIONS).violations).toEqual([])
  })

  it("names no exception without a match in its file", () => {
    expect(check(hits, OPTIONS_EXCEPTIONS).stale).toEqual([])
  })
})

describe("the checker", () => {
  // Сам перелік не має ловити все підряд: дозволена форма проходить, інша — ні
  it("tells an allowed target from another one", () => {
    const sample = parse("packages/simetra/test/db/role-switch.test.ts")
    expect(allowedAt(sample, "ALLOWED_TARGET", sample.code.length - 1)).toBe(
      false
    )
    expect(ALLOWED_TARGET.test("PLATFORM_ROLES.command")).toBe(true)
    expect(ALLOWED_TARGET.test("role")).toBe(false)
  })
})

describe("allowed SET LOCAL ROLE targets", () => {
  // Синтетичний DB-тест: ціль — роль профілю за індексом профілю, а не
  // літеральним ключем, і ніколи — власник чужого профілю чи роль входу
  const sample = (target: string): Source =>
    parse(
      "packages/simetra/test/db/sample.db.test.ts",
      `await client.query(\`SET LOCAL ROLE \${${target}}\`)\n`
    )

  it.each([
    "PROVIDER_OWNER_ROLES.supabase",
    "PROVIDER_OWNER_ROLES[provider]",
    "PROVIDER_LOGIN_ROLES[provider][0]",
    "PROVIDER_API_ROLES.supabase.service",
    'PROVIDER_API_ROLES["postgres"].user',
  ])("rejects %s", (target) => {
    expect(roleSwitchHitsOf(sample(target))).toHaveLength(1)
  })

  it.each([
    "PLATFORM_ROLES.command",
    "PROVIDER_API_ROLES[testProvider()].user",
    "PROVIDER_API_ROLES[provider].anonymous",
    "PROVIDER_OWNER_ROLES[testProvider()]",
    'testRoleName("x")',
  ])("allows %s", (target) => {
    expect(roleSwitchHitsOf(sample(target))).toEqual([])
  })

  it("does not take a helper constant of a superuser or a login role", () => {
    const helper = parse(
      "packages/simetra/test/db/sample.support.ts",
      [
        "export const OWNER = PROVIDER_OWNER_ROLES.supabase",
        "export const LOGIN = PROVIDER_LOGIN_ROLES[provider][0]",
        "export const USER = PROVIDER_API_ROLES[testProvider()].user",
      ].join("\n")
    )
    expect(helperConstantsOf(helper)).toEqual(["USER"])
  })
})
