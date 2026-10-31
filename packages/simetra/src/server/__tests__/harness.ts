import type { Operation } from "simetra/model"
import { vi } from "vitest"
import { createCommandRuntime, type CommandRuntimeOptions } from "../runtime"
import { fakeDatabase, type Answer, type Call } from "./fake-database"
import { COMPANY, ID, catalog } from "./fixtures"

/**
 * Обв'язка тестів команд: оператори транзакції цілими рядками, відповіді
 * бази за замовчуванням і рантайм на порт-фейку.
 */

export const USER = "44444444-4444-4444-8444-444444444444"
export const session = { sub: "user-1", role: "authenticated" }
export const CLIENT = { kind: "Catalog" as const, name: "Client" }
export const RIGHTS = { kind: "Catalog" as const, name: "RightsRole" }

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
