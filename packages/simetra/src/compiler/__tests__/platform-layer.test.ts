import { describe, expect, it } from "vitest"
import { compile, type CompiledModel } from "simetra/compiler"
import {
  PLATFORM_SCHEMA,
  PROVIDER_IDENTITY_SOURCES,
  type IdentitySource,
} from "simetra/model"
import { buildPlatformUnits } from "../platform/units"
import { loadSqlParser } from "../sql/parse"
import {
  acceptDebt,
  catalog,
  customTable,
  document,
  metaFiles,
  project,
  uuid,
} from "./helpers"

/**
 * Платформний шар схеми `simetra` (спека користувачів §3–§5, спека П2 §8.3):
 * похідна таблиця `identities` довідника «Користувачі» й згенеровані одиниці
 * шару. Вимикач — довідник із роллю «користувачі».
 */

const USERS_ID = uuid(70)
const USERS_FILE = "catalogs/Users/Users.meta.json"

async function compileOk(
  entries: Record<string, unknown>
): Promise<CompiledModel> {
  const result = await compile(
    metaFiles({
      "project.meta.json": project({ defaultSchema: "app" }),
      ...entries,
    })
  )
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
  return result.model!
}

function withUsers(entries: Record<string, unknown> = {}) {
  return compileOk({
    [USERS_FILE]: catalog("Users", {
      id: USERS_ID,
      role: "users",
      scope: "none",
    }),
    ...entries,
  })
}

const platformUnits = (model: CompiledModel) =>
  model.sqlUnits.filter((u) => u.ownerObjectId === USERS_ID)

function unit(model: CompiledModel, identity: string) {
  const found = model.sqlUnits.find((u) => u.identity === identity)
  expect(found, identity).toBeDefined()
  return found!
}

const CURRENT_USER = "function:simetra.current_user_id()"
const PROVISION = "function:simetra.provision_user(text,text,uuid,text)"
const ON_CREATED = "function:simetra.on_auth_user_created()"
const ON_REMOVED = "function:simetra.on_auth_user_removed()"
const FUNCTIONS = [CURRENT_USER, PROVISION, ON_CREATED, ON_REMOVED]

