import { describe, expect, it } from "vitest"
import { platformRoleRefusals, readPlatformRoles } from "simetra/schema"
import {
  rollbackDatabase,
  testRoleName,
  testSuperuserUrl,
  withRollback,
} from "./connection"

/**
 * Шлях запису в таблицю-виняток знімка через членство: SQL застосунку
 * законно дає запис ролі `R`, а поза ним роль команд стає членом `R`.
 * Членство кластерне, тож ні компілятор, ні відбиток його не бачать; закриває
 * його форма платформної ролі — роль грантів не член жодної ролі
 * (`plan.platform-role-shape`, спека прав §7). Справжня роль команд —
 * спільна для стеку, тож кейс — на тегованих ролях у відкатній транзакції.
 */
describe("platform role membership", () => {
  it("refuses a command role that became a member of a writer role", async () => {
    const command = testRoleName("command")
    const writer = testRoleName("writer")
    // `CREATE ROLE` — лише від суперкористувача стеку; транзакцію відкочено
    await withRollback(async (client) => {
      await client.query(`CREATE ROLE ${command} NOLOGIN NOINHERIT`)
      await client.query(`CREATE ROLE ${writer} NOLOGIN`)
      await client.query(`GRANT ${writer} TO ${command}`)
      const found = await rollbackDatabase(client).transaction(
        { url: "" },
        "rollback",
        (tx) => readPlatformRoles(tx, [command])
      )
      expect(
        platformRoleRefusals([command], found, "target", []).map((d) => ({
          code: d.code,
          violation: d.params.violation,
        }))
      ).toEqual([
        {
          code: "plan.platform-role-shape",
          violation: `member-of:${writer}`,
        },
      ])
    }, testSuperuserUrl())
  })
})
