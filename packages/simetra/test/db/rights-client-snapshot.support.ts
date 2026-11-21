import { createHash, randomUUID } from "node:crypto"
import type pg from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  PLATFORM_LOGIN_ROLES,
  PLATFORM_ROLES,
  RIGHTS_CLIENT_SNAPSHOT_FUNCTION_NAME,
  RIGHTS_DIMENSION_VALUES_MAX,
  SESSION_CLAIMS_SETTING,
  rightsSnapshotSchema,
} from "simetra/model"
import {
  ORG_KIND_ID,
  ORG_MEMBER_ROLE_ID,
  PROJECT_LEAD_ID,
  REGION_DIMENSION_ID,
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
  inMaintenance,
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
  members: { scopeKind: string; scope: string; member: string }[]
  dimensionValues: {
    dimension: string
    values: string[]
    truncated?: true
    digest?: string
  }[]
}

const EMPTY: Snapshot = {
  userId: null,
  scopeSets: [],
  rights: [],
  members: [],
  dimensionValues: [],
}

// Порядок `uuid` у Postgres — побайтовий, і для рядків у нижньому регістрі
// він збігається з порядком рядків JS.
const sorted = (values: readonly string[]): string[] => [...values].sort()
const digestOf = (values: readonly string[]): string =>
  createHash("sha256").update(sorted(values).join(",")).digest("hex")

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

    /** Регіони понад межу значень виміру в учасника `big`. */
    const bigRegions: string[] = []

    /**
     * Організації A, B, C (C — з позначкою видалення: дослівна функція множини
     * її відсікає). `m1` — A і C з `OrgMember` і `SignalReader`; `m5` — B з
     * тими самими ролями; `m6` — A без призначень; `u9` — без членства.
     * Регіони (значення виміру `region`): `m1` — `rA`, `m5` — `rB1`, `rB2`;
     * `big` — учасник A без призначень з регіонами на 2 понад межу.
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
      const region = async (key: string, org: string, owner: string) => {
        await create(key, "region", { org_id: ids[org] })
        await insert(client, "member_region", {
          org_id: ids[org],
          member_id: ids[owner],
          region_id: ids[key],
        })
      }
      await region("rA", "A", "m1@A")
      await region("rB1", "B", "m5@B")
      await region("rB2", "B", "m5@B")
      ids.big = await signUp(client)
      await member("big", "A", false)
      for (let n = 0; n < RIGHTS_DIMENSION_VALUES_MAX + 2; n++)
        bigRegions.push(randomUUID())
      await inMaintenance(client, async () => {
        await client.query(
          "INSERT INTO public.region (id, org_id) SELECT unnest($1::uuid[]), $2",
          [bigRegions, ids.A]
        )
        await client.query(
          "INSERT INTO public.member_region (org_id, member_id, region_id) SELECT $2, $3, unnest($1::uuid[])",
          [bigRegions, ids.A, ids["big@A"]]
        )
      })
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
      for (const user of ["m1", "m5", "m6", "u9", "big", null]) {
        const { value } = await snapshot(user)
        expect(rightsSnapshotSchema.safeParse(value).success).toBe(true)
      }
    })

    it("returns the empty value without a user", async () => {
      expect((await snapshot(null)).value).toEqual(EMPTY)
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
      expect(m5.members).toEqual([
        { scopeKind: ORG_KIND_ID, scope: ids.B, member: ids["m5@B"] },
      ])
      expect(m5.dimensionValues).toEqual([
        {
          dimension: REGION_DIMENSION_ID,
          values: sorted([ids.rB1!, ids.rB2!]),
        },
      ])
      expect(m1.dimensionValues).toEqual([
        { dimension: REGION_DIMENSION_ID, values: [ids.rA] },
      ])
    })

    // Членство в C з позначкою видалення — теж «мій скоуп»: межу тенанта
    // судить `scopeSets`, а `members` — рядки `rights_my_scopes()`.
    it("lists every membership of the member in members, ordered by the full tuple", async () => {
      const { value } = await snapshot("m1")
      const rows = [
        { scopeKind: ORG_KIND_ID, scope: ids.A!, member: ids["m1@A"]! },
        { scopeKind: ORG_KIND_ID, scope: ids.C!, member: ids["m1@C"]! },
      ].sort((a, b) => (a.scope < b.scope ? -1 : 1))
      expect(value.members).toEqual(rows)
    })

    it("carries every contract dimension, empty for a user without values", async () => {
      for (const user of ["m6", "u9"]) {
        const { value } = await snapshot(user)
        expect(value.members).toEqual(
          user === "m6"
            ? [{ scopeKind: ORG_KIND_ID, scope: ids.A, member: ids["m6@A"] }]
            : []
        )
        expect(value.dimensionValues).toEqual([
          { dimension: REGION_DIMENSION_ID, values: [] },
        ])
      }
    })

    it("cuts a dimension above the cap to exactly the cap, with truncated and the digest of the full set", async () => {
      const { value } = await snapshot("big")
      expect(value.dimensionValues).toEqual([
        {
          dimension: REGION_DIMENSION_ID,
          values: sorted(bigRegions).slice(0, RIGHTS_DIMENSION_VALUES_MAX),
          truncated: true,
          digest: digestOf(bigRegions),
        },
      ])
    })

    // Значення за межею клієнт не бачить, тож його зміну несе лише `digest`.
    it("a change beyond the cap changes only the digest", async () => {
      const client = tx.client()
      const last = sorted(bigRegions).at(-1)!
      await client.query("SAVEPOINT beyond_cap")
      try {
        await inMaintenance(client, () =>
          client.query(
            "DELETE FROM public.member_region WHERE region_id = $1",
            [last]
          )
        )
        const { value } = await snapshot("big")
        const rest = bigRegions.filter((r) => r !== last)
        expect(value.dimensionValues).toEqual([
          {
            dimension: REGION_DIMENSION_ID,
            values: sorted(bigRegions).slice(0, RIGHTS_DIMENSION_VALUES_MAX),
            truncated: true,
            digest: digestOf(rest),
          },
        ])
        expect(digestOf(rest)).not.toBe(digestOf(bigRegions))
      } finally {
        await client.query("ROLLBACK TO SAVEPOINT beyond_cap")
      }
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
      expect(value.members).toEqual([])
      expect(value.dimensionValues).toEqual([])
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
