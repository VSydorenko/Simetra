import { beforeAll, describe, expect, it } from "vitest"
import type pg from "pg"
import type { CompiledModel } from "simetra/compiler"
import { renderDesiredState } from "simetra/schema"
import { signUp } from "./auth"
import { queryAs, testRoleFor, withRollback } from "./connection"
import {
  PRIVILEGES,
  SCENARIOS,
  claimsOf,
  compiled,
  hasPrivilege,
  tenant,
} from "./access.support"

/**
 * Доступ сервісної ролі провайдера до таблиць виду (платформна спека §6.7,
 * §10.5): роль є лише на стеку Supabase, і типові привілеї схеми `public`
 * дають їй усе на кожну нову таблицю — генерація мусить це зняти. Решта
 * кейсів — `access.db.test.ts`.
 */

describe.each(SCENARIOS)("kind table access in schema $schema", (scenario) => {
  const { schema } = scenario
  let model: CompiledModel
  let sql: string

  beforeAll(async () => {
    model = await compiled(scenario)
    sql = renderDesiredState(model).sql
  })

  const deploy = (client: pg.Client) => client.query(sql)

  it("unscoped table without public read: no access for service_role", async () => {
    await withRollback(async (client) => {
      await deploy(client)
      const alice = await signUp(client)
      await tenant(client, schema, alice)
      await client.query(
        `INSERT INTO ${schema}.secret (id) VALUES (gen_random_uuid())`
      )
      for (const table of ["secret", "item"]) {
        expect(
          await queryAs(
            client,
            "service",
            claimsOf("service", alice),
            `SELECT * FROM ${schema}.${table}`
          ),
          `service on ${table}`
        ).toEqual({ code: "42501" })
      }
    })
  })

  it("table privileges: nothing for service_role", async () => {
    await withRollback(async (client) => {
      await deploy(client)
      const service = testRoleFor("service")!
      expect(
        await hasPrivilege(client, service, `${schema}.currency`, "SELECT")
      ).toBe(false)
      for (const contract of model.contracts.access) {
        const table = contract.table.name
        const granted: string[] = []
        for (const privilege of PRIVILEGES)
          if (
            await hasPrivilege(client, service, `${schema}.${table}`, privilege)
          )
            granted.push(privilege)
        expect(granted, `${service} on ${table}`).toEqual([])
      }
    })
  })
})
