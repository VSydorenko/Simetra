import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  GLOBAL_FOUNDER_ID,
  TENANT_OPERATOR_ID,
  TENANT_OWNER_ID,
  policyDomain,
  tenantOperator,
  tenantSelfService,
} from "../../../simetra/test/support"
import { dataResource } from "../io/data"
import { dataCommandTool, type DataCommandData } from "../tools/data-tools"
import { invoke } from "../tools/invoke"
import { markDevelopmentDatabase } from "./support/db"

import {
  assignmentsOf,
  createOrganization,
  DIRECT_PORT,
  type Env,
  fullAccessScopes,
  heldEnv,
  parallelCases,
  seedGlobal,
  type Targets,
  throughCases,
  user,
} from "./tenant-creation.support"

/**
 * Створення тенанта через `runtime.run` (спека П4 §6.13, §7.2, §7.3) над
 * тінню рушія: транзакція `runCommand` закомічується по-справжньому, тож
 * знімок, маркер кореня й ⊆ судяться на справжньому `COMMIT`, а пулер у
 * режимі транзакцій міняє серверне з'єднання між командами — порт-фейк T3 і
 * транзакція опису simetra DB цього не дають. Дві моделі: А — самообслуговування
 * з обов'язковим реквізитом учасника й модель оператора на `Branch`; Б —
 * `Organization` створює лише `GlobalFounder`, `TenantOwner` без `fullAccess`
 * (хук членства призначає роль у межах прав творця). Кейси — прямим портом; ті
 * самі кейси через пулер — `tenant-creation.supabase.db.test.ts`, спільна
 * підготовка — `tenant-creation.support.ts`.
 */

describe("tenant creation through runtime.run", () => {
  // Модель А: «кожен користувач» створює `Organization` з `creatorMember`
  // (обов'язковий `title`), `TenantOwner` з `fullAccess` — творець;
  // `TenantOperator` створює `Branch` без творця.
  const targetA = heldEnv(
    () =>
      policyDomain(
        tenantSelfService({ requiredMember: true }),
        tenantOperator()
      ),
    "tenant_a",
    (owner) => seedGlobal(owner, { operator: TENANT_OPERATOR_ID })
  )
  // Модель Б: лише `GlobalFounder` створює `Organization`; `TenantOwner` без
  // `fullAccess` адмініструє призначення в межах своїх прав.
  const targetB = heldEnv(
    () =>
      policyDomain(
        tenantSelfService({ fullAccess: false, founder: false }),
        tenantOperator()
      ),
    "tenant_b",
    (owner) => seedGlobal(owner, { founder: GLOBAL_FOUNDER_ID })
  )
  // Модель В: `TenantOwner` без `fullAccess` і без гранту на `OrgMember` —
  // рядок членства творця невидимий йому й після гранту.
  const targetC = heldEnv(
    () =>
      policyDomain(tenantSelfService({ fullAccess: false, memberRead: false })),
    "tenant_c",
    async () => ({})
  )
  let a: Env
  let b: Env
  let c: Env

  beforeAll(async () => {
    a = await targetA.open()
    b = await targetB.open()
    c = await targetC.open()
  }, 360_000)
  afterAll(async () => {
    await targetA.close()
    await targetB.close()
    await targetC.close()
  }, 60_000)

  const target: Targets = { a: () => a, b: () => b, c: () => c }

  describe.each([DIRECT_PORT])("through %s", (_, port) => {
    throughCases(target, port)
  })

  // MCP-кейс спеки П4 §6.14: `create` кореня з творцем пише членство й
  // призначення, тож `data-command` вимагає обох прапорців запису
  describe("through the MCP data-command tool", () => {
    beforeAll(() => markDevelopmentDatabase(a.url))

    const viaMcp = (creator: string, allowRightsWrite: boolean) =>
      invoke(
        dataCommandTool,
        { operations: [createOrganization({ title: "via mcp" })] },
        {
          dir: a.dir,
          readOnly: false,
          allowDatabaseWrite: false,
          allowDataWrite: true,
          allowRightsWrite,
          dryRun: false,
          confirmed: false,
          channel: "mcp",
          data: dataResource(
            { APP_DATA: a.login },
            { urlEnv: "APP_DATA", as: creator }
          ),
          dataEnv: "APP_DATA",
        }
      )

    const counts = async () =>
      (
        await a.owner.query<{ orgs: number; members: number }>(
          "SELECT (SELECT count(*) FROM public.organization)::int AS orgs, (SELECT count(*) FROM public.org_member)::int AS members"
        )
      ).rows[0]!

    it("creates a tenant with creatorMember under both write flags; without --allow-rights-write nothing is written", async () => {
      const creator = await user(a)
      const before = await counts()
      const refused = await viaMcp(creator, false)
      expect(refused.refusal?.reason).toBe("rights-write-disabled")
      expect(await counts()).toEqual(before)

      const r = await viaMcp(creator, true)
      expect(r.ok, JSON.stringify(r)).toBe(true)
      const { changes } = (
        r.data as Extract<DataCommandData, { result: unknown }>
      ).result
      expect(changes).toHaveLength(1)
      const id = changes[0]!.id
      expect(await fullAccessScopes(a, creator)).toEqual([id])
      expect(await assignmentsOf(a, id)).toEqual([
        {
          id: expect.any(String),
          user: creator,
          archetype: TENANT_OWNER_ID,
          reason: "root-creator",
          actor: creator,
        },
      ])
    })
  })

  // Чутливий до часу й чужих сесій сценарій — окремо й послідовно
  describe.each([DIRECT_PORT])(
    "parallel tenant creation through %s",
    (_, port) => {
      parallelCases(target, port)
    }
  )
})
