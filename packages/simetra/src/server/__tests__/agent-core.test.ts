import {
  CommandFailure,
  type Batch,
  runtimeCatalogSchema,
  type RuntimeCatalog,
  type SessionClaims,
} from "simetra/model"
import { describe, expect, it } from "vitest"
import {
  AgentUnknownObject,
  AgentWriteRefused,
  agentWriteRefusal,
  createAgentCore,
  toJson,
} from "../agent"
import {
  BRANCH,
  CLIENT,
  ORGANIZATION,
  RIGHTS,
  ROLE_ASSIGNMENT,
  TICKET,
  assign,
  create,
  session,
  setup,
  setupRoots,
} from "./harness"
import { ID, catalog, rootCatalog, sample } from "./fixtures"

const OPTED_IN = { rightsWrite: true }
const NO_RIGHTS = { rightsWrite: false }

const update = (object: typeof CLIENT) =>
  ({
    action: "update",
    object,
    id: ID,
    expectedVersion: 1,
    values: { code: "B" },
  }) as const
const mark = (object: typeof CLIENT) =>
  ({
    action: "markDeletion",
    object,
    id: ID,
    expectedVersion: 1,
    mark: true,
  }) as const
const remove = (object: typeof CLIENT) =>
  ({ action: "delete", object, id: ID, expectedVersion: 1 }) as const

/** Ядро над фейковою базою: `calls` — усе, що дійшло до бази. */
async function core(
  permissions?: { rightsWrite?: boolean },
  cat: RuntimeCatalog = catalog
) {
  const env = await setup(undefined, { catalog: cat })
  return {
    ...env,
    core: createAgentCore({ runtime: env.runtime, permissions }),
  }
}

describe("agentWriteRefusal", () => {
  // І-F3-1: запис у довідник прав без дозволу — відмова до бази.
  it.each([
    ["create ролі", { action: "create", object: RIGHTS, id: ID, values: {} }],
    ["update ролі", update(RIGHTS)],
    ["markDeletion ролі", mark(RIGHTS)],
    ["create призначення", assign(ID)],
    ["update призначення", update(ROLE_ASSIGNMENT)],
    ["markDeletion призначення", mark(ROLE_ASSIGNMENT)],
    ["delete призначення", remove(ROLE_ASSIGNMENT)],
  ] as [string, Batch[number]][])("відмовляє: %s", (_, op) => {
    const refusal = agentWriteRefusal(catalog, [op], NO_RIGHTS)
    expect(refusal).toEqual({ object: op.object })
  })

  it("з дозволом пропускає запис прав", () => {
    expect(
      agentWriteRefusal(catalog, [update(RIGHTS), assign(ID)], OPTED_IN)
    ).toBeUndefined()
  })

  it("пропускає звичайний об'єкт і об'єкт поза каталогом", () => {
    expect(
      agentWriteRefusal(
        catalog,
        [update(TICKET), update({ kind: "Catalog", name: "Ghost" })],
        NO_RIGHTS
      )
    ).toBeUndefined()
  })

  // І-F3-2: пакет — одна транзакція, перевіряється кожна операція.
  it("бачить довідник прав не в першій операції пакета", () => {
    expect(
      agentWriteRefusal(catalog, [update(TICKET), update(RIGHTS)], NO_RIGHTS)
    ).toEqual({ object: RIGHTS })
    expect(
      agentWriteRefusal(
        catalog,
        [update(TICKET), update(CLIENT), mark(ROLE_ASSIGNMENT)],
        NO_RIGHTS
      )
    ).toEqual({ object: ROLE_ASSIGNMENT })
  })

  // І-F3-3: корінь із творцем змінює права, корінь без творця — ні.
  it("відмовляє create кореня з творцем, але не корінь без творця", () => {
    const withCreator = {
      action: "create",
      object: ORGANIZATION,
      values: { code: "A" },
    } as const
    const without = { ...withCreator, object: BRANCH }
    expect(agentWriteRefusal(rootCatalog, [withCreator], NO_RIGHTS)).toEqual({
      object: ORGANIZATION,
    })
    expect(agentWriteRefusal(rootCatalog, [without], NO_RIGHTS)).toBeUndefined()
    expect(
      agentWriteRefusal(rootCatalog, [withCreator], OPTED_IN)
    ).toBeUndefined()
  })

  it("update кореня з творцем права не змінює", () => {
    expect(
      agentWriteRefusal(rootCatalog, [update(ORGANIZATION)], NO_RIGHTS)
    ).toBeUndefined()
  })
})

