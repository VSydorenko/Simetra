import {
  buildRuntimeCatalog,
  compile,
  type CompiledModel,
} from "simetra/compiler"
import type { Batch, Operation } from "simetra/model"
import { beforeAll, describe, expect, it } from "vitest"
import {
  acceptDebt,
  COMMENT_FILE,
  GAUGE_LOG_FILE,
  MEMBER_FILE,
  policyDomain,
  ROLE_FILE,
  runtimeValuesLayer,
  tenantOperator,
  tenantSelfService,
} from "../../../simetra/test/support"
import { dataCommandRefusal } from "../tools/data-policy"
import { withObjectModule } from "./helpers/object-module"

const ID = "00000000-0000-4000-8000-00000000d001"
const GAUGE = { kind: "Catalog", name: "Gauge" } as const
const LOG = { kind: "Catalog", name: "GaugeLog" } as const
const ASSIGNMENTS = { kind: "Catalog", name: "OrgRoleAssignments" } as const
const ROLES = { kind: "Catalog", name: "OrgRoles" } as const
const ORGANIZATION = { kind: "Catalog", name: "Organization" } as const
const MEMBERS = { kind: "Catalog", name: "OrgMember" } as const
const BRANCH = { kind: "Catalog", name: "Branch" } as const

const create = (object: Operation["object"]): Operation => ({
  action: "create",
  object,
  id: ID,
})
// Корінь виду скоупу: id генерує T3, учасника творця задає `creatorMember`
const createRoot = (
  object: Operation["object"],
  creatorMember?: Record<string, unknown>
): Operation => ({
  action: "create",
  object,
  ...(creatorMember === undefined ? {} : { creatorMember }),
})
const update = (object: Operation["object"]): Operation => ({
  action: "update",
  object,
  id: ID,
  expectedVersion: 1,
})

async function modelOf(files: ReadonlyMap<string, string>) {
  const result = await compile(await acceptDebt(files))
  expect(result.diagnostics).toEqual([])
  return result.model!
}

// Моделі на файл: компіляція домену — найдорожча частина тесту
const models: Record<
  | "plain"
  | "module"
  | "rootCreator"
  | "tenant"
  | "tenantMemberModule"
  | "tenantOtherModule",
  CompiledModel
> = {} as never

beforeAll(async () => {
  const base = policyDomain(runtimeValuesLayer())
  models.plain = await modelOf(base)
  // Модуль — на `GaugeLog`, щоб пакет [Gauge, GaugeLog] перевіряв не лише
  // першу фазу
  models.module = await modelOf(withObjectModule(base, GAUGE_LOG_FILE))
  // Роль рівня `org` з `rootCreator`: творець організації отримує її
  models.rootCreator = await modelOf(
    policyDomain(runtimeValuesLayer(), {
      [ROLE_FILE("OrgAdmin")]: { rootCreator: true },
    })
  )
  // Модель А створення тенанта: `Organization` з творцем і довідником
  // членства `OrgMember`, `Branch` оператора без творця
  const tenant = policyDomain(
    tenantSelfService({ requiredMember: true }),
    tenantOperator()
  )
  models.tenant = await modelOf(tenant)
  models.tenantMemberModule = await modelOf(
    withObjectModule(tenant, MEMBER_FILE)
  )
  models.tenantOtherModule = await modelOf(
    withObjectModule(tenant, COMMENT_FILE)
  )
}, 60_000)

