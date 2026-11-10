import {
  CommandFailure,
  metadataRefSchema,
  type CommandError,
  type Operation,
  type ReadQuery,
  type RuntimeCatalog,
  type RuntimeObject,
  type SessionClaims,
} from "simetra/model"
import { expect, vi } from "vitest"
import {
  createCommandRuntime,
  type CommandRuntime,
  type CommandRuntimeOptions,
} from "../runtime"
import { fakeDatabase, type Answer, type Call } from "./fake-database"
import { COMPANY, ID, catalog, rootCatalog } from "./fixtures"

/**
 * Обв'язка тестів команд: оператори транзакції цілими рядками, відповіді
 * бази за замовчуванням і рантайм на порт-фейку.
 */

export const USER = "44444444-4444-4444-8444-444444444444"
export const session = { sub: "user-1", role: "authenticated" }
export const CLIENT = { kind: "Catalog" as const, name: "Client" }
export const RIGHTS = { kind: "Catalog" as const, name: "RightsRole" }
export const TICKET = { kind: "Catalog" as const, name: "Ticket" }
export const ROLE_ASSIGNMENT = {
  kind: "Catalog" as const,
  name: "RoleAssignment",
}

export const BEGIN = {
  text: "BEGIN ISOLATION LEVEL READ COMMITTED",
  params: [],
}
export const CLAIMS = {
  text:
    "SELECT set_config('request.jwt.claims', $1, true), " +
    "set_config('TimeZone', 'UTC', true), set_config('bytea_output', 'hex', true)",
  params: [JSON.stringify(session)],
}
/** `statement_timeout` окремим оператором: межа читання, прелюдія бюджету команди. */
export const statementTimeout = (ms: string) => ({
  text: "SELECT set_config('statement_timeout', $1, true)",
  params: [ms],
})
/**
 * Claims команди: claims читання плюс межі часу транзакції. Типово — бюджет
 * 60 с (стеля оператора 30 с, простій і `transaction_timeout` — 61 с) і
 * `lock_timeout` 5 с.
 */
export const commandClaims = (
  statement = "30000",
  lock = "5000",
  idle = "61000"
) => ({
  text:
    CLAIMS.text +
    ", set_config('statement_timeout', $2, true)" +
    ", set_config('lock_timeout', $3, true)" +
    ", set_config('idle_in_transaction_session_timeout', $4, true)" +
    ", CASE WHEN current_setting('server_version_num')::int >= 170000" +
    " THEN set_config('transaction_timeout', $4, true) END",
  params: [JSON.stringify(session), statement, lock, idle],
})
/** `BEGIN` транзакції серверного читання: один знімок на всі частини. */
export const READ_BEGIN = {
  text: "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
  params: [],
}
/**
 * Налаштування транзакції читання одним оператором: claims, стеля оператора,
 * запобіжник `transaction_timeout` (бюджет + 1 с) і роль останньою. Типово —
 * бюджет і стеля 15 с під роллю команд (запасний шлях).
 */
export const readSetup = (
  role = "simetra_command",
  statement = "15000",
  guard = "16000"
) => ({
  text:
    CLAIMS.text +
    ", set_config('statement_timeout', $2, true)" +
    ", CASE WHEN current_setting('server_version_num')::int >= 170000" +
    " THEN set_config('transaction_timeout', $3, true) END" +
    ", set_config('role', $4, true)",
  params: [JSON.stringify(session), statement, guard, role],
})
/** Епоха версій бази — оператор після налаштування, уже під роллю читання. */
export const EPOCH = {
  text: 'SELECT "simetra"."row_version_epoch"() AS epoch',
  params: [],
}
export const ROLE = { text: 'SET LOCAL ROLE "simetra_command"', params: [] }
export const CURRENT_USER = {
  text: 'SELECT "simetra"."current_user_id"() AS user_id',
  params: [],
}
export const COMMIT = { text: "COMMIT", params: [] }
export const ROLLBACK = { text: "ROLLBACK", params: [] }
export const OPEN: Call[] = [
  { connect: true },
  BEGIN,
  commandClaims(),
  ROLE,
  CURRENT_USER,
]

