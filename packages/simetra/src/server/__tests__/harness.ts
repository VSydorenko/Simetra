import type { Operation } from "simetra/model"
import { vi } from "vitest"
import { createCommandRuntime, type CommandRuntimeOptions } from "../runtime"
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
/** Межа часу серверного читання — перший оператор після `BEGIN`; типово 15 с. */
export const readTimeout = (ms = "15000") => ({
  text: "SELECT set_config('statement_timeout', $1, true)",
  params: [ms],
})
export const READ_TIMEOUT = readTimeout()
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
  CLAIMS,
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
  if (text.includes("rights_role_")) {
    return { rows: [{ r: JSON.stringify({ id: ID, version: 1, code: "R" }) }] }
  }
  if (text.endsWith("AS r")) return { rows: [{ r: coreRow() }] }
  return {}
}

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
  return { db, runtime, log }
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
