import { describe, expect, it } from "vitest"
import { compile } from "simetra/compiler"
import type { PhysicalTable } from "simetra/model"
import {
  attribute,
  catalog,
  document,
  metaFiles,
  organization,
  project,
  scopedProject,
  uuid,
} from "./helpers"

const USERS_FILE = "catalogs/Users/Users.meta.json"
const USERS_SQL = "catalogs/Users/Users.sql"

function usersCatalog(overrides: Record<string, unknown> = {}) {
  return catalog("Users", { id: uuid(70), role: "users", ...overrides })
}

async function compileOk(entries: Record<string, unknown>) {
  const result = await compile(
    metaFiles({ "project.meta.json": project(), ...entries })
  )
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
  return result.model!
}

function tableOf(physical: { tables: PhysicalTable[] }, name: string) {
  const table = physical.tables.find(
    (t) => t.schema === "public" && t.name === name
  )
  expect(table, name).toBeDefined()
  return table!
}

describe("users catalog role", () => {
  it("a users catalog gets user_kind and invalid", async () => {
    const { physical } = await compileOk({ [USERS_FILE]: usersCatalog() })
    const users = tableOf(physical, "users")
    expect(users.columns).toContainEqual(
      expect.objectContaining({
        name: "user_kind",
        type: "text",
        notNull: true,
        default: "'human'",
      })
    )
    expect(users.columns).toContainEqual(
      expect.objectContaining({
        name: "invalid",
        type: "boolean",
        notNull: true,
        default: "false",
      })
    )
    expect(users.checks).toContainEqual(
      expect.objectContaining({
        expression: "user_kind IN ('human', 'agent')",
      })
    )
  })

  it("a plain catalog has no platform user columns", async () => {
    const { physical } = await compileOk({
      "catalogs/Item/Item.meta.json": catalog("Item"),
    })
    const names = tableOf(physical, "item").columns.map((c) => c.name)
    expect(names).not.toContain("user_kind")
    expect(names).not.toContain("invalid")
  })

  it("an own attribute named like a platform one is reserved", async () => {
    const result = await compile(
      metaFiles({
        "project.meta.json": project(),
        [USERS_FILE]: usersCatalog({
          attributes: [attribute("invalid")],
        }),
      })
    )
    expect(result.diagnostics.map((d) => d.code)).toContain(
      "identity.name-reserved"
    )
  })

  const own = (overrides: Record<string, unknown>) =>
    usersCatalog({
      attributes: [
        attribute("nickname", { type: "String", length: 20, ...overrides }),
      ],
    })

  it.each<[string, Record<string, unknown>, string, string, string?]>([
    [
      "two users catalogs",
      {
        "catalogs/Staff/Staff.meta.json": catalog("Staff", { role: "users" }),
        [USERS_FILE]: usersCatalog(),
      },
      "users.catalog-duplicate",
      `${USERS_FILE} /role`,
    ],
    [
      "scoped users catalog",
      {
        "project.meta.json": scopedProject(),
        "catalogs/Organization/Organization.meta.json": organization(),
        [USERS_FILE]: usersCatalog({ scope: "org" }),
      },
      "users.scope-not-none",
      `${USERS_FILE} /scope`,
    ],
    [
      "descriptionLength 0",
      { [USERS_FILE]: usersCatalog({ descriptionLength: 0 }) },
      "users.description-required",
      `${USERS_FILE} /descriptionLength`,
    ],
    [
      "own required attribute without defaultValue",
      { [USERS_FILE]: own({ required: true }) },
      "users.provision-unsafe",
      `${USERS_FILE} /attributes/0`,
      "requiredWithoutDefault",
    ],
    [
      "own unique attribute with defaultValue",
      { [USERS_FILE]: own({ unique: true, defaultValue: "anon" }) },
      "users.provision-unsafe",
      `${USERS_FILE} /attributes/0`,
      "uniqueWithDefault",
    ],
    [
      'required string with defaultValue ""',
      { [USERS_FILE]: own({ required: true, defaultValue: "" }) },
      "users.provision-unsafe",
      `${USERS_FILE} /attributes/0`,
      "defaultViolatesCheck",
    ],
    [
      "defaultValue not matching pattern",
      { [USERS_FILE]: own({ pattern: "^[a-z]+$", defaultValue: "Anon1" }) },
      "users.provision-unsafe",
      `${USERS_FILE} /attributes/0`,
      "defaultViolatesCheck",
    ],
    [
      "defaultValue shorter than minLength",
      { [USERS_FILE]: own({ minLength: 5, defaultValue: "anon" }) },
      "users.provision-unsafe",
      `${USERS_FILE} /attributes/0`,
      "defaultViolatesCheck",
    ],
    [
      "defaultValue below minValue",
      {
        [USERS_FILE]: usersCatalog({
          attributes: [
            attribute("level", {
              type: "Numeric",
              precision: 10,
              scale: 2,
              minValue: "1.5",
              defaultValue: "1.25",
            }),
          ],
        }),
      },
      "users.provision-unsafe",
      `${USERS_FILE} /attributes/0`,
      "defaultViolatesCheck",
    ],
    [
      "positive attribute with defaultValue 0",
      {
        [USERS_FILE]: usersCatalog({
          attributes: [
            attribute("level", {
              type: "Integer",
              positive: true,
              defaultValue: 0,
            }),
          ],
        }),
      },
      "users.provision-unsafe",
      `${USERS_FILE} /attributes/0`,
      "defaultViolatesCheck",
    ],
    [
      "row rule in the users module",
      {
        [USERS_FILE]: usersCatalog(),
        [USERS_SQL]:
          "ALTER TABLE public.users ADD CONSTRAINT users_named CHECK (description IS NOT NULL);",
      },
      "users.provision-unsafe",
      `${USERS_SQL} `,
      "rowRule",
    ],
  ])("%s is an error", async (_title, entries, code, at, reason) => {
    const result = await compile(
      metaFiles({ "project.meta.json": project(), ...entries })
    )
    const found = result.diagnostics.filter((d) => d.code === code)
    expect(found.map((d) => `${d.file} ${d.pointer}`)).toEqual([at])
    expect(found[0]!.severity).toBe("error")
    if (reason !== undefined) expect(found[0]!.params?.reason).toBe(reason)
  })

  it("own attributes safe for provisioning pass", async () => {
    await compileOk({
      [USERS_FILE]: usersCatalog({
        attributes: [
          attribute("nickname", {
            type: "String",
            length: 20,
            required: true,
            pattern: "^[a-z]+$",
            minLength: 3,
            defaultValue: "anon",
          }),
          attribute("badge", { type: "String", length: 10, unique: true }),
          attribute("level", {
            type: "Integer",
            required: true,
            positive: true,
            maxValue: 10,
            defaultValue: 1,
          }),
        ],
      }),
    })
  })

  it("contracts.users describes the table", async () => {
    const { contracts } = await compileOk({
      [USERS_FILE]: usersCatalog({ descriptionLength: 80 }),
    })
    expect(contracts.users).toEqual({
      objectId: uuid(70),
      table: { schema: "public", name: "users" },
      keyColumn: "id",
      descriptionColumn: "description",
      descriptionLength: 80,
      invalidColumn: "invalid",
      userKindColumn: "user_kind",
    })
  })

  it("no users catalog — no contracts.users", async () => {
    const { contracts } = await compileOk({
      "catalogs/Item/Item.meta.json": catalog("Item"),
    })
    expect(contracts.users).toBeUndefined()
  })
})