export const context = (action: string, object: string, root: string) => ({
  text: "SELECT set_config('simetra.command', $1, true)",
  params: [JSON.stringify({ action, object, root })],
})
export const call = (fn: string, args: string, params: (string | null)[]) => ({
  text: `SELECT "public"."${fn}"(${args}) AS r`,
  params,
})
export const SAVE = "$1::jsonb, $2::bigint"

/** Рядок ядра клієнта: `version` — числом, як `to_jsonb` дає `integer`. */
export const coreRow = (id = ID, version = 1) =>
  JSON.stringify({ id, version, code: "A", company_id: COMPANY })

export type Override = (
  text: string,
  params: readonly (string | null)[]
) => Answer | undefined

/** Відповіді бази за замовчуванням; `override` — лише те, про що кейс. */
export function answer(text: string): Answer {
  if (text.includes("current_user_id")) return { rows: [{ user_id: USER }] }
  if (text.includes("applied_snapshot_hash"))
    return { rows: [{ hash: "hash-1" }] }
  if (text.includes("pg_has_role")) return { rows: [{ member: "t" }] }
  // База без рядка епохи: функція відповідає `NULL`.
  if (text.includes("row_version_epoch")) return { rows: [{ epoch: null }] }
  if (text.includes("rights_role_")) {
    return { rows: [{ r: JSON.stringify({ id: ID, version: 1, code: "R" }) }] }
  }
  if (text.endsWith("AS r")) return { rows: [{ r: coreRow() }] }
  return {}
}

/** Об'єкт каталогу за сирим `object` входу; кидаючий геттер — не відомий. */
function rawObjectOf(
  catalog: RuntimeCatalog,
  raw: unknown
): RuntimeObject | undefined {
  try {
    const ref = metadataRefSchema.safeParse(
      (raw as { object?: unknown } | null | undefined)?.object
    )
    if (!ref.success) return undefined
    return catalog.objects.find(
      (o) => o.kind === ref.data.kind && o.name === ref.data.name
    )
  } catch {
    return undefined
  }
}

/**
 * Спільна перевірка правила `object` (спека П4-B §6.10): помилка з `path` чи
 * `attributes` називає відомий каталогу `object`, і ключ запису в її шляху —
 * `keyName`, а не структурне `id`. Винятки — немає об'єкта, до якого
 * прив'язати: `path: "object"` невідомого об'єкта і відмови схеми до розбору
 * операції, коли сирий `object` входу (у пакеті — операції за індексом
 * шляху) не знаходиться в каталозі.
 */
export function expectErrorObject(
  catalog: RuntimeCatalog,
  input: unknown,
  error: CommandError
): void {
  if (error.path === undefined && error.attributes === undefined) return
  if (error.object === undefined) {
    if (error.path === "object") return
    const [head = ""] = (error.path ?? "").split(".")
    const raws = !Array.isArray(input)
      ? [input]
      : /^\d+$/.test(head)
        ? [(input as unknown[])[Number(head)]]
        : (input as unknown[])
    expect(
      raws.every((raw) => rawObjectOf(catalog, raw) === undefined),
      `error without object: ${JSON.stringify(error)}`
    ).toBe(true)
    return
  }
  const { kind, name } = error.object
  const object = catalog.objects.find((o) => o.kind === kind && o.name === name)
  expect(object, `object outside the catalog: ${kind}.${name}`).toBeDefined()
  // Шлях застосунку з `ctx.reject` — довільний: правило ключа його не чіпає.
  if (error.code === "command.rejected" || error.path === undefined) return
  const keys = [
    object!.keyName,
    ...object!.tabularSections.map((s) => s.keyName),
  ]
  if (!keys.includes("id")) {
    expect(
      error.path.split("."),
      `structural id in ${error.path}`
    ).not.toContain("id")
  }
}

/** Відмова виклику — через {@link expectErrorObject}, далі як була. */
async function checked<T>(
  catalog: RuntimeCatalog,
  input: unknown,
  call: Promise<T>
): Promise<T> {
  try {
    return await call
  } catch (error) {
    if (error instanceof CommandFailure) {
      expectErrorObject(catalog, input, error.error)
    }
    throw error
  }
}

