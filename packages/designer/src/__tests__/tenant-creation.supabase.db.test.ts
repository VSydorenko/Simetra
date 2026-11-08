import { afterAll, beforeAll, describe } from "vitest"
import {
  GLOBAL_FOUNDER_ID,
  TENANT_OPERATOR_ID,
  policyDomain,
  tenantOperator,
  tenantSelfService,
} from "../../../simetra/test/support"

import {
  type Env,
  heldEnv,
  parallelCases,
  POOLER_PORT,
  seedGlobal,
  type Targets,
  throughCases,
} from "./tenant-creation.support"

/**
 * Створення тенанта через `runtime.run` і пулер Supavisor у режимі
 * транзакцій: пулер міняє серверне з'єднання між командами (спека П4 §7.3).
 * Ті самі кейси, що й прямим портом у `tenant-creation.db.test.ts`; спільна
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

  describe.each([POOLER_PORT])("through %s", (_, port) => {
    throughCases(target, port)
  })

  // Чутливий до часу й чужих сесій сценарій — окремо й послідовно
  describe.each([POOLER_PORT])(
    "parallel tenant creation through %s",
    (_, port) => {
      parallelCases(target, port)
    }
  )
})
