import {
  CommandFailure,
  runtimeCatalogSchema,
  runtimeObjectSchema,
  type CommandError,
  type Operation,
  type RuntimeAttribute,
  type RuntimeCatalog,
  type RuntimeObject,
} from "simetra/model"
import { describe, expect, it } from "vitest"
import { STARTER_KIT_SAMPLE } from "../../model/runtime/__tests__/rich-text-sample"
import { prepareInput } from "../phase"
import { prepareRead } from "../read"
import { encodeItem, encodeParam } from "../values"
import { CLIENT, ORGANIZATION } from "./harness"
import {
  ID,
  OTHER,
  catalog,
  commandObject,
  orgMember,
  rootCatalog,
  sample,
} from "./fixtures"

/**
 * Жоден шлях команди не пише колонку `RichText` без профілю (Р-B7-6): шапка
 * й рядок ТЧ (`encodeItem`, також чернетка хука), `creatorMember` — відмова
 * `rich-text-profile`; `expectedValues` профілю не має — його порівнюють зі
 * збереженим, а не пишуть.
 */

const body = (extra: Partial<RuntimeAttribute> = {}): RuntimeAttribute => ({
  name: "body",
  column: "body_col",
  pgType: "jsonb",
  castType: "jsonb",
  type: "RichText",
  required: false,
  insert: true,
  update: true,
  maxBytes: 1024 * 1024,
  ...extra,
})

/** Валідний документ, де невідомий лише вузол на глибині 3. */
const UNKNOWN_NODE = {
  type: "doc",
  content: [{ type: "blockquote", content: [{ type: "iframe" }] }],
}

const profile = (path: string) => ({
  code: "command.invalid",
  path,
  reason: "rich-text-profile",
})

const withBody = (object: RuntimeObject): RuntimeObject =>
  runtimeObjectSchema.parse({
    ...object,
    attributes: [...object.attributes, body()],
    tabularSections: object.tabularSections.map((section) => ({
      ...section,
      attributes: [...section.attributes, body()],
    })),
  })

const withObject = (
  on: RuntimeCatalog,
  id: string,
  change: (object: RuntimeObject) => RuntimeObject
): RuntimeCatalog =>
  runtimeCatalogSchema.parse({
    ...on,
    objects: on.objects.map((o) => (o.id === id ? change(o) : o)),
  })

const refusalOf = (
  on: RuntimeCatalog,
  input: unknown
): CommandError | undefined => {
  try {
    prepareInput(on, input)
  } catch (e) {
    if (e instanceof CommandFailure) return e.error
    throw e
  }
  return undefined
}

describe("RichText through encodeItem", () => {
  const object = withBody(sample)
  const create: Operation = {
    action: "create",
    object: { kind: "Catalog", name: "Sample" },
    id: ID,
  }

  it("writes a profile document in the header and a section row", () => {
    expect(
      encodeItem(object, create, {
        values: { body: STARTER_KIT_SAMPLE },
        tabularSections: { lines: [{ ref: OTHER, body: STARTER_KIT_SAMPLE }] },
      })
    ).toEqual({
      item: {
        id: ID,
        body_col: STARTER_KIT_SAMPLE,
        tabular: {
          sample_lines: [{ id: OTHER, body_col: STARTER_KIT_SAMPLE }],
        },
      },
    })
  })

  it.each<[string, Parameters<typeof encodeItem>[2], string]>([
    ["a header value", { values: { body: UNKNOWN_NODE } }, "body"],
    [
      "a tabular section value",
      { tabularSections: { lines: [{ ref: OTHER, body: UNKNOWN_NODE }] } },
      "lines.0.body",
    ],
  ])("refuses %s outside the profile", (_, draft, path) => {
    expect(encodeItem(object, create, draft)).toEqual({ error: profile(path) })
  })
})

describe("RichText through prepareInput", () => {
  it("refuses a creatorMember value outside the profile", () => {
    const on = withObject(rootCatalog, orgMember.id, withBody)
    expect(
      refusalOf(on, {
        action: "create",
        object: ORGANIZATION,
        creatorMember: { title: "Owner", body: UNKNOWN_NODE },
      })
    ).toEqual({ ...profile("creatorMember.body"), object: ORGANIZATION })
    expect(
      refusalOf(on, {
        action: "create",
        object: ORGANIZATION,
        creatorMember: { title: "Owner", body: STARTER_KIT_SAMPLE },
      })
    ).toBeUndefined()
  })

  // Збережений документ поза профілем (зміна типу, `psql`) — база CAS:
  // перевірка профілю на ній заблокувала б редагування.
  it("encodes an expectedValues document outside the profile", () => {
    const client = catalog.objects.find((o) => o.name === "Client")!
    const on = withObject(catalog, client.id, withBody)
    expect(
      refusalOf(on, {
        action: "update",
        object: CLIENT,
        id: ID,
        expectedVersion: 2,
        values: { body: STARTER_KIT_SAMPLE },
        expectedValues: { body: UNKNOWN_NODE },
      })
    ).toBeUndefined()
  })
})

describe("RichText in reads", () => {
  it("is not a where parameter", () => {
    expect(encodeParam(body(), STARTER_KIT_SAMPLE, "body")).toEqual({
      error: { code: "command.invalid", path: "body" },
    })
  })

  it("does not sort", () => {
    const NOTE = { kind: "Catalog" as const, name: "Note" }
    const on = runtimeCatalogSchema.parse({
      format: 1,
      snapshotHash: "hash-1",
      provider: "supabase",
      objects: [
        commandObject({
          name: "Note",
          table: "note",
          attributes: [body()],
        }),
      ],
    })
    expect(
      prepareRead(on, {
        object: NOTE,
        orderBy: [{ attribute: "body", direction: "asc" }],
        limit: 1,
      })
    ).toEqual({
      error: {
        code: "command.invalid",
        path: "orderBy.0.attribute",
        object: NOTE,
      },
    })
  })
})
