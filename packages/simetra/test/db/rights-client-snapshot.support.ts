import { randomUUID } from "node:crypto"
import type pg from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  PLATFORM_LOGIN_ROLES,
  PLATFORM_ROLES,
  RIGHTS_CLIENT_SNAPSHOT_FUNCTION_NAME,
  SESSION_CLAIMS_SETTING,
  rightsSnapshotSchema,
} from "simetra/model"
import {
  ORG_KIND_ID,
  ORG_MEMBER_ROLE_ID,
  PROJECT_LEAD_ID,
  ROLE_FILE,
  SIGNAL_READER_ID,
  SUPPORT_ID,
  compileRights,
  grant,
  objects,
  role,
  signalTopicDomain,
  singleTenantRights,
} from "../../src/compiler/__tests__/fixtures/rights"
import { signUp } from "./auth"
import {
  asRole,
  asSessionLogin,
  claimsFor,
  commandSteps,
  queryAs,
  setLocalSetting,
} from "./connection"
import { testProvider } from "./profile"
import {
  type Seed,
  assignmentRow,
  deploy,
  describeTransaction,
  insert,
  profileLayer,
} from "./rights-seed"

/**
 * `simetra.rights_client_snapshot()` на справжньому Postgres (спека П4-B
 * §9.1, Р2, Р3): які факти повертає функція під claims користувача, хто її
 * кличе, чи однаковий текст двох викликів. Одне розгортання на опис у
 * транзакції опису; кожен запит — у точці збереження помічника.
 */

const SNAPSHOT_SQL = `SELECT simetra.${RIGHTS_CLIENT_SNAPSHOT_FUNCTION_NAME}()::text AS v`

interface Row {
  object: string
  action: string
  scope: string | null
}
interface Snapshot {
  userId: string | null
  scopeSets: { scopeKind: string; scope: string }[]
  rights: Row[]
}

/**
 * `platformRoles` — чи може з'єднання тестів стати роллю команд і роллю
 * входу споживача сигналів: на Supabase вхід тестів (`postgres`) ні того, ні
 * іншого не має.
 */