describe("platform layer", () => {
  it("no users catalog — no platform layer", async () => {
    const model = await compileOk({
      "catalogs/Currency/Currency.meta.json": catalog("Currency"),
    })
    expect(model.physical.tables.map((t) => t.schema)).not.toContain(
      PLATFORM_SCHEMA
    )
    expect(
      model.sqlUnits.filter(
        (u) => u.schema === PLATFORM_SCHEMA || u.sql.includes(PLATFORM_SCHEMA)
      )
    ).toEqual([])
  })

  it("identities is a derived table of the users catalog", async () => {
    const model = await withUsers()
    const t = model.physical.tables.find(
      (t) => t.schema === PLATFORM_SCHEMA && t.name === "identities"
    )!
    expect(t).toBeDefined()
    expect(t.origin).toEqual({ objectId: USERS_ID, part: "identities" })
    expect(t.columns.map((c) => [c.name, c.type, c.notNull])).toEqual([
      ["provider", "text", true],
      ["subject", "text", true],
      ["user_id", "uuid", true],
    ])
    expect(t.primaryKey!.columns).toEqual(["provider", "subject"])
    expect(t.uniques.map((u) => u.columns)).toContainEqual([
      "user_id",
      "provider",
    ])
    expect(t.foreignKeys).toEqual([
      expect.objectContaining({
        columns: ["user_id"],
        references: { schema: "app", table: "users", columns: ["id"] },
        deferrable: "initiallyDeferred",
      }),
    ])
  })

  it("schema grants: REVOKE ALL FROM PUBLIC, USAGE for API roles only", async () => {
    const model = await withUsers()
    const schemaGrants = platformUnits(model)
      .filter((u) => u.class === "grant" && u.sql.includes("ON SCHEMA"))
      .map((u) => u.sql)
      .sort()
    expect(schemaGrants).toEqual([
      "GRANT USAGE ON SCHEMA simetra TO anon;",
      "GRANT USAGE ON SCHEMA simetra TO authenticated;",
      "GRANT USAGE ON SCHEMA simetra TO service_role;",
      "REVOKE ALL ON SCHEMA simetra FROM PUBLIC;",
    ])
  })

  it("every platform function is SECURITY DEFINER, empty search_path, no PUBLIC execute", async () => {
    const model = await withUsers()
    const functions = platformUnits(model).filter((u) => u.class === "function")
    expect(functions.map((u) => u.identity).sort()).toEqual(
      [...FUNCTIONS].sort()
    )
    for (const fn of functions) {
      expect(fn.schema).toBe(PLATFORM_SCHEMA)
      expect(fn.file).toBeUndefined()
      expect(fn.sql).toContain("SECURITY DEFINER")
      expect(fn.sql).toContain("SET search_path = ''")
      const signature = fn.identity.slice("function:".length)
      expect(
        platformUnits(model).some(
          (u) =>
            u.class === "grant" &&
            u.sql ===
              `REVOKE EXECUTE ON FUNCTION ${signature.replace(/\(.*\)$/, "")}(${fnArgs(fn.sql)}) FROM PUBLIC;`
        ),
        fn.identity
      ).toBe(true)
    }
    // Тригерні функції й провізію кличе лише тригер чи платформа: жодна роль
    // API їх не виконує.
    const executable = platformUnits(model)
      .filter((u) => u.class === "grant" && u.sql.startsWith("GRANT EXECUTE"))
      .map((u) => u.sql)
      .sort()
    expect(executable).toEqual([
      "GRANT EXECUTE ON FUNCTION simetra.current_user_id() TO anon;",
      "GRANT EXECUTE ON FUNCTION simetra.current_user_id() TO authenticated;",
      "GRANT EXECUTE ON FUNCTION simetra.current_user_id() TO service_role;",
    ])
    // Типові привілеї провайдера теж відкликано: провізію не виконує жодна
    // роль API, функцію сесії — кожна роль API (сервісна отримує `NULL`).
    const revokedFrom = (identity: string) =>
      platformUnits(model)
        .filter(
          (u) =>
            u.class === "grant" &&
            u.sql.startsWith("REVOKE EXECUTE") &&
            u.sql.includes(
              identity.slice("function:simetra.".length, identity.indexOf("("))
            )
        )
        .map((u) => u.sql.slice(u.sql.lastIndexOf(" FROM ") + 6, -1))
        .sort()
    expect(revokedFrom(PROVISION)).toEqual([
      "PUBLIC",
      "anon",
      "authenticated",
      "service_role",
    ])
    expect(revokedFrom(CURRENT_USER)).toEqual(["PUBLIC"])
  })

  it("current_user_id reads sub of the claims and skips invalid users", async () => {
    const model = await withUsers()
    const { sql } = unit(model, CURRENT_USER)
    expect(sql).toContain("LANGUAGE plpgsql STABLE SECURITY DEFINER")
    expect(sql).toContain(
      "nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'"
    )
    expect(sql).toContain("FROM simetra.identities i")
    expect(sql).toContain("JOIN app.users u ON u.id = i.user_id")
    expect(sql).toContain("i.provider = 'supabase'")
    expect(sql).toContain("NOT u.invalid")
  })

  it("kind_labels lists every labelled object in C collation", async () => {
    const model = await withUsers({
      "documents/Sale/Sale.meta.json": document("Sale", {
        id: uuid(71),
        kindLabel: "sale",
      }),
    })
    const view = unit(model, "view:simetra.kind_labels")
    expect(view.sql).toContain(
      "CREATE OR REPLACE VIEW simetra.kind_labels (label, kind, object_id, name, schema, table_name)"
    )
    expect(view.sql).toContain('COLLATE "C"')
    expect(view.sql).toContain(
      `('sale', 'Document', '${uuid(71)}'::uuid, 'Sale', 'app', 'sale')`
    )
    expect(view.sql).toContain(
      `('users', 'Catalog', '${USERS_ID}'::uuid, 'Users', 'app', 'users')`
    )
    // Грантів ролям застосунку на в'юху немає.
    expect(
      model.sqlUnits.filter(
        (u) => u.class === "grant" && u.sql.includes("kind_labels")
      )
    ).toEqual([])
  })

  it("kind_labels without labelled objects is typed and empty", async () => {
    // Прийнята таблиця без uuid-ключа мітки не має; «Користувачі» — має, тож
    // порожній перелік перевіряє генератор напряму.
    const parse = await loadSqlParser()
    const model = await withUsers()
    const units = buildPlatformUnits(
      {
        objects: model.objects.filter((o) => o.kind !== "Catalog"),
        physical: model.physical,
        contracts: model.contracts,
        project: model.project,
      },
      parse,
      PROVIDER_IDENTITY_SOURCES.supabase
    )
    const view = units.find((u) => u.identity === "view:simetra.kind_labels")!
    expect(view.sql).toContain('NULL::text COLLATE "C"')
    expect(view.sql).toContain("WHERE false")
  })

  it("provision truncates the display name to descriptionLength and never yields NULL", async () => {
    const model = await withUsers()
    const provision = unit(model, PROVISION).sql
    expect(provision).toContain("ON CONFLICT DO NOTHING")
    expect(provision).toContain("left(p_display_name, 150)")
    expect(provision).toContain("ON CONFLICT (id) DO NOTHING")
    const created = unit(model, ON_CREATED).sql
    expect(created).toContain("NEW.is_anonymous IS TRUE")
    expect(created).toContain(
      "nullif(btrim(NEW.raw_user_meta_data ->> 'full_name'), '')"
    )
    expect(created).toContain(
      "nullif(btrim(NEW.raw_user_meta_data ->> 'name'), '')"
    )
    expect(created).toContain("nullif(btrim(NEW.email::text), '')")
    expect(created).toContain("'user ' || left(NEW.id::text, 8)")
    const removed = unit(model, ON_REMOVED).sql
    expect(removed).toContain("DELETE FROM simetra.identities")
    expect(removed).toContain("SET invalid = true")
  })

  it("triggers on the account table: signup, anonymous conversion, delete and soft delete", async () => {
    const model = await withUsers()
    const triggers = platformUnits(model)
      .filter((u) => u.class === "trigger")
      .map((u) => u.sql)
      .sort()
    expect(triggers).toEqual([
      "CREATE TRIGGER simetra_invalidate_user AFTER DELETE ON auth.users FOR EACH ROW EXECUTE FUNCTION simetra.on_auth_user_removed();",
      "CREATE TRIGGER simetra_invalidate_user_soft_delete AFTER UPDATE OF deleted_at ON auth.users FOR EACH ROW WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL) EXECUTE FUNCTION simetra.on_auth_user_removed();",
      "CREATE TRIGGER simetra_provision_converted_user AFTER UPDATE OF is_anonymous ON auth.users FOR EACH ROW WHEN (OLD.is_anonymous IS TRUE AND NEW.is_anonymous IS NOT TRUE) EXECUTE FUNCTION simetra.on_auth_user_created();",
      "CREATE TRIGGER simetra_provision_user AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION simetra.on_auth_user_created();",
    ])
  })

  it("the provision SQL is generated from PROVIDER_IDENTITY_SOURCES, not hard-coded", async () => {
    const parse = await loadSqlParser()
    const model = await withUsers()
    const source: IdentitySource = {
      table: { schema: "idp", name: "accounts" },
      keyColumn: "account_id",
      nameSources: [{ column: "nickname" }],
      providerKey: "other-idp",
    }
    const units = buildPlatformUnits(
      {
        objects: model.objects,
        physical: model.physical,
        contracts: model.contracts,
        project: model.project,
      },
      parse,
      source
    )
    const text = units.map((u) => u.sql).join("\n")
    expect(text).toContain("ON idp.accounts")
    expect(text).toContain("NEW.account_id")
    expect(text).toContain("nullif(btrim(NEW.nickname::text), '')")
    expect(text).toContain("'other-idp'")
    for (const supabase of [
      "auth.users",
      "raw_user_meta_data",
      "email",
      "is_anonymous",
      "deleted_at",
      "'supabase'",
    ]) {
      expect(text, supabase).not.toContain(supabase)
    }
    // Без ознак анонімності й м'якого видалення — немає ні перевірки, ні тригера.
    expect(units.filter((u) => u.class === "trigger")).toHaveLength(2)
  })

  it("anonymous conversion trigger comes from the anonymity column of the source", async () => {
    // Конвертація анонімного входу — UPDATE того самого рядка, а не INSERT:
    // без цього тригера постійний користувач лишився б без провізії.
    const parse = await loadSqlParser()
    const model = await withUsers()
    const units = buildPlatformUnits(
      {
        objects: model.objects,
        physical: model.physical,
        contracts: model.contracts,
        project: model.project,
      },
      parse,
      {
        table: { schema: "idp", name: "accounts" },
        keyColumn: "account_id",
        nameSources: [{ column: "nickname" }],
        anonymousColumn: "guest",
        providerKey: "other-idp",
      }
    )
    expect(
      units
        .filter((u) => u.class === "trigger" && u.sql.includes("AFTER UPDATE"))
        .map((u) => u.sql)
    ).toEqual([
      "CREATE TRIGGER simetra_provision_converted_user AFTER UPDATE OF guest ON idp.accounts FOR EACH ROW WHEN (OLD.guest IS TRUE AND NEW.guest IS NOT TRUE) EXECUTE FUNCTION simetra.on_auth_user_created();",
    ])
  })

  it("the users catalog explains the layer", async () => {
    const { explainObject } = await import("simetra/compiler")
    const model = await withUsers()
    const e = explainObject(model, { kind: "Catalog", name: "Users" })!
    expect(e.tables.map((t) => t.part)).toEqual(["main", "identities"])
    expect(e.generatedUnits.map((u) => u.identity)).toEqual(
      expect.arrayContaining([
        CURRENT_USER,
        "view:simetra.kind_labels",
        "trigger:auth.users.simetra_provision_user",
      ])
    )
  })

  it("a verbatim trigger with the identity of a platform trigger is a duplicate", async () => {
    const result = await compile(
      await acceptDebt(
        metaFiles({
          "project.meta.json": project({ defaultSchema: "app" }),
          [USERS_FILE]: catalog("Users", {
            id: USERS_ID,
            role: "users",
            scope: "none",
          }),
          "custom-tables/Note/Note.meta.json": customTable("Note"),
          "sql/app/units.sql":
            "CREATE FUNCTION app.f() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;\n" +
            "CREATE TRIGGER simetra_provision_user AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION app.f();\n",
        })
      )
    )
    const duplicate = result.diagnostics.find(
      (d) => d.code === "sql.unit-duplicate"
    )
    expect(duplicate?.params).toMatchObject({
      identity: "trigger:auth.users.simetra_provision_user",
      first: "the platform layer of Users",
    })
  })
})

/** Типи аргументів із тексту `CREATE FUNCTION`: лише типи, без імен. */
function fnArgs(sql: string): string {
  const inside = sql.slice(sql.indexOf("(") + 1, sql.indexOf(")"))
  return inside
    .split(",")
    .map((a) => a.trim())
    .filter((a) => a !== "")
    .map((a) => a.split(/\s+/).at(-1))
    .join(", ")
}
