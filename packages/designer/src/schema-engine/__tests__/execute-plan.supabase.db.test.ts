import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  executePlan,
  readLockRights,
  readProviderLocks,
  PROVIDER_LOCKS,
  tableKey,
} from "simetra/schema"
import { createApplyDatabase } from ".."
import {
  testRoleName,
  testSuperuserUrl,
} from "../../../../simetra/test/support"
import { asSuperuser, dropRoles, query } from "../../__tests__/support/db"
import {
  ALTER_T,
  apply,
  BASE,
  CREATE_N,
  exists,
  holder,
  inTarget,
  ledger,
  LOCKER,
  LOCKER_PASSWORD,
  loginAs,
  options,
  planFor,
  stack,
  stubRehearsal,
  useExecutePlanSetup,
} from "./execute-plan.support"

/**
 * Раннер транзакції `executePlan` на стеку Supabase: відмова сесії сервісної
 * ролі, перелік замків supautils для ролі плану, таблиці переліку в
 * недоступних схемах і зміна переліку після плану. Спільна підготовка — `execute-plan.support.ts`.
 */

useExecutePlanSetup()

/** Роль входу, чия сесія стає роллю API провайдера. */
const API_LOGIN = testRoleName("execute_api")
const API_PASSWORD = "simetra-execute-api"

// Сесія ролі входу стає сервісною роллю Supabase: у профілі без неї роль API
// дав би інший член переліку, тож ці кейси — лише на стеку Supabase
beforeAll(() =>
  query(
    testSuperuserUrl(),
    `create role ${API_LOGIN} login password '${API_PASSWORD}';
     grant service_role to ${API_LOGIN};
     alter role ${API_LOGIN} set role = 'service_role';`
  )
)
afterAll(() => dropRoles(API_LOGIN))

