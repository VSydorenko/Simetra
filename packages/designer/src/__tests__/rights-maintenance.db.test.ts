import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { fullAccessHolderRows } from "simetra/compiler"
import {
  APPLY_ADVISORY_LOCK,
  type RightsMaintenanceRequest,
} from "simetra/schema"
import { runTool } from "../cli/command"
import { rightsMaintenanceTool } from "../tools/rights-maintenance-tool"
import {
  GLOBAL_ADMIN_ID,
  MEMBER_FOCUS,
  MEMBER_REGIONS,
  MEMBER_TITLE,
  ORG_ADMIN_ID,
  signUp,
  testSuperuserUrl,
} from "../../../simetra/test/support"
import {
  heldResource,
  query,
  seedUnderMaintenance,
  withCopy,
  withRuntimeLogin,
} from "./support/db"

import {
  asOwner,
  countOf,
  doneOf,
  ENV,
  type Env,
  globalAssignments,
  heldEnv,
  journalOf,
  maintain,
  ORG,
  refusalOf,
} from "./rights-maintenance.support"

/**
 * Інструмент обслуговування прав (спека П4 §6.12, «Поза командами») над
 * справжньою базою: режим обслуговування вирішує `session_user` справжньої
 * сесії, а запобіжники прав судять на `COMMIT` — порт-фейк unit-тестів ядра
 * цього не доводить. Розгортання одне (бажаний стан застосування й marker з
 * хешем моделі); глобальні сценарії — кожен у своїй копії: глобальний
 * `fullAccess`, раз записаний, не зняти навіть у режимі (`last-full-access`).
 * Сценарії рівня скоупу — на розгортанні, кожен у своїй організації.
 * Спільна підготовка — `rights-maintenance.support.ts`; перше глобальне
 * призначення мігратором через пулер Supavisor —
 * `rights-maintenance.supabase.db.test.ts`.
 */