describe("agent core execute", () => {
  it.each([
    ["create ролі", { action: "create", object: RIGHTS, id: ID, values: {} }],
    ["update ролі", update(RIGHTS)],
    ["markDeletion призначення", mark(ROLE_ASSIGNMENT)],
    ["delete призначення", remove(ROLE_ASSIGNMENT)],
  ] as [string, Batch[number]][])(
    "без дозволу відмовляє до бази: %s",
    async (_, op) => {
      const { core: c, db } = await core()
      const error = await c.execute(session, [op]).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(AgentWriteRefused)
      expect((error as AgentWriteRefused).object).toEqual(op.object)
      expect(db.calls).toEqual([])
    }
  )

  it("відмовляє пакет «звичайний об'єкт, потім довідник прав» до бази", async () => {
    const { core: c, db } = await core()
    await expect(
      c.execute(session, [update(TICKET), update(RIGHTS)])
    ).rejects.toBeInstanceOf(AgentWriteRefused)
    expect(db.calls).toEqual([])
  })

  it("create кореня з творцем без дозволу відмовляє до бази", async () => {
    const env = await setupRoots(undefined, {})
    const c = createAgentCore({ runtime: env.runtime })
    await expect(
      c.execute(session, [
        { action: "create", object: ORGANIZATION, values: { code: "A" } },
      ])
    ).rejects.toBeInstanceOf(AgentWriteRefused)
    expect(env.db.calls).toEqual([])
  })

  it("з дозволом доходить до бази й повертає JSON без bigint", async () => {
    const { core: c, db } = await core({ rightsWrite: true })
    const result = (await c.execute(session, [
      { action: "create", object: RIGHTS, id: ID, values: { code: "R" } },
    ])) as {
      rows: unknown[]
    }
    expect(db.calls.length).toBeGreaterThan(0)
    expect(result.rows).toHaveLength(1)
    expect(() => JSON.stringify(result)).not.toThrow()
  })

  it("звичайний пакет проходить без дозволу прав", async () => {
    const { core: c, db } = await core()
    await c.execute(session, [create])
    expect(db.calls.length).toBeGreaterThan(0)
  })
})

describe("agent core read", () => {
  it("помилка читання лишається CommandFailure", async () => {
    const { core: c } = await core()
    const anonymous = { ...session, sub: "" } as SessionClaims
    const error = await c
      .read(anonymous, {
        object: { kind: "Catalog", name: "Ghost" },
        limit: 1,
      })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CommandFailure)
  })
})

describe("toJson", () => {
  it("bigint — десятковий рядок на будь-якій глибині", () => {
    expect(toJson({ a: [1n, { b: 2n }], c: 3, d: null })).toEqual({
      a: ["1", { b: "2" }],
      c: 3,
      d: null,
    })
  })
})