export function defineRightsClientSnapshotCases(options: {
  platformRoles: boolean
}): void {
  describe("rights_client_snapshot with scope kinds", () => {
    const tx = describeTransaction()
    const ids: Seed = {}

    beforeAll(async () => {
      const result = await compileRights(signalTopicDomain(profileLayer()))
      expect(result.diagnostics).toEqual([])
      const client = await tx.open()
      await deploy(client, result.model!)
      await seed(client)
    })

    afterAll(() => tx.close())

    /**
     * Організації A, B, C (C — з позначкою видалення: дослівна функція множини
     * її відсікає). `m1` — A і C з `OrgMember` і `SignalReader`; `m5` — B з
     * тими самими ролями; `m6` — A без призначень; `u9` — без членства.
     */
    async function seed(client: pg.Client): Promise<void> {
      const create = async (
        key: string,
        table: string,
        values: Record<string, unknown> = {}
      ) => {
        ids[key] = randomUUID()
        await insert(client, table, { id: ids[key], ...values })
      }
      const member = async (user: string, org: string, withRoles: boolean) => {
        const key = `${user}@${org}`
        await create(key, "org_member", {
          org_id: ids[org],
          user_id: ids[user],
        })
        if (!withRoles) return
        for (const archetype of [ORG_MEMBER_ROLE_ID, SIGNAL_READER_ID])
          await insert(client, "org_role_assignments", {
            org_id: ids[org],
            ...assignmentRow(ids[key]!, { archetype }),
          })
      }
      for (const user of ["m1", "m5", "m6", "u9"])
        ids[user] = await signUp(client)
      await create("A", "organization")
      await create("B", "organization")
      await create("C", "organization", { deletion_mark: true })
      await member("m1", "A", true)
      await member("m1", "C", true)
      await member("m5", "B", true)
      await member("m6", "A", false)
    }

    const snapshot = async (user: string | null) => {
      const result = await queryAs<{ v: string }>(
        tx.client(),
        "user",
        user === null ? claimsFor("user") : claimsFor("user", ids[user]),
        SNAPSHOT_SQL
      )
      if ("code" in result) throw new Error(`refused: ${result.code}`)
      return { text: result.rows[0]!.v, value: JSON.parse(result.rows[0]!.v) }
    }

    it("returns a value that passes the T0 schema", async () => {
      for (const user of ["m1", "m5", "m6", "u9", null]) {
        const { value } = await snapshot(user)
        expect(rightsSnapshotSchema.safeParse(value).success).toBe(true)
      }
    })

    it("returns the empty value without a user", async () => {
      expect((await snapshot(null)).value).toEqual({
        userId: null,
        scopeSets: [],
        rights: [],
      })
    })

    it("lists the scopes of the member's tenant boundary once per kind, cutting what the verbatim set function cuts", async () => {
      const { value } = await snapshot("m1")
      expect(value.userId).toBe(ids.m1)
      expect(value.scopeSets).toEqual([
        { scopeKind: ORG_KIND_ID, scope: ids.A },
      ])
    })

    it("returns only the facts of the current user", async () => {
      const m1 = (await snapshot("m1")).value as Snapshot
      const m5 = (await snapshot("m5")).value as Snapshot
      expect(m5.userId).toBe(ids.m5)
      expect(m5.scopeSets).toEqual([{ scopeKind: ORG_KIND_ID, scope: ids.B }])
      expect(m1.rights.some((r) => r.scope === ids.B)).toBe(false)
      expect(m5.rights.some((r) => r.scope === ids.A)).toBe(false)
      expect(m1.rights.length).toBeGreaterThan(0)
    })

    it("carries the read right of a role in the member's scope", async () => {
      const { value } = await snapshot("m1")
      expect(value.rights).toContainEqual(
        expect.objectContaining({
          object: "task",
          action: "read",
          scope: ids.A,
        })
      )
    })

    it("a member without a role has a scope but no task read right", async () => {
      const { value } = await snapshot("m6")
      expect(value.scopeSets).toEqual([
        { scopeKind: ORG_KIND_ID, scope: ids.A },
      ])
      expect(
        (value as Snapshot).rights.filter(
          (r) => r.object === "task" && r.action === "read"
        )
      ).toEqual([])
    })

    it("a user without membership has no scope and no right in a scope", async () => {
      const { value } = await snapshot("u9")
      expect(value.userId).toBe(ids.u9)
      expect(value.scopeSets).toEqual([])
    })

    it("two calls return the same text", async () => {
      expect((await snapshot("m1")).text).toBe((await snapshot("m1")).text)
    })

    // Без підвищення прав: власник функції не діє, права судить роль запиту.
    it("is SECURITY INVOKER", async () => {
      const { rows } = await tx
        .client()
        .query<{ prosecdef: boolean }>(
          `SELECT prosecdef FROM pg_proc WHERE pronamespace = 'simetra'::regnamespace AND proname = '${RIGHTS_CLIENT_SNAPSHOT_FUNCTION_NAME}'`
        )
      expect(rows).toEqual([{ prosecdef: false }])
    })

    // Анонім і `PUBLIC` функції не викликають: відмова гранту, а не порожнє значення.
    it("is closed to the anonymous role", async () => {
      const client = tx.client()
      await client.query("SAVEPOINT anon_snapshot")
      const result = await (async () => {
        await asRole(client, "anonymous", claimsFor("anonymous"))
        await client.query(SNAPSHOT_SQL)
      })().then(
        () => ({ code: "allowed" }),
        (e: { code?: string; message?: string }) => ({
          code: e.code,
          message: e.message,
        })
      )
      await client.query("ROLLBACK TO SAVEPOINT anon_snapshot")
      expect(result).toEqual({
        code: "42501",
        message: `permission denied for function ${RIGHTS_CLIENT_SNAPSHOT_FUNCTION_NAME}`,
      })
    })

    if (options.platformRoles) {
      it("the command role reads the same value as the user role", async () => {
        const { completed, refusal } = await commandSteps(
          tx.client(),
          claimsFor("user", ids.m1),
          [{ sql: SNAPSHOT_SQL, params: [] }]
        )
        expect(refusal).toBeUndefined()
        const { rows } = completed[0] as { rows: { v: string }[] }
        expect(rows[0]!.v).toBe((await snapshot("m1")).text)
      })

      it("is closed to the signal consumer with a member's claims", async () => {
        const client = tx.client()
        const consumer = await asSessionLogin(
          client,
          PLATFORM_LOGIN_ROLES.signals,
          async () => {
            await setLocalSetting(
              client,
              SESSION_CLAIMS_SETTING,
              JSON.stringify(claimsFor("user", ids.m1))
            )
            await client.query(
              `SET LOCAL ROLE ${PLATFORM_ROLES.signalConsumer}`
            )
            await client.query(SNAPSHOT_SQL)
          }
        ).then(
          () => ({ code: "allowed" }),
          (e: { code?: string }) => ({ code: e.code })
        )
        expect(consumer).toEqual({ code: "42501" })
      })
    }
  })

  describe("rights_client_snapshot without scope kinds and rights catalogs", () => {
    const tx = describeTransaction()
    let support = ""
    let lead = ""

    beforeAll(async () => {
      const result = await compileRights(
        singleTenantRights(
          {
            [ROLE_FILE("Support")]: role(SUPPORT_ID, "Support", "global", {
              grants: [grant(objects(["Document", "Task"]), ["read"], "any")],
            }),
          },
          testProvider()
        )
      )
      expect(result.diagnostics).toEqual([])
      const client = await tx.open()
      await deploy(client, result.model!)
      support = await signUp(client)
      lead = await signUp(client)
      const p1 = randomUUID()
      await insert(client, "project", { id: p1 })
      await insert(
        client,
        "global_role_assignments",
        assignmentRow(support, { archetype: SUPPORT_ID })
      )
      await insert(
        client,
        "global_role_assignments",
        assignmentRow(lead, { archetype: PROJECT_LEAD_ID, container: p1 })
      )
    })

    afterAll(() => tx.close())

    it("returns a global read right and no scope sets", async () => {
      const result = await queryAs<{ v: string }>(
        tx.client(),
        "user",
        claimsFor("user", support),
        SNAPSHOT_SQL
      )
      if ("code" in result) throw new Error(`refused: ${result.code}`)
      const value = JSON.parse(result.rows[0]!.v) as Snapshot
      expect(rightsSnapshotSchema.safeParse(value).success).toBe(true)
      expect(value.userId).toBe(support)
      expect(value.scopeSets).toEqual([])
      expect(value.rights).toContainEqual(
        expect.objectContaining({ object: "task", action: "read" })
      )
    })

    it("carries a container right with its container", async () => {
      const result = await queryAs<{ v: string }>(
        tx.client(),
        "user",
        claimsFor("user", lead),
        SNAPSHOT_SQL
      )
      if ("code" in result) throw new Error(`refused: ${result.code}`)
      const value = JSON.parse(result.rows[0]!.v) as {
        rights: { container: string | null }[]
      }
      expect(value.rights.some((r) => r.container !== null)).toBe(true)
    })
  })
}
