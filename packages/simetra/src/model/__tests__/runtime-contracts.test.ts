import { describe, expect, expectTypeOf, it } from "vitest"
import {
  batchSchema,
  castTypeSchema,
  defineObjectModule,
  OPERATION_EVENTS,
  operationSchema,
  readQuerySchema,
  runtimeAttributeSchema,
  runtimeCatalogSchema,
  sessionClaimsSchema,
  type ObjectModule,
} from "../runtime"

const object = { kind: "Catalog", name: "Client" } as const
const id = "0f9a3c1e-5b7d-4e2a-9c8b-1d2e3f4a5b6c"
// UUID без RFC-варіанта: Postgres його приймає, тож і контракт мусить.
const nonRfcId = "00000000-0000-0000-0000-000000000001"

describe("operationSchema", () => {
  it.each([
    ["create", { action: "create", object, id: nonRfcId, values: {} }],
    [
      "update",
      {
        action: "update",
        object,
        id,
        expectedVersion: 1,
        tabularSections: { Lines: [{ lineKey: id }] },
      },
    ],
    [
      "markDeletion",
      { action: "markDeletion", object, id, expectedVersion: 2, mark: true },
    ],
    ["delete", { action: "delete", object, id, expectedVersion: 3 }],
  ])("accepts %s", (_, input) => {
    expect(operationSchema.safeParse(input).success).toBe(true)
  })

  it.each([
    [
      "create with expectedVersion",
      { action: "create", object, id, expectedVersion: 1 },
    ],
    ["update without expectedVersion", { action: "update", object, id }],
    [
      "markDeletion without mark",
      { action: "markDeletion", object, id, expectedVersion: 1 },
    ],
    ["delete without id", { action: "delete", object, expectedVersion: 1 }],
    ["an unknown action", { action: "administerRights", object, id }],
    ["an unknown key", { action: "create", object, id, extra: 1 }],
    ["a non-UUID id", { action: "create", object, id: "client-1" }],
    ["object as a string", { action: "create", object: "Client", id }],
    [
      "a zero expectedVersion",
      { action: "delete", object, id, expectedVersion: 0 },
    ],
    // Версія поза безпечним цілим втратила б точність у JS.
    [
      "an unsafe expectedVersion",
      { action: "delete", object, id, expectedVersion: 2 ** 53 },
    ],
  ])("rejects %s", (_, input) => {
    expect(operationSchema.safeParse(input).success).toBe(false)
  })
})

describe("batchSchema", () => {
  it("rejects an empty batch", () => {
    expect(batchSchema.safeParse([]).success).toBe(false)
  })
})

describe("readQuerySchema", () => {
  it.each([
    [{ object, id }, true],
    [{ object, where: { code: "A" }, limit: 200 }, true],
    [{ object, where: {}, after: id, limit: 1 }, true],
    [{ object, id: nonRfcId }, true],
    [{ object, where: {}, after: nonRfcId, limit: 1 }, true],
    [{ object, where: {}, limit: 201 }, false],
    [{ object, where: {}, limit: 0 }, false],
  ])("parses %j as %s", (input, ok) => {
    expect(readQuerySchema.safeParse(input).success).toBe(ok)
  })
})

describe("sessionClaimsSchema", () => {
  it("rejects an empty sub", () => {
    expect(sessionClaimsSchema.safeParse({ sub: "" }).success).toBe(false)
  })

  it("keeps extra claims", () => {
    expect(
      sessionClaimsSchema.parse({ sub: id, role: "authenticated" })
    ).toEqual({ sub: id, role: "authenticated" })
  })
})

describe("castTypeSchema", () => {
  it.each([
    ["text", true],
    ["timestamp with time zone", true],
    ["numeric[]", true],
    ['"public"."OrderStatus"[]', true],
    ["text or true", false],
    ["numeric(12,2)", false],
    ["character", false],
    ['"pub"lic"."X"', false],
  ])("parses %s as %s", (input, ok) => {
    expect(castTypeSchema.safeParse(input).success).toBe(ok)
  })
})

describe("runtimeAttributeSchema", () => {
  const attribute = {
    name: "status",
    column: "status",
    pgType: "text",
    castType: "text",
    type: "Ref",
    required: false,
    insert: true,
    update: true,
  }

  it.each([
    ["the minimal form", true, attribute],
    [
      "minimal enumValues",
      true,
      { ...attribute, enumValues: [{ name: "Open", label: "open" }] },
    ],
    [
      "a minimal pair",
      true,
      {
        ...attribute,
        pair: {
          typeColumn: "status_type",
          targets: [{ object, label: "client" }],
        },
      },
    ],
    ["an unknown key", false, { ...attribute, extra: 1 }],
    ["a negative scale", false, { ...attribute, scale: -1 }],
  ])("parses %s as %s", (_, ok, input) => {
    expect(runtimeAttributeSchema.safeParse(input).success).toBe(ok)
  })
})

describe("runtimeCatalogSchema", () => {
  const catalog = {
    format: 1,
    snapshotHash: "abc",
    provider: "supabase",
    objects: [],
  }

  it("accepts format 1", () => {
    expect(runtimeCatalogSchema.safeParse(catalog).success).toBe(true)
  })

  it("rejects format 2", () => {
    expect(
      runtimeCatalogSchema.safeParse({ ...catalog, format: 2 }).success
    ).toBe(false)
  })
})

describe("object module", () => {
  it("delete raises no module event", () => {
    expect(OPERATION_EVENTS.delete).toBeUndefined()
    expect(OPERATION_EVENTS.markDeletion).toBe("write")
  })

  it("defineObjectModule returns the module itself", () => {
    const module: ObjectModule = { onWrite: () => undefined }
    expect(defineObjectModule(module)).toBe(module)
  })

  it("a typed module fits the module map", () => {
    const typed = defineObjectModule<{ code: string }>({
      beforeWrite: ({ draft }) => draft,
    })
    // Присвоєння, а не лише expectTypeOf: typecheck зламається, якщо модуль
    // типу сутності перестане вкладатися в мапу модулів host-а.
    const modules: Record<string, ObjectModule<object>> = {
      "Catalog.Client": typed,
    }
    expectTypeOf(typed).toExtend<ObjectModule<object>>()
    expect(modules["Catalog.Client"]).toBe(typed)
  })
})