describe("agent core describe", () => {
  it("перелічує всі об'єкти каталогу з дієсловами й операціями", async () => {
    const { core: c } = await core()
    const { objects } = c.describe() as {
      objects: {
        object: { name: string }
        verbs: string[]
        operations: string[]
      }[]
    }
    expect(objects.map((o) => o.object.name)).toEqual(
      catalog.objects.map((o) => o.name)
    )
    const client = objects.find((o) => o.object.name === "Client")!
    expect(client.verbs).toEqual(["write", "remove"])
    expect(client.operations).toEqual([
      "create",
      "update",
      "markDeletion",
      "delete",
    ])
    // Без `delete` дієслово `remove` лишається завдяки `markDeletion`
    const role = objects.find((o) => o.object.name === "RightsRole")!
    expect(role.operations).toEqual(["create", "update", "markDeletion"])
    expect(role.verbs).toEqual(["write", "remove"])
  })

  it("описує об'єкт явним переліком полів без внутрішніх фактів", async () => {
    const { core: c } = await core()
    const d = c.describe(CLIENT)
    expect(Object.keys(d).sort()).toEqual(
      [
        "attributes",
        "key",
        "kindLabel",
        "object",
        "operations",
        "tabularSections",
        "verbs",
      ].sort()
    )
    expect(d.object).toEqual(CLIENT)
    const code = d.attributes.find((a) => a.name === "code")!
    expect(code).toEqual({
      name: "code",
      type: "String",
      required: false,
      maxLength: 10,
      insert: true,
      update: true,
    })
    // Фізика й внутрішній контракт не виходять назовні
    const text = JSON.stringify(d)
    for (const secret of ["pgType", "castType", "constraints", "function"])
      expect(text).not.toContain(secret)
  })

  it("невідомий об'єкт — AgentUnknownObject з об'єктом", async () => {
    const { core: c } = await core()
    const ghost = { kind: "Catalog", name: "Ghost" } as const
    expect(() => c.describe(ghost)).toThrow(AgentUnknownObject)
    try {
      c.describe(ghost)
    } catch (e) {
      expect((e as AgentUnknownObject).object).toEqual(ghost)
    }
  })

  it("describe не торкається бази", async () => {
    const { core: c, db } = await core()
    c.describe()
    c.describe(CLIENT)
    expect(db.calls).toEqual([])
  })
})

describe("agent core JSON values", () => {
  // Понад 2^53: `Number` її не вмістить, тож лише рядок зберігає значення.
  const BIG = 9007199254740993n
  const stub = () =>
    createAgentCore({
      permissions: OPTED_IN,
      runtime: {
        catalog,
        read: async () => ({ rows: [{ big: BIG, bigs: [BIG, 1n] }] }),
        run: async () => ({
          rows: [{ big: BIG }],
          changes: [],
          epoch: "e",
        }),
      },
    })

  it("read віддає bigint точним десятковим рядком", async () => {
    expect(await stub().read(session, { object: CLIENT, id: ID })).toEqual({
      rows: [{ big: "9007199254740993", bigs: ["9007199254740993", "1"] }],
    })
  })

  it("execute віддає bigint точним десятковим рядком", async () => {
    expect(await stub().execute(session, [create])).toEqual({
      rows: [{ big: "9007199254740993" }],
      changes: [],
      epoch: "e",
    })
  })
})

describe("agent core describe allow-list", () => {
  const labelled = runtimeCatalogSchema.parse({
    ...catalog,
    objects: [
      {
        ...sample,
        title: { en: "Sample" },
        description: { en: "A sample" },
        tabularSections: [
          { ...sample.tabularSections[0], title: { en: "Lines" } },
        ],
      },
    ],
  })
  const labelledCore = () =>
    createAgentCore({
      runtime: {
        catalog: labelled,
        read: async () => ({ rows: [] }),
        run: async () => ({ rows: [], changes: [], epoch: "e" }),
      },
    })

  it("рядок переліку має рівно свої поля", () => {
    const [entry] = labelledCore().describe().objects
    expect(Object.keys(entry!).sort()).toEqual([
      "description",
      "object",
      "operations",
      "title",
      "verbs",
    ])
  })

  it("ТЧ і її реквізит мають рівно свої поля", () => {
    const d = labelledCore().describe({ kind: "Catalog", name: "Sample" })
    const [section] = d.tabularSections
    expect(Object.keys(section!).sort()).toEqual([
      "attributes",
      "name",
      "title",
    ])
    expect(Object.keys(section!.attributes[0]!).sort()).toEqual([
      "insert",
      "name",
      "required",
      "type",
      "update",
    ])
  })
})