/** Рантайм, кожна відмова якого проходить спільну перевірку `object`. */
export const checkedRuntime = (
  runtime: CommandRuntime,
  catalog: RuntimeCatalog
): CommandRuntime => ({
  catalog: runtime.catalog,
  run: (session: SessionClaims, input, options) =>
    checked(catalog, input, runtime.run(session, input, options)),
  read: <Q extends ReadQuery>(session: SessionClaims, query: Q) =>
    checked(catalog, query, runtime.read(session, query)),
  // Відмова частини — тим самим правилом, що й відмова читання її запиту.
  readParts: async (session, parts, options) => {
    const result = await checked(
      catalog,
      parts,
      runtime.readParts(session, parts, options)
    )
    result.items.forEach((item, i) => {
      if (!item.ok) expectErrorObject(catalog, parts[i]!.query, item.error)
    })
    return result
  },
})

export async function setup(
  override: Override = () => undefined,
  options: Partial<CommandRuntimeOptions> = {},
  connectError?: unknown
) {
  let connects = 0
  const db = fakeDatabase({
    query: (text, params) => override(text, params) ?? answer(text),
    // Перше з'єднання — створення рантайму.
    connect: () =>
      connectError !== undefined && connects++ > 0
        ? { error: connectError }
        : undefined,
  })
  const log = vi.fn()
  const runtime = await createCommandRuntime({
    database: db.database,
    catalog,
    log,
    ...options,
  })
  db.calls.splice(0)
  return {
    db,
    // Каталог опцій — уже прийнятий рантаймом, тож тієї самої форми.
    runtime: checkedRuntime(
      runtime,
      (options.catalog as RuntimeCatalog | undefined) ?? catalog
    ),
    log,
  }
}

export const create = {
  action: "create",
  object: CLIENT,
  id: ID,
  values: { code: "A", company: COMPANY },
} satisfies Operation
export const createCall = call("client_save", SAVE, [
  JSON.stringify({ id: ID, code: "A", company_id: COMPANY }),
  null,
])

/** `create` призначення — фаза прав — і її фаза в черзі. */
export const assign = (id: string) =>
  ({
    action: "create",
    object: ROLE_ASSIGNMENT,
    id,
    values: { code: "G", company: COMPANY },
  }) satisfies Operation
export const assignPhase = (id: string) => [
  context("administerRights", "role_assignment", id),
  call("role_assignment_save", SAVE, [
    JSON.stringify({ id, code: "G", company_id: COMPANY }),
    null,
  ]),
]

export const ORGANIZATION = { kind: "Catalog" as const, name: "Organization" }
export const ORG_MEMBER = { kind: "Catalog" as const, name: "OrgMember" }
export const BRANCH = { kind: "Catalog" as const, name: "Branch" }
/** Id кореня й рядка членства, які генерує T3 (Р-A6-20). */
export const ROOT = "55555555-5555-4555-8555-555555555555"
export const MEMBER_ROW = "66666666-6666-4666-8666-666666666666"
export const CREATE_ROOT = "$1::jsonb, $2::jsonb, $3::uuid"

/** Id генерує T3: тест підставляє їх по черзі — корінь, далі рядок членства. */
export const generatedIds = (...ids: string[]) => {
  const spy = vi.spyOn(globalThis.crypto, "randomUUID")
  for (const id of ids)
    spy.mockReturnValueOnce(
      id as `${string}-${string}-${string}-${string}-${string}`
    )
  return spy
}

/** Результат ядра кореня (Р-A6-10): обидва рядки видимі творцю. */
export const rootResult = (
  root: Record<string, unknown> = { id: ROOT, version: 1, code: "A" },
  member: Record<string, unknown> | null = {
    id: MEMBER_ROW,
    version: 1,
    org_id: ROOT,
    user_id: USER,
    title: "T",
  }
) => JSON.stringify({ root, member })

/** Рантайм над каталогом із коренями; ядро кореня відповідає `rootResult`. */
export const setupRoots = (
  override: Override = () => undefined,
  options: Partial<CommandRuntimeOptions> = {}
) =>
  setup(
    (text, params) =>
      override(text, params) ??
      (text.includes("_create_root")
        ? { rows: [{ r: rootResult() }] }
        : undefined),
    { catalog: rootCatalog, ...options }
  )

export const createOrganization = {
  action: "create",
  object: ORGANIZATION,
  values: { code: "A" },
  creatorMember: { title: "T" },
} satisfies Operation