describe("dataCommandRefusal", () => {
  it.each<{
    name: string
    model: keyof typeof models
    batch: Batch
    allowRightsWrite: boolean
    expected: unknown
  }>([
    {
      name: "a plain catalog",
      model: "plain",
      batch: [update(GAUGE)],
      allowRightsWrite: false,
      expected: undefined,
    },
    {
      name: "a catalog with a module",
      model: "module",
      batch: [update(LOG)],
      allowRightsWrite: false,
      expected: {
        kind: "command",
        error: {
          code: "command.invalid",
          reason: "object-module",
          object: LOG,
        },
      },
    },
    {
      name: "a batch whose second phase has a module",
      model: "module",
      batch: [update(GAUGE), update(LOG)],
      allowRightsWrite: false,
      expected: {
        kind: "command",
        error: {
          code: "command.invalid",
          reason: "object-module",
          object: LOG,
        },
      },
    },
    {
      name: "a module even with the rights flag",
      model: "module",
      batch: [update(LOG)],
      allowRightsWrite: true,
      expected: {
        kind: "command",
        error: {
          code: "command.invalid",
          reason: "object-module",
          object: LOG,
        },
      },
    },
    {
      name: "role assignments without the rights flag",
      model: "plain",
      batch: [create(ASSIGNMENTS)],
      allowRightsWrite: false,
      expected: { kind: "rights", object: ASSIGNMENTS },
    },
    {
      name: "role assignments with the rights flag",
      model: "plain",
      batch: [create(ASSIGNMENTS)],
      allowRightsWrite: true,
      expected: undefined,
    },
    {
      name: "roles without the rights flag, after an allowed phase",
      model: "plain",
      batch: [update(GAUGE), update(ROLES)],
      allowRightsWrite: false,
      expected: { kind: "rights", object: ROLES },
    },
    {
      name: "create of a scope root with a root creator role",
      model: "rootCreator",
      batch: [create(ORGANIZATION)],
      allowRightsWrite: false,
      expected: { kind: "rights", object: ORGANIZATION },
    },
    {
      name: "create of a scope root with the rights flag",
      model: "rootCreator",
      batch: [create(ORGANIZATION)],
      allowRightsWrite: true,
      expected: undefined,
    },
    {
      name: "update of a scope root with a root creator role",
      model: "rootCreator",
      batch: [update(ORGANIZATION)],
      allowRightsWrite: false,
      expected: undefined,
    },
    {
      name: "create of a scope root without a root creator role",
      model: "plain",
      batch: [create(ORGANIZATION)],
      allowRightsWrite: false,
      expected: undefined,
    },
    {
      name: "tenant creation with creatorMember and the rights flag",
      model: "tenant",
      batch: [createRoot(ORGANIZATION, { title: "founder" })],
      allowRightsWrite: true,
      expected: undefined,
    },
    {
      name: "tenant creation with creatorMember without the rights flag",
      model: "tenant",
      batch: [createRoot(ORGANIZATION, { title: "founder" })],
      allowRightsWrite: false,
      expected: { kind: "rights", object: ORGANIZATION },
    },
    {
      name: "tenant creation when the membership catalog has a module",
      model: "tenantMemberModule",
      batch: [createRoot(ORGANIZATION, { title: "founder" })],
      allowRightsWrite: true,
      expected: {
        kind: "command",
        error: {
          code: "command.invalid",
          reason: "object-module",
          object: MEMBERS,
        },
      },
    },
    {
      name: "a second tenant creation in a batch when the membership catalog has a module",
      model: "tenantMemberModule",
      batch: [createRoot(BRANCH), createRoot(ORGANIZATION, { title: "x" })],
      allowRightsWrite: true,
      expected: {
        kind: "command",
        error: {
          code: "command.invalid",
          reason: "object-module",
          object: MEMBERS,
        },
      },
    },
    {
      name: "a second tenant creation in a batch without the rights flag",
      model: "tenant",
      batch: [createRoot(BRANCH), createRoot(ORGANIZATION, { title: "x" })],
      allowRightsWrite: false,
      expected: { kind: "rights", object: ORGANIZATION },
    },
    {
      name: "tenant creation when only an unrelated object has a module",
      model: "tenantOtherModule",
      batch: [createRoot(ORGANIZATION, { title: "founder" })],
      allowRightsWrite: true,
      expected: undefined,
    },
    {
      name: "operator root creation without a creator needs only data write",
      model: "tenantMemberModule",
      batch: [createRoot(BRANCH)],
      allowRightsWrite: false,
      expected: undefined,
    },
    {
      name: "an unknown object",
      model: "plain",
      batch: [update({ kind: "Catalog", name: "Missing" })],
      allowRightsWrite: false,
      expected: undefined,
    },
  ])("$name", ({ model, batch, allowRightsWrite, expected }) => {
    expect(
      dataCommandRefusal(
        models[model],
        buildRuntimeCatalog(models[model]),
        batch,
        { allowRightsWrite }
      )
    ).toEqual(expected)
  })
})