describe("rights-maintenance tool over a real database", () => {
  const target = heldEnv()
  let env: Env

  beforeAll(async () => {
    env = await target.open()
  }, 180_000)
  afterAll(() => target.close(), 60_000)

  /** Дієві носії `fullAccess` рівня — тим самим SQL, що й запобіжник. */
  const holders = async (
    url: string,
    level: "global" | "scope",
    scope?: string
  ) => {
    const catalog = env.model.contracts.rightsCatalogs.find(
      (c) => c.level.level === level
    )!
    const sql = fullAccessHolderRows(
      catalog,
      env.model.contracts,
      env.model.physical,
      env.model.project.naming.attributeCase
    )
    const rows = await query<{ actor: string }>(
      url,
      scope === undefined
        ? `SELECT h.actor::text AS actor FROM (${sql}) h`
        : `SELECT h.actor::text AS actor FROM (${sql}) h WHERE h.scope = $1`,
      scope === undefined ? [] : [scope]
    )
    return rows.map((r) => r.actor).sort()
  }

  /** Копія цілі: глобальний сценарій пише те, чого не зняти. */
  const inCopy = <T>(fn: (url: string) => Promise<T>) =>
    withCopy(`template "${new URL(env.url).pathname.slice(1)}"`, (url) =>
      fn(url)
    )

  const unique = <T>(values: T[]) => {
    expect(values).toHaveLength(1)
    return values[0]!
  }

  it("first global: busy under the apply lock, then done, then not-first from the CLI", async () => {
    await inCopy(async (url) => {
      const [user, other] = await asOwner(url, async (owner) => [
        await signUp(owner),
        await signUp(owner),
      ])
      const first: RightsMaintenanceRequest = {
        action: "firstGlobalAssignment",
        user,
        role: "GlobalAdmin",
      }
      // Замок `apply` тримає інша сесія: інструмент не чекає й не пише
      await asOwner(url, async (holder) => {
        await holder.query("BEGIN")
        await holder.query(
          `SELECT pg_advisory_xact_lock(${APPLY_ADVISORY_LOCK})`
        )
        try {
          expect(refusalOf(await maintain(env.dir, url, first)).code).toBe(
            "maintenance.busy"
          )
        } finally {
          await holder.query("ROLLBACK")
        }
      })
      expect(await globalAssignments(url)).toBe(0)

      // Замок звільнено: мігратор записує перше призначення
      const done = doneOf(await maintain(env.dir, url, first))
      expect(
        await query(
          url,
          "SELECT subject::text AS subject, archetype::text AS archetype FROM public.global_role_assignments WHERE id = $1",
          [done.assignment]
        )
      ).toEqual([{ subject: user, archetype: GLOBAL_ADMIN_ID }])
      expect(await journalOf(url, done.assignment)).toEqual([
        { actor: null, reason: "maintenance", action: null },
      ])

      // Повтор — уже не перше призначення: відмова з ненульовим кодом виходу
      const again = await runTool(
        rightsMaintenanceTool,
        {
          _: [JSON.stringify({ ...first, user: other }), env.dir],
          yes: true,
          format: "json",
        },
        () => Promise.resolve(""),
        process.cwd(),
        { [ENV]: url }
      )
      expect(again.exitCode, again.stderr + again.stdout).toBe(1)
      expect(
        (JSON.parse(again.stdout) as { code: string }[]).map((d) => d.code)
      ).toEqual(["maintenance.not-first"])
      expect(await globalAssignments(url)).toBe(1)
    })
  })

  it("restore: holder-exists, then not-effective for an invalid user, then a valid user becomes the holder", async () => {
    await inCopy(async (url) => {
      const [holder, invalid, user] = await asOwner(url, async (owner) => {
        const ids = [
          await signUp(owner),
          await signUp(owner),
          await signUp(owner),
        ]
        await seedUnderMaintenance(owner, async () => {
          await owner.query(
            "INSERT INTO public.global_role_assignments (id, subject, archetype) VALUES ($1, $2, $3)",
            [randomUUID(), ids[0], GLOBAL_ADMIN_ID]
          )
        })
        return ids as [string, string, string]
      })
      const restore = (who: string): RightsMaintenanceRequest => ({
        action: "restoreGlobalFullAccess",
        user: who,
      })
      expect(refusalOf(await maintain(env.dir, url, restore(user)))).toEqual({
        code: "maintenance.holder-exists",
        params: { level: "global" },
      })

      // Носій став недійсним поза командою — дозволений виняток провізії
      await query(
        url,
        "UPDATE public.users SET invalid = true WHERE id = ANY ($1::uuid[])",
        [[holder, invalid]]
      )
      expect(await holders(url, "global")).toEqual([])
      expect(refusalOf(await maintain(env.dir, url, restore(invalid)))).toEqual(
        { code: "maintenance.not-effective", params: { user: invalid } }
      )
      expect(await globalAssignments(url)).toBe(1)

      doneOf(await maintain(env.dir, url, restore(user)))
      expect(await holders(url, "global")).toEqual([user])
    })
  })

  /** Організація-корінь і її учасники; призначення — під режимом обслуговування. */
  const seedOrg = (members: { user: string; holder?: true }[] = []) =>
    asOwner(env.url, async (owner) => {
      const org = randomUUID()
      const ids: string[] = []
      await seedUnderMaintenance(owner, async () => {
        await owner.query("INSERT INTO public.organization (id) VALUES ($1)", [
          org,
        ])
        for (const { user, holder } of members) {
          const member = randomUUID()
          ids.push(member)
          await owner.query(
            `INSERT INTO public.org_member (id, org_id, user_id, ${MEMBER_TITLE}) VALUES ($1, $2, $3, 'seeded')`,
            [member, org, user]
          )
          if (holder)
            await owner.query(
              "INSERT INTO public.org_role_assignments (id, org_id, subject, archetype) VALUES ($1, $2, $3, $4)",
              [randomUUID(), org, member, ORG_ADMIN_ID]
            )
        }
      })
      return { org, members: ids }
    })

  const users = (n: number) =>
    asOwner(env.url, async (owner) => {
      const ids: string[] = []
      for (let i = 0; i < n; i++) ids.push(await signUp(owner))
      return ids
    })

  const tenant = (
    scope: string,
    user: string,
    member?: Record<string, unknown>
  ): RightsMaintenanceRequest => ({
    action: "tenantFullAccess",
    scopeKind: ORG,
    scope,
    user,
    role: "OrgAdmin",
    ...(member === undefined ? {} : { member }),
  })

  const orgRows = async (org: string) => ({
    members: await countOf(env.url, "public.org_member WHERE org_id = $1", [
      org,
    ]),
    assignments: await countOf(
      env.url,
      "public.org_role_assignments WHERE org_id = $1",
      [org]
    ),
  })

  it("tenant: member-required without the member values, then a new member owns the scope, then holder-exists", async () => {
    const [user] = await users(1)
    const { org } = await seedOrg()

    // Обов'язковий реквізит застосунку без значення відхиляє база (`23502`)
    expect(
      refusalOf(await maintain(env.dir, env.url, tenant(org, user!)))
    ).toEqual({
      code: "maintenance.member-required",
      params: { attribute: MEMBER_TITLE },
    })
    expect(await orgRows(org)).toEqual({ members: 0, assignments: 0 })

    const done = doneOf(
      await maintain(
        env.dir,
        env.url,
        tenant(org, user!, { [MEMBER_TITLE]: "Owner" })
      )
    )
    expect(
      await query(
        env.url,
        `SELECT id::text AS id, org_id::text AS org, user_id::text AS "user", ${MEMBER_TITLE} AS title FROM public.org_member WHERE org_id = $1`,
        [org]
      )
    ).toEqual([{ id: done.member, org, user, title: "Owner" }])
    expect(await holders(env.url, "scope", org)).toEqual([user])
    expect(await journalOf(env.url, done.assignment)).toEqual([
      { actor: null, reason: "maintenance", action: null },
    ])

    expect(
      refusalOf(await maintain(env.dir, env.url, tenant(org, user!)))
    ).toEqual({
      code: "maintenance.holder-exists",
      params: { level: `scope:${ORG}` },
    })
    expect(await orgRows(org)).toEqual({ members: 1, assignments: 1 })
  })

  it("tenant restore: the sole holder became invalid, an existing member gets the role without a new member row", async () => {
    const [holder, user] = await users(2)
    const {
      org,
      members: [, member],
    } = await seedOrg([{ user: holder!, holder: true }, { user: user! }])
    await query(
      env.url,
      "UPDATE public.users SET invalid = true WHERE id = $1",
      [holder]
    )
    expect(await holders(env.url, "scope", org)).toEqual([])

    // Значення рядка наявному учаснику не застосовуються — відмова, не тихий пропуск
    expect(
      refusalOf(
        await maintain(
          env.dir,
          env.url,
          tenant(org, user!, { [MEMBER_TITLE]: "Ignored" })
        )
      )
    ).toEqual({
      code: "maintenance.invalid-member",
      params: { path: "member" },
    })
    expect(await orgRows(org)).toEqual({ members: 2, assignments: 1 })

    const done = doneOf(await maintain(env.dir, env.url, tenant(org, user!)))
    expect(done.member).toBe(member)
    expect(await orgRows(org)).toEqual({ members: 2, assignments: 2 })
    expect(await holders(env.url, "scope", org)).toEqual([user])
  })

  /** Рядок `Region` тенанта `org` — ціль посилань нового учасника. */
  const seedRegion = (org: string) =>
    asOwner(env.url, async (owner) => {
      const id = randomUUID()
      await owner.query(
        "INSERT INTO public.region (id, org_id) VALUES ($1, $2)",
        [id, org]
      )
      return id
    })

  // Масив і пара не мають FK зі скоупом: «ціль існує в тому самому скоупі»
  // судить лише згенерована перевірка рядка членства (Р-A6-12) — до першого
  // запису, тож відмова нічого не лишає.
  it.each<[string, "missing" | "foreign", string]>([
    ["an array Ref to a missing row", "missing", MEMBER_REGIONS],
    ["an array Ref to a row of another scope", "foreign", MEMBER_REGIONS],
    ["a polymorphic pair to a missing row", "missing", MEMBER_FOCUS],
    ["a polymorphic pair to a row of another scope", "foreign", MEMBER_FOCUS],
  ])("tenant: %s is invalid-member", async (_, target, attribute) => {
    const [user] = await users(1)
    const { org } = await seedOrg()
    const region =
      target === "missing"
        ? randomUUID()
        : await seedRegion((await seedOrg()).org)
    const value =
      attribute === MEMBER_REGIONS
        ? [region]
        : { type: "Catalog.Region", id: region }
    expect(
      refusalOf(
        await maintain(
          env.dir,
          env.url,
          tenant(org, user!, { [MEMBER_TITLE]: "Owner", [attribute]: value })
        )
      )
    ).toEqual({
      code: "maintenance.invalid-member",
      params: { path: attribute },
    })
    expect(await orgRows(org)).toEqual({ members: 0, assignments: 0 })
  })

  it("tenant: an array Ref and a pair to rows of the same scope pass", async () => {
    const [user] = await users(1)
    const { org } = await seedOrg()
    const region = await seedRegion(org)
    const done = doneOf(
      await maintain(
        env.dir,
        env.url,
        tenant(org, user!, {
          [MEMBER_TITLE]: "Owner",
          [MEMBER_REGIONS]: [region],
          [MEMBER_FOCUS]: { type: "Catalog.Region", id: region },
        })
      )
    )
    expect(
      await query(
        env.url,
        `SELECT ${MEMBER_REGIONS}::text[] AS regions FROM public.org_member WHERE id = $1`,
        [done.member]
      )
    ).toEqual([{ regions: [region] }])
    expect(await holders(env.url, "scope", org)).toEqual([user])
  })

  it("scope missing", async () => {
    const [user] = await users(1)
    const scope = randomUUID()
    expect(
      refusalOf(
        await maintain(
          env.dir,
          env.url,
          tenant(scope, user!, { [MEMBER_TITLE]: "Owner" })
        )
      )
    ).toEqual({ code: "maintenance.scope-missing", params: { scope } })
    expect(
      await countOf(env.url, "public.org_member WHERE user_id = $1", [user])
    ).toBe(0)
  })

  /**
   * Межа режиму на шляху інструмента: тегований суперкористувач обходить RLS і
   * гранти, не входить у `PROVIDER_LOGIN_ROLES`, але не є власником функцій
   * запобіжника, тож `session_user = current_user` у `SECURITY DEFINER` хибне.
   * Червоніє лише від цієї умови (М3). Роль кластерна — лише в
   * `beforeAll`/`afterAll`; останній блок: під мутацією запис лишився б у цілі.
   */
  describe("a superuser that is not the migrator", () => {
    const login = heldResource<string>((use) =>
      withRuntimeLogin(
        env.url,
        [],
        async (url) => {
          await query(
            testSuperuserUrl(),
            `ALTER ROLE "${new URL(url).username}" SUPERUSER`
          )
          await use(url)
        },
        "superuser"
      )
    )
    let superuser: string

    beforeAll(async () => {
      superuser = await login.open()
    }, 60_000)
    afterAll(() => login.close(), 60_000)

    it("cannot enable maintenance", async () => {
      const [user] = await users(1)
      const identity = await query<{ login: string; su: string }>(
        superuser,
        "SELECT session_user AS login, current_setting('is_superuser') AS su"
      )
      expect(unique(identity)).toEqual({
        login: new URL(superuser).username,
        su: "on",
      })
      expect(
        refusalOf(
          await maintain(env.dir, superuser, {
            action: "firstGlobalAssignment",
            user: user!,
            role: "GlobalAdmin",
          })
        )
      ).toEqual({
        code: "maintenance.refused",
        params: { reason: "rights-context" },
      })
      expect(await globalAssignments(env.url)).toBe(0)
    })
  })
})
