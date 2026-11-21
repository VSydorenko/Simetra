import { existsSync } from "node:fs"
import { describe, expect, it } from "vitest"
import {
  PLATFORM_ROLES,
  PROVIDER_API_ROLES,
  PROVIDER_OWNER_ROLES,
} from "simetra/model"
import type { ExecuteFacts } from "simetra/schema"
import { readMetadataDir } from "../io/metadata-dir"
import { extractWithExecuteFacts } from "../schema-engine/pg-delta/adapter"
import { readExecuteFacts } from "../schema-engine/execute-facts"
import {
  testProvider,
  testRoleName,
  testSuperuserUrl,
} from "../../../simetra/test/support"
import { dropRoles, query } from "./support/db"
import { seam } from "./execute-facts.seam"
import {
  call,
  ENV,
  errors,
  freshProject,
  inTarget,
  introspectInput,
  options,
  scopeOf,
  useDatabaseToolsCleanup,
} from "./database-tools.support"
import pg from "pg"

/**
 * Факти `EXECUTE` з каталогу в одному знімку з extract і запис теки класу
 * ремонту (спека декларацій функцій §5.5, Р10–Р12). Спільне для файлів обох
 * профілів: ролі профілю різні, а вимоги однакові.
 */

const DEFINER = `
  CREATE SCHEMA app;
  CREATE TABLE app.note (id uuid PRIMARY KEY);
  CREATE FUNCTION app.rpc() RETURNS int LANGUAGE sql SECURITY DEFINER
    SET search_path = '' AS $$ SELECT 1 $$;
`

/** Усі ролі профілю провайдера, що мають значення (без `null` і signalConsumer). */
const profile = (): string[] =>
  [
    ...Object.values(PROVIDER_API_ROLES[testProvider()]),
    PLATFORM_ROLES.command,
  ].filter((r): r is string => typeof r === "string")

const factOf = (facts: ExecuteFacts, name: string) =>
  facts.functions.find((f) => f.name === name)

