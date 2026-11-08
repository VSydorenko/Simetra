import pg from "pg"
import { describe, expect, it } from "vitest"
import {
  runTag,
  runTagOf,
  testDatabaseUrl,
} from "../../../simetra/test/support"
import { throughPoolerAs, withRuntimeLogin } from "./support/db"

// DB-рівень: кеш секретів ролей Supavisor видно лише на живому пулері.
// Пулер кешує секрет ролі за ім'ям, тож роль, перестворена з тим самим ім'ям
// і новим паролем, через пулер не входить (`28P01`).
describe("withRuntimeLogin", () => {
  it("two logins with the same label both enter through the pooler and stay run-tagged", async () => {
    const names: string[] = []
    for (let i = 0; i < 2; i++)
      await withRuntimeLogin(
        testDatabaseUrl(),
        [],
        async (login) => {
          const name = new URL(login).username
          names.push(name)
          expect(runTagOf("role", name)).toBe(runTag())
          const client = new pg.Client({
            connectionString: throughPoolerAs(login),
          })
          try {
            await client.connect()
            expect((await client.query("SELECT 1 AS one")).rows).toEqual([
              { one: 1 },
            ])
          } finally {
            await client.end()
          }
        },
        "runtime_cmd"
      )
    expect(new Set(names).size).toBe(2)
  })
})
