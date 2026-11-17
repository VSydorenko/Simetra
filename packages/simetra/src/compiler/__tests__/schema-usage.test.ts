import { describe, expect, it } from "vitest"
import { compile, type CompiledModel } from "simetra/compiler"
import { PLATFORM_ROLES } from "simetra/model"
import { acceptDebt, catalog, metaFiles, project, uuid } from "./helpers"

/**
 * `USAGE` на схему застосунку (платформна спека §6.7): кожному отримувачу
 * згенерованого гранту на таблицю чи функцію — на схему об'єкта, крім
 * `public` і `simetra`. Тотожна дослівна одиниця перемагає згенеровану.
 */

const USAGE_FILE = "sql/app/usage.sql"
const COMMAND = PLATFORM_ROLES.command

async function compiled(
  entries: Record<string, unknown>
): Promise<CompiledModel> {
  const result = await compile(await acceptDebt(metaFiles(entries)))
  expect(
    result.diagnostics.filter(
      (d) => d.severity === "error" && d.code !== "rights.scope-kind-unread"
    )
  ).toEqual([])
  return result.model!
}

/** Гранти схеми `schema`: SQL і чи одиниця дослівна. */
const schemaUsage = (model: CompiledModel, schema: string) =>
  model.sqlUnits
    .filter((u) => u.identity.startsWith(`grant:grant:schema:${schema}:`))
    .map((u) => ({ sql: u.sql.trim(), verbatim: u.file !== undefined }))
    .sort((a, b) => a.sql.localeCompare(b.sql))

describe("USAGE on the application schema", () => {
  it("is generated for the roles the kind grants its tables to", async () => {
    const model = await compiled({
      "project.meta.json": project({ defaultSchema: "app" }),
      "catalogs/Item/Item.meta.json": catalog("Item", { scope: "none" }),
      "catalogs/Region/Region.meta.json": catalog("Region", {
        id: uuid(7002),
        scope: "none",
        publicRead: "anon",
      }),
    })
    expect(schemaUsage(model, "app")).toEqual(
      [
        { sql: "GRANT USAGE ON SCHEMA app TO anon;", verbatim: false },
        { sql: "GRANT USAGE ON SCHEMA app TO authenticated;", verbatim: false },
        { sql: `GRANT USAGE ON SCHEMA app TO ${COMMAND};`, verbatim: false },
      ].sort((a, b) => a.sql.localeCompare(b.sql))
    )
    expect(
      model.sqlUnits.find((u) =>
        u.identity.startsWith("grant:grant:schema:app:")
      )?.generator
    ).toBe("schemaUsage")
  })

  it("is generated for a schema that holds only functions the platform grants", async () => {
    // Функцію множини скоупу виконують ролі запиту, сервісна й команд: без
    // `USAGE` на її схему політика від імені запиту її не викличе
    const model = await compiled({
      "project.meta.json": project({
        scopeKinds: [
          {
            id: uuid(9001),
            name: "org",
            physicalName: "org_id",
            root: { object: { kind: "Catalog", name: "Organization" } },
            setFunction: { schema: "scopes", name: "my_orgs" },
          },
        ],
      }),
      "catalogs/Organization/Organization.meta.json": catalog("Organization", {
        scope: "org",
      }),
    })
    expect(schemaUsage(model, "scopes").map((g) => g.sql)).toEqual(
      [
        "GRANT USAGE ON SCHEMA scopes TO authenticated;",
        "GRANT USAGE ON SCHEMA scopes TO service_role;",
        `GRANT USAGE ON SCHEMA scopes TO ${COMMAND};`,
      ].sort()
    )
  })

  it("leaves public and simetra to their own grants", async () => {
    // Таблиці виду в `public`, функції платформного шару в `simetra` з
    // `GRANT EXECUTE` ролям запиту: генератор `USAGE` на жодну з них не дає
    const model = await compiled({
      "project.meta.json": project({ defaultSchema: "public" }),
      "catalogs/Item/Item.meta.json": catalog("Item", { scope: "none" }),
      "catalogs/Users/Users.meta.json": catalog("Users", {
        id: uuid(7003),
        role: "users",
        scope: "none",
      }),
    })
    const granted = (schema: string) =>
      model.sqlUnits.some(
        (u) =>
          u.file === undefined &&
          u.class === "grant" &&
          u.identity.startsWith("grant:grant:") &&
          u.name.startsWith(`${schema}.`)
      )
    expect(granted("public")).toBe(true)
    expect(granted("simetra")).toBe(true)
    expect(model.sqlUnits.filter((u) => u.generator === "schemaUsage")).toEqual(
      []
    )
  })

  it.each([
    ["an identical copy", "GRANT USAGE ON SCHEMA app TO authenticated;"],
    [
      "a copy with GRANT OPTION",
      "GRANT USAGE ON SCHEMA app TO authenticated WITH GRANT OPTION;",
    ],
  ])(
    "keeps %s of the generated grant as the application's single unit",
    async (_name, sql) => {
      const model = await compiled({
        "project.meta.json": project({ defaultSchema: "app" }),
        "catalogs/Item/Item.meta.json": catalog("Item", { scope: "none" }),
        [USAGE_FILE]: `${sql}\n`,
      })
      const units = model.sqlUnits.filter(
        (u) => u.identity === "grant:grant:schema:app:authenticated:usage"
      )
      expect(units.map((u) => [u.file, `${u.sql.trim()};`])).toEqual([
        [USAGE_FILE, sql],
      ])
    }
  )

  it("gives the same model hash with the generated grants and with their identical verbatim copy", async () => {
    // Гарантія переходу: база, застосована з дослівним грантом, і модель, де
    // його дає платформа, мають той самий знімок — план порожній
    const entries = {
      "project.meta.json": project({ defaultSchema: "app" }),
      "catalogs/Item/Item.meta.json": catalog("Item", { scope: "none" }),
    }
    const generated = await compiled(entries)
    const verbatim = await compiled({
      ...entries,
      [USAGE_FILE]: `GRANT USAGE ON SCHEMA app TO authenticated;\nGRANT USAGE ON SCHEMA app TO ${COMMAND};\n`,
    })
    expect(
      verbatim.sqlUnits.filter((u) => u.generator === "schemaUsage")
    ).toEqual([])
    expect(verbatim.hash).toBe(generated.hash)
  })
})