// Конкурентно: ціль кожного тесту — власна база, ролі створює `beforeAll`;
// тест із тримачем блокування — послідовний (`concurrent: false`)
describe.concurrent("executePlan", () => {
  it("refuses an API role", async () => {
    await inTarget(BASE, async (url) => {
      // План тієї самої ролі API: збіг ролі плану від відмови не рятує
      const plan = await planFor(url, [CREATE_N], { role: "service_role" })
      const asApi = new URL(url)
      asApi.username = API_LOGIN
      asApi.password = API_PASSWORD
      const outcome = await executePlan(
        apply,
        { url: asApi.toString() },
        plan,
        options
      )
      expect(outcome).toMatchObject({
        status: "refused",
        attempts: 1,
        diagnostics: [
          { code: "apply.api-role", params: { role: "service_role" } },
        ],
      })
      expect(await exists(url, "app.n")).toBe(false)
    })
  })

  it("refuses a plan built for another role", async () => {
    await inTarget(BASE, async (url) => {
      const plan = await planFor(url, [CREATE_N])
      const outcome = await executePlan(
        apply,
        { url: loginAs(url, API_LOGIN, API_PASSWORD) },
        plan,
        { ...options, mode: "rehearse", rehearsal: stubRehearsal }
      )
      expect(outcome).toMatchObject({
        status: "refused",
        attempts: 1,
        diagnostics: [
          {
            code: "apply.role-mismatch",
            params: { plan: "postgres", current: "service_role" },
          },
        ],
      })
      expect(await exists(url, "app.n")).toBe(false)
    })
  })

  it("reads the provider lock list of the plan role, only tables that exist", async () => {
    const reader = createApplyDatabase({ readOnly: true })
    const read = (url: string, role: string) =>
      reader.transaction({ url }, "rollback", (tx) =>
        readProviderLocks(tx, role, PROVIDER_LOCKS.supabase)
      )
    // База стеку несе всі таблиці провайдера, і перелік — з налаштування
    // supautils цілі, а не з пресету
    const [policy, trigger] = await read(stack.url, "postgres")
    const listed = (setting: string) =>
      query<{ names: string[] }>(
        stack.url,
        `select array(select pg_catalog.json_array_elements_text(
           pg_catalog.current_setting('${setting}')::json -> 'postgres')) as names`
      ).then((rows) => rows[0]!.names)
    for (const [set, setting] of [
      [policy!, "supautils.policy_grants"],
      [trigger!, "supautils.drop_trigger_grants"],
    ] as const) {
      expect(set.setting).toBe(setting)
      const names = await listed(setting)
      expect(set.tables).toContainEqual({ schema: "auth", name: "users" })
      for (const t of set.tables)
        expect(names).toContain(`${t.schema}.${t.name}`)
    }
    expect(policy!.statements).toEqual([
      "createPolicy",
      "alterPolicy",
      "dropPolicy",
      "commentPolicy",
    ])
    expect(trigger!.statements).toEqual(["dropTrigger"])
    // Таблиця з переліку, якої на цілі немає, відсіюється, а не валить план
    await inTarget(BASE, async (url) => {
      await query(asSuperuser(url), "drop table auth.audit_log_entries cascade")
      const [onTarget] = await read(url, "postgres")
      expect(onTarget!.tables).toEqual(
        policy!.tables.filter((t) => t.name !== "audit_log_entries")
      )
    })
    // Роль поза переліком — таблиць немає, без відмови
    expect(
      (await read(stack.url, "authenticated")).map((s) => s.tables)
    ).toEqual([[], []])
  })

  it("leaves out a listed table in a schema the plan role cannot use, without aborting the read", async () => {
    // Роль тестів має `pg_read_all_data`, тобто USAGE на кожній схемі, тож
    // роль плану без USAGE — окремий вхід; ключ переліку — той самий
    const setup = `${BASE};
      grant usage on schema app to ${LOCKER};
      grant update on app.t to ${LOCKER};`
    await inTarget(setup, async (url) => {
      await query(
        asSuperuser(url),
        `revoke all on schema realtime from public;
         grant usage on schema auth to ${LOCKER}`
      )
      const asLocker = loginAs(url, LOCKER, LOCKER_PASSWORD)
      const [usage] = await query<{ usable: boolean }>(
        asLocker,
        "select pg_catalog.has_schema_privilege('realtime', 'USAGE') as usable"
      )
      expect(usage!.usable).toBe(false)
      // `to_regclass` тут кидає 42501 — саме це зірвало б транзакцію плану
      await expect(
        query(asLocker, "select to_regclass('realtime.messages')")
      ).rejects.toMatchObject({ code: "42501" })
      const reader = createApplyDatabase({ readOnly: true })
      const { sets, rights } = await reader.transaction(
        { url: asLocker },
        "rollback",
        async (tx) => {
          const sets = await readProviderLocks(
            tx,
            "postgres",
            PROVIDER_LOCKS.supabase
          )
          // Транзакція жива: наступне читання плану проходить
          const rights = await readLockRights(tx, [
            { schema: "app", name: "t" },
          ])
          return { sets, rights }
        }
      )
      const tables = sets.flatMap((set) => set.tables)
      expect(tables).toContainEqual({ schema: "auth", name: "users" })
      expect(tables.filter((t) => t.schema === "realtime")).toEqual([])
      expect(rights).toEqual(new Map([[tableKey("app", "t"), true]]))
    })
  })

  // Послідовно: тримач блокування й очікування на ньому чутливі до часу й
  // сторонніх сесій
  it(
    "refuses before the locks when the provider list changed after the plan",
    { concurrent: false },
    async () => {
      await inTarget(BASE, async (url) => {
        // План побудовано з переліком, де таблиця ще є; на цілі її вже немає
        const plan = await planFor(url, [ALTER_T])
        expect(
          plan.providerLocks.some((set) =>
            set.tables.some((t) => t.name === "audit_log_entries")
          )
        ).toBe(true)
        await query(
          asSuperuser(url),
          "drop table auth.audit_log_entries cascade"
        )
        // Читач `app.t` конфліктує з ACCESS EXCLUSIVE: спроба замка чекала б
        const reader = await holder(
          url,
          "begin; lock table app.t in access share mode"
        )
        try {
          const outcome = await executePlan(apply, { url }, plan, {
            ...options,
            timeouts: { lockTimeoutMs: 15_000 },
          })
          expect(outcome).toMatchObject({
            status: "refused",
            attempts: 1,
            diagnostics: [
              {
                code: "apply.target-changed",
                params: { sections: "providerLocks" },
              },
            ],
          })
        } finally {
          await reader.query("rollback")
          await reader.end()
        }
        expect(await ledger(url)).toEqual([])
      })
    }
  )
})