describe("trackAuthor", () => {
  const SALE = "documents/Sale/Sale.meta.json"

  it("trackAuthor adds created_by_id and updated_by_id referencing users", async () => {
    const { physical } = await compileOk({
      [USERS_FILE]: usersCatalog(),
      [SALE]: document("Sale", { trackAuthor: true }),
    })
    const sale = tableOf(physical, "sale")
    expect(
      sale.columns
        .filter((c) => c.name.endsWith("_by_id"))
        .map((c) => [c.name, c.type, c.notNull])
    ).toEqual([
      ["created_by_id", "uuid", false],
      ["updated_by_id", "uuid", false],
    ])
    for (const column of ["created_by_id", "updated_by_id"]) {
      expect(sale.foreignKeys).toContainEqual(
        expect.objectContaining({
          columns: [column],
          references: { schema: "public", table: "users", columns: ["id"] },
          onDelete: "noAction",
        })
      )
      expect(sale.indexes).toContainEqual(
        expect.objectContaining({ keys: [{ column }] })
      )
    }
  })

  it("a catalog tracks authorship too, and without the flag there are no author columns", async () => {
    const { physical } = await compileOk({
      [USERS_FILE]: usersCatalog(),
      "catalogs/Item/Item.meta.json": catalog("Item", { trackAuthor: true }),
      [SALE]: document("Sale"),
    })
    const names = (table: string) =>
      tableOf(physical, table).columns.map((c) => c.name)
    expect(names("item")).toEqual(
      expect.arrayContaining(["created_by_id", "updated_by_id"])
    )
    expect(names("sale")).not.toContain("created_by_id")
    expect(names("users")).not.toContain("created_by_id")
  })

  it("trackAuthor without a users catalog is an error", async () => {
    const result = await compile(
      metaFiles({
        "project.meta.json": project(),
        [SALE]: document("Sale", { trackAuthor: true }),
      })
    )
    const found = result.diagnostics.filter(
      (d) => d.code === "users.catalog-missing"
    )
    expect(found.map((d) => `${d.file} ${d.pointer}`)).toEqual([
      `${SALE} /trackAuthor`,
    ])
    expect(found[0]!.severity).toBe("error")
  })
})