export function describeExecuteFacts(): void {
  // Теки проєктів, які створює `freshProject`, прибираються після кожного тесту
  useDatabaseToolsCleanup()

  describe("execute facts", () => {
    it("reads the effective ACL, grantor, grant option and role facts of a function", async () => {
      await inTarget(
        `${DEFINER}
         CREATE FUNCTION app.granted() RETURNS int LANGUAGE sql SECURITY DEFINER
           SET search_path = '' AS $$ SELECT 1 $$;
         REVOKE EXECUTE ON FUNCTION app.granted() FROM PUBLIC;`,
        ["app"],
        async (url) => {
          const api = profile()[0]!
          await query(
            url,
            `GRANT EXECUTE ON FUNCTION app.granted() TO "${api}" WITH GRANT OPTION`
          )
          const { facts } = await extractWithExecuteFacts(
            { url },
            scopeOf(["app"])
          )
          // Типовий ACL: PUBLIC і власник мають EXECUTE, хоч `proacl` порожній
          const rpc = factOf(facts, "rpc")!
          expect(rpc.acl.map((a) => a.grantee)).toContain("PUBLIC")
          expect(rpc.acl.map((a) => a.grantee)).toContain(rpc.owner)
          expect(rpc.identityArguments).toBe("")
          const granted = factOf(facts, "granted")!
          expect(granted.acl.map((a) => a.grantee)).not.toContain("PUBLIC")
          expect(granted.acl.find((a) => a.grantee === api)).toEqual({
            grantee: api,
            grantor: granted.owner,
            grantable: true,
          })
          // Роль профілю, що існує, має дієвий факт; решта названа як відсутня
          for (const role of profile()) {
            if (facts.missingRoles.includes(role)) {
              expect(granted.executeByRole).not.toHaveProperty(role)
              expect(granted.schemaUsageByRole).not.toHaveProperty(role)
            } else {
              expect(typeof granted.executeByRole[role]).toBe("boolean")
              expect(typeof granted.schemaUsageByRole[role]).toBe("boolean")
            }
          }
          expect(granted.executeByRole[api]).toBe(true)
        }
      )
    })

    it("a role of the profile missing in the database gives no fact and no failure", async () => {
      await inTarget(DEFINER, ["app"], async (url) => {
        const missing = testRoleName("absent")
        const client = new pg.Client({ connectionString: url })
        await client.connect()
        try {
          const facts = await readExecuteFacts(client, scopeOf(["app"]), [
            missing,
          ])
          expect(facts.missingRoles).toEqual([missing])
          expect(factOf(facts, "rpc")!.executeByRole).toEqual({})
          expect(factOf(facts, "rpc")!.schemaUsageByRole).toEqual({})
        } finally {
          await client.end()
        }
      })
    })

    it("facts are read in the snapshot of extract, not on a separate connection", async () => {
      await inTarget(DEFINER, ["app"], async (url) => {
        const { facts } = await extractWithExecuteFacts(
          { url },
          scopeOf(["app"]),
          // Зміна іншим з'єднанням між extract і фактами: знімок її не бачить
          async () => {
            await query(url, "REVOKE EXECUTE ON FUNCTION app.rpc() FROM PUBLIC")
          }
        )
        expect(factOf(facts, "rpc")!.acl.map((a) => a.grantee)).toContain(
          "PUBLIC"
        )
        // Зміна справді відбулась: наступне читання її бачить
        const after = await extractWithExecuteFacts({ url }, scopeOf(["app"]))
        expect(
          factOf(after.facts, "rpc")!.acl.map((a) => a.grantee)
        ).not.toContain("PUBLIC")
      })
    })

    it("a quiet read has no cross-check failures, and membership with inherit gives the caller", async () => {
      const group = testRoleName("grp")
      const api = profile()[0]!
      await dropRoles(group)
      await query(testSuperuserUrl(), `create role "${group}"`)
      try {
        await inTarget(
          `${DEFINER}
           REVOKE EXECUTE ON FUNCTION app.rpc() FROM PUBLIC;
           GRANT EXECUTE ON FUNCTION app.rpc() TO "${group}";`,
          ["app"],
          async (url) => {
            const before = await extractWithExecuteFacts(
              { url },
              scopeOf(["app"])
            )
            expect(factOf(before.facts, "rpc")!.executeByRole[api]).toBe(false)
            expect(before.facts.crossCheckFailures).toEqual([])
            await query(
              testSuperuserUrl(),
              `grant "${group}" to "${api}" with inherit true`
            )
            try {
              const { facts } = await extractWithExecuteFacts(
                { url },
                scopeOf(["app"])
              )
              // Роль успадковує EXECUTE групи: виведено зі знімка, звірка згодна
              expect(factOf(facts, "rpc")!.executeByRole[api]).toBe(true)
              expect(facts.crossCheckFailures).toEqual([])
            } finally {
              await query(testSuperuserUrl(), `revoke "${group}" from "${api}"`)
            }
          }
        )
      } finally {
        await dropRoles(group)
      }
    })

    // На Supabase власник схем (`postgres`) уже член ролей API, і зворотний
    // грант утворив би цикл членства, тож випадок перевіряє профіль postgres
    it.skipIf(testProvider() === "supabase")(
      "a role that inherits the owner of a schema with the default ACL has USAGE (acldefault of the schema)",
      async () => {
        const api = profile()[0]!
        const owner = PROVIDER_OWNER_ROLES[testProvider()]
        await inTarget(DEFINER, ["app"], async (url) => {
          await query(
            testSuperuserUrl(),
            `grant "${owner}" to "${api}" with inherit true`
          )
          try {
            const { facts } = await extractWithExecuteFacts(
              { url },
              scopeOf(["app"])
            )
            expect(factOf(facts, "rpc")!.schemaUsageByRole[api]).toBe(true)
            expect(facts.crossCheckFailures).toEqual([])
          } finally {
            await query(testSuperuserUrl(), `revoke "${owner}" from "${api}"`)
          }
        })
      }
    )

    it("a change of the function ACL after the snapshot fails the cross-check", async () => {
      await inTarget(DEFINER, ["app"], async (url) => {
        const { facts } = await extractWithExecuteFacts(
          { url },
          scopeOf(["app"]),
          async () => {
            await query(url, "REVOKE EXECUTE ON FUNCTION app.rpc() FROM PUBLIC")
          }
        )
        expect(facts.crossCheckFailures.length).toBeGreaterThan(0)
        expect(facts.crossCheckFailures[0]).toMatchObject({
          name: "rpc",
          privilege: "EXECUTE",
        })
      })
    })

    it("introspect refuses with introspect.definer-acl-changed when the ACL changes during it", async () => {
      await inTarget(DEFINER, ["app"], async (url) => {
        seam.beforeFacts = async () => {
          await query(url, "REVOKE EXECUTE ON FUNCTION app.rpc() FROM PUBLIC")
        }
        try {
          const dir = await freshProject()
          const r = await call(
            "introspect",
            introspectInput,
            options(dir, { [ENV]: url })
          )
          expect(r.ok).toBe(false)
          expect(r.written).toBe(false)
          expect(r.changes).toEqual([])
          expect(errors(r).map((d) => d.code)).toContain(
            "introspect.definer-acl-changed"
          )
          expect(existsSync(dir)).toBe(false)
        } finally {
          seam.beforeFacts = undefined
        }
      })
    })

    it("introspect refuses with introspect.definer-acl-changed when a membership changes during it", async () => {
      const group = testRoleName("grp")
      const api = profile()[0]!
      await dropRoles(group)
      await query(testSuperuserUrl(), `create role "${group}"`)
      try {
        await inTarget(
          `${DEFINER}
           REVOKE EXECUTE ON FUNCTION app.rpc() FROM PUBLIC;
           GRANT EXECUTE ON FUNCTION app.rpc() TO "${group}";`,
          ["app"],
          async (url) => {
            seam.beforeFacts = async () => {
              await query(
                testSuperuserUrl(),
                `grant "${group}" to "${api}" with inherit true`
              )
            }
            try {
              const dir = await freshProject()
              const r = await call(
                "introspect",
                introspectInput,
                options(dir, { [ENV]: url })
              )
              expect(r.written).toBe(false)
              expect(errors(r).map((d) => d.code)).toContain(
                "introspect.definer-acl-changed"
              )
              expect(existsSync(dir)).toBe(false)
            } finally {
              seam.beforeFacts = undefined
              await query(testSuperuserUrl(), `revoke "${group}" from "${api}"`)
            }
          }
        )
      } finally {
        await dropRoles(group)
      }
    })

    it("a non-inherited membership gives no caller, and the cross-check agrees", async () => {
      const group = testRoleName("grp")
      const api = profile()[0]!
      await dropRoles(group)
      await query(testSuperuserUrl(), `create role "${group}"`)
      try {
        await inTarget(
          `${DEFINER}
           REVOKE EXECUTE ON FUNCTION app.rpc() FROM PUBLIC;
           GRANT EXECUTE ON FUNCTION app.rpc() TO "${group}";`,
          ["app"],
          async (url) => {
            await query(
              testSuperuserUrl(),
              `grant "${group}" to "${api}" with inherit false`
            )
            try {
              const { facts } = await extractWithExecuteFacts(
                { url },
                scopeOf(["app"])
              )
              expect(factOf(facts, "rpc")!.executeByRole[api]).toBe(false)
              expect(facts.crossCheckFailures).toEqual([])
            } finally {
              await query(testSuperuserUrl(), `revoke "${group}" from "${api}"`)
            }
          }
        )
      } finally {
        await dropRoles(group)
      }
    })

    it("a change of the schema USAGE after the snapshot fails the cross-check", async () => {
      const api = profile()[0]!
      await inTarget(DEFINER, ["app"], async (url) => {
        const { facts } = await extractWithExecuteFacts(
          { url },
          scopeOf(["app"]),
          async () => {
            await query(url, `GRANT USAGE ON SCHEMA app TO "${api}"`)
          }
        )
        expect(facts.crossCheckFailures).toContainEqual(
          expect.objectContaining({ role: api, privilege: "USAGE" })
        )
      })
    })

    it("introspect reports a USAGE change during it with privilege USAGE", async () => {
      const api = profile()[0]!
      await inTarget(DEFINER, ["app"], async (url) => {
        seam.beforeFacts = async () => {
          await query(url, `GRANT USAGE ON SCHEMA app TO "${api}"`)
        }
        try {
          const r = await call(
            "introspect",
            introspectInput,
            options(await freshProject(), { [ENV]: url })
          )
          expect(r.written).toBe(false)
          const changed = errors(r).filter(
            (d) => d.code === "introspect.definer-acl-changed"
          )
          expect(changed.map((d) => d.params?.privilege)).toContain("USAGE")
        } finally {
          seam.beforeFacts = undefined
        }
      })
    })

    it("a profile role created after the snapshot fails the cross-check", async () => {
      const late = testRoleName("late")
      await dropRoles(late)
      await inTarget(DEFINER, ["app"], async (url) => {
        const client = new pg.Client({ connectionString: url })
        await client.connect()
        try {
          await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
          await client.query("select count(*) from pg_roles")
          await query(testSuperuserUrl(), `create role "${late}"`)
          const facts = await readExecuteFacts(client, scopeOf(["app"]), [late])
          expect(facts.missingRoles).toEqual([late])
          expect(facts.crossCheckFailures).toEqual([
            {
              schema: "",
              name: "",
              identityArguments: "",
              role: late,
              privilege: "ROLE",
            },
          ])
        } finally {
          await client.query("ROLLBACK").catch(() => {})
          await client.end()
          await dropRoles(late)
        }
      })
    })

    it("leaves nothing on the target: no open transaction, no session state", async () => {
      await inTarget(DEFINER, ["app"], async (url) => {
        await extractWithExecuteFacts({ url }, scopeOf(["app"]))
        const rows = await query<{ n: string }>(
          testSuperuserUrl(),
          "select count(*)::text as n from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()",
          [new URL(url).pathname.slice(1)]
        )
        expect(rows[0]!.n).toBe("0")
      })
    })
  })

  describe("introspect of a folder with repair-class errors", () => {
    it("writes the folder when the errors are repair-class only, and a second introspect works over it", async () => {
      await inTarget(DEFINER, ["app"], async (url) => {
        const dir = await freshProject()
        const env = { [ENV]: url }
        const first = await call(
          "introspect",
          introspectInput,
          options(dir, env)
        )
        expect(first.ok).toBe(false)
        expect(first.written).toBe(true)
        expect(first.changes.length).toBeGreaterThan(0)
        expect(
          errors(first).every((d) => d.code === "sql.definer-caller-unchecked")
        ).toBe(true)
        expect(errors(first)).not.toEqual([])
        const before = await readMetadataDir(dir)
        const again = await call(
          "introspect",
          introspectInput,
          options(dir, env)
        )
        // Повторний прийом над текою з помилками класу ремонту працює й не
        // змінює її
        expect(again.written).toBe(false)
        expect(again.changes).toEqual([])
        expect(
          errors(again).every((d) => d.code === "sql.definer-caller-unchecked")
        ).toBe(true)
        expect(await readMetadataDir(dir)).toEqual(before)
        // Над текою, що не змінилась, повторний прийом справді читає базу
        // (а не відмовляє до читання): нова таблиця потрапляє в теку
        await query(url, "CREATE TABLE app.extra (id uuid PRIMARY KEY)")
        const third = await call(
          "introspect",
          introspectInput,
          options(dir, env)
        )
        expect(third.written).toBe(true)
        expect(third.changes.map((c) => c.path).join(" ")).toMatch(/extra/i)
      })
    })

    it("writes nothing when an error outside the repair class accompanies them", async () => {
      await inTarget(
        `${DEFINER}
         CREATE TABLE app.booking (
           id uuid PRIMARY KEY,
           during tstzrange NOT NULL,
           CONSTRAINT booking_no_overlap EXCLUDE USING gist (during WITH &&)
         );`,
        ["app"],
        async (url) => {
          const dir = await freshProject()
          const r = await call(
            "introspect",
            introspectInput,
            options(dir, { [ENV]: url })
          )
          expect(r.ok).toBe(false)
          expect(r.written).toBe(false)
          expect(r.changes).toEqual([])
          expect(errors(r).map((d) => d.code)).toContain(
            "engine.unrepresentable"
          )
          expect(existsSync(dir)).toBe(false)
        }
      )
    })
  })
}
