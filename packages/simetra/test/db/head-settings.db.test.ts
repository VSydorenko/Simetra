import { describe, expect, it } from "vitest"
import {
  HEAD_PINNED_SETTINGS,
  pinnedSettingsClause,
} from "../../src/compiler/sql/head-settings"
import { withRollback } from "./connection"

/**
 * Налаштування категорій вводу й виводу значень, які клієнт може поставити
 * сам (`context = 'user'`), але які корінь голови не фіксує: кожне — з
 * причиною, чому від нього не залежить значення, яке голова читає чи
 * повертає (спека декларацій функцій §5.8).
 */
const NOT_PINNED: Readonly<Record<string, string>> = {
  client_encoding:
    "converts text only on the wire to the client; values inside the server are in the database encoding",
  icu_validation_level: "applies only when an ICU collation is created",
  search_path: "the closed shell sets it to '' (SET search_path = '')",
  check_function_bodies: "applies only when a function is created",
  client_min_messages: "filters notices sent to the client, not values",
  createrole_self_grant: "applies only when a role is created",
  default_table_access_method: "applies only when a table is created",
  default_tablespace: "applies only when an object is created",
  default_toast_compression: "applies only when a column is stored or created",
  default_transaction_deferrable:
    "a property of a new transaction, not of a value",
  default_transaction_isolation:
    "a property of a new transaction, not of a value",
  default_transaction_read_only:
    "a property of a new transaction, not of a value",
  transaction_deferrable: "a property of the transaction, not of a value",
  transaction_isolation: "a property of the transaction, not of a value",
  transaction_read_only:
    "a property of the transaction; a read-only head is not affected",
  temp_tablespaces: "places temporary objects, not values",
  gin_pending_list_limit: "a storage parameter of GIN index maintenance",
  idle_in_transaction_session_timeout:
    "a timeout of the session, it ends the session, not a value",
  idle_session_timeout:
    "a timeout of the session, it ends the session, not a value",
  lock_timeout: "a timeout: the statement fails, it returns no other value",
  statement_timeout:
    "a timeout: the statement fails, it returns no other value",
  transaction_timeout:
    "a timeout: the transaction fails, it returns no other value",
  restrict_nonsystem_relation_kind:
    "refuses access to relation kinds with an error, it returns no other value",
  row_security:
    "off makes a query under RLS fail instead of filtering; it never widens what a policy returns",
  vacuum_failsafe_age: "a parameter of VACUUM",
  vacuum_freeze_min_age: "a parameter of VACUUM",
  vacuum_freeze_table_age: "a parameter of VACUUM",
  vacuum_multixact_failsafe_age: "a parameter of VACUUM",
  vacuum_multixact_freeze_min_age: "a parameter of VACUUM",
  vacuum_multixact_freeze_table_age: "a parameter of VACUUM",
}

const CATEGORIES = [
  "Client Connection Defaults / Locale and Formatting",
  "Client Connection Defaults / Statement Behavior",
]

/**
 * Набір налаштувань, які фіксує корінь голови (`HEAD_PINNED_SETTINGS`), проти
 * `pg_settings` закріпленої версії Postgres: налаштування, яке додав новий
 * мажор, — червоний тест, а не мовчазна залежність голови від клієнта.
 */
describe("head pinned settings", () => {
  it("cover every user setting of value input and output, or name the reason", async () => {
    const live = await withRollback(async (client) => {
      const { rows } = await client.query<{ name: string }>(
        `SELECT name FROM pg_catalog.pg_settings
         WHERE context = 'user' AND category = ANY($1::text[])
         ORDER BY name`,
        [CATEGORIES]
      )
      return rows.map((row) => row.name)
    })
    const pinned = new Set(HEAD_PINNED_SETTINGS.map((s) => s.name))
    expect({
      uncovered: live.filter((n) => !pinned.has(n) && !(n in NOT_PINNED)),
      // Виключення чи налаштування набору, якого немає в каталозі, —
      // опечатка або налаштування, яке прибрав мажор.
      stale: [...pinned, ...Object.keys(NOT_PINNED)].filter(
        (n) => !live.includes(n)
      ),
      both: [...pinned].filter((n) => n in NOT_PINNED),
    }).toEqual({ uncovered: [], stale: [], both: [] })
  })

  it("are accepted by CREATE FUNCTION and stored in proconfig as the judge compares them", async () => {
    const config = await withRollback(async (client) => {
      await client.query(
        `CREATE FUNCTION pg_temp.head_settings_probe() RETURNS SETOF uuid
           LANGUAGE sql STABLE SET search_path = '' ${pinnedSettingsClause()}
           AS $$ SELECT NULL::uuid WHERE false $$`
      )
      const { rows } = await client.query<{ proconfig: string[] }>(
        `SELECT proconfig FROM pg_catalog.pg_proc
         WHERE proname = 'head_settings_probe'
           AND pronamespace = pg_catalog.pg_my_temp_schema()`
      )
      return rows[0]?.proconfig ?? []
    })
    expect(config).toEqual([
      'search_path=""',
      ...HEAD_PINNED_SETTINGS.map(({ name, value }) => `${name}=${value}`),
    ])
  })
})
