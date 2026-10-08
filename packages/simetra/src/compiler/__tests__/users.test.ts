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
      'unique "ignoreCase" attribute with defaultValue',
      { [USERS_FILE]: own({ unique: "ignoreCase", defaultValue: "anon" }) },
      "users.provision-unsafe",
      `${USERS_FILE} /attributes/0`,
      "uniqueWithDefault",
    ],
    [
      "unique attribute filled with now",
      {
        [USERS_FILE]: usersCatalog({
          attributes: [
            attribute("joined", {
              type: "DateTime",
              unique: true,
              defaultValue: { fill: "now" },
            }),
          ],
        }),
      },
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
      "nonNegative attribute with defaultValue -1",
      {
        [USERS_FILE]: usersCatalog({
          attributes: [
            attribute("level", {
              type: "Integer",
              nonNegative: true,
              defaultValue: -1,
            }),
          ],
        }),
      },
      "users.provision-unsafe",
      `${USERS_FILE} /attributes/0`,
      "defaultViolatesCheck",
    ],
    [
      "defaultValue above maxValue",
      {
        [USERS_FILE]: usersCatalog({
          attributes: [
            attribute("level", {
              type: "Integer",
              maxValue: 10,
              defaultValue: 11,
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

  it("a unique attribute filled with newUuid passes: every row gets its own value", async () => {
    await compileOk({
      [USERS_FILE]: usersCatalog({
        attributes: [
          attribute("token", {
            type: "UUID",
            unique: true,
            defaultValue: { fill: "newUuid" },
          }),
        ],
      }),
    })
  })

  it("a row rule in another catalog's module is not a provisioning hazard", async () => {
    const model = await compileOk({
      [USERS_FILE]: usersCatalog(),
      "catalogs/Item/Item.meta.json": catalog("Item"),
      "catalogs/Item/Item.sql":
        "ALTER TABLE public.item ADD CONSTRAINT item_named CHECK (description IS NOT NULL);",
    })
    expect(tableOf(model.physical, "item").checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "item_named" })])
    )
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

describe("users as the root of a scope kind", () => {
  const ORG = "catalogs/Organization/Organization.meta.json"
  const MEMBER = "catalogs/OrgMember/OrgMember.meta.json"
  const CP = "catalogs/Counterparty/Counterparty.meta.json"
  const SALE = "documents/Sale/Sale.meta.json"
  const PREFS = "catalogs/UserPrefs/UserPrefs.meta.json"
  const usersRef = { type: "Ref", ref: { kind: "Catalog", name: "Users" } }

  /** Види `org` (корінь — «Організація») і `user` (корінь — «Користувачі»). */
  function usersRootProject() {
    return project({
      scopeKinds: [
        {
          id: uuid(80),
          name: "org",
          physicalName: "org_id",
          root: { object: { kind: "Catalog", name: "Organization" } },
          setFunction: "membership",
        },
        {
          id: uuid(82),
          name: "user",
          physicalName: "user_id",
          root: { object: { kind: "Catalog", name: "Users" } },
          setFunction: { name: "user_ids" },
        },
      ],
    })
  }

  function files(overrides: Record<string, unknown> = {}) {
    return {
      "project.meta.json": usersRootProject(),
      [ORG]: organization(),
      [USERS_FILE]: usersCatalog({ scope: "none" }),
      [MEMBER]: catalog("OrgMember", {
        scope: "org",
        membership: { user: "user" },
        attributes: [
          attribute("user", { physicalName: "user_id", ...usersRef }),
        ],
      }),
      [CP]: catalog("Counterparty", {
        scope: "org",
        attributes: [attribute("manager", usersRef)],
      }),
      [SALE]: document("Sale", { scope: "org", trackAuthor: true }),
      [PREFS]: catalog("UserPrefs", {
        scope: "user",
        attributes: [attribute("delegate", usersRef)],
      }),
      ...overrides,
    }
  }

  it("compiles with no scope diagnostics: references to users are plain FKs", async () => {
    const result = await compile(metaFiles(files()))
    expect(result.diagnostics.map((d) => [d.code, d.file, d.pointer])).toEqual(
      []
    )
    const { physical } = result.model!
    const plainFk = (table: string, column: string) =>
      expect(tableOf(physical, table).foreignKeys).toContainEqual(
        expect.objectContaining({
          columns: [column],
          references: { schema: "public", table: "users", columns: ["id"] },
          onDelete: "noAction",
        })
      )
    plainFk("org_member", "user_id")
    plainFk("counterparty", "manager")
    plainFk("sale", "created_by_id")
    plainFk("user_prefs", "delegate")
  })

  it("a user-scoped record carries the carrier column with FK to users and UNIQUE (carrier, id)", async () => {
    const result = await compile(metaFiles(files()))
    const { physical } = result.model!
    const prefs = tableOf(physical, "user_prefs")
    expect(prefs.columns).toContainEqual(
      expect.objectContaining({ name: "user_id", type: "uuid", notNull: true })
    )
    expect(prefs.foreignKeys).toContainEqual(
      expect.objectContaining({
        columns: ["user_id"],
        references: { schema: "public", table: "users", columns: ["id"] },
      })
    )
    expect(prefs.uniques).toContainEqual(
      expect.objectContaining({ columns: ["user_id", "id"] })
    )
    const users = tableOf(physical, "users")
    expect(users.columns.map((c) => c.name)).not.toContain("user_id")
  })

  it("an ordinary unscoped catalog as root still must declare its kind", async () => {
    const result = await compile(
      metaFiles(files({ [USERS_FILE]: catalog("Users", { scope: "none" }) }))
    )
    expect(
      result.diagnostics
        .filter((d) => d.code.startsWith("scope."))
        .map((d) => [d.code, d.file, d.pointer])
    ).toEqual(
      expect.arrayContaining([["scope.root-declaration", USERS_FILE, "/scope"]])
    )
  })
})
