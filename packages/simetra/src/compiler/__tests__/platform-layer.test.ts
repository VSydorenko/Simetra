import { isDeepStrictEqual } from "node:util"
import { beforeAll, describe, expect, it } from "vitest"
import { compile, type CompiledModel } from "simetra/compiler"
import {
  PLATFORM_ROLES,
  PLATFORM_SCHEMA,
  PROVIDER_IDENTITY_SOURCES,
  SESSION_CLAIMS_SETTING,
  type IdentitySource,
} from "simetra/model"
import { buildPlatformUnits, platformSchemaGrants } from "../platform/units"
import { hasEmptySearchPath, routineLanguage } from "../sql/closed-forms"
import { loadSqlParser } from "../sql/parse"
import type { SqlUnit } from "../sql/units"
import { kitchenSink } from "./fixtures/kitchen-sink"
import {
  adoptedSourcesDomain,
  compileRights,
  withoutUsers,
  withRoles,
} from "./fixtures/rights"
import { bodyShape, loadShapeParsers, nodes, tree } from "./fixtures/sql-shape"
import {
  acceptDebt,
  attribute,
  catalog,
  customTable,
  document,
  metaFiles,
  project,
  uuid,
  withoutMechanics,
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

// Тригер механіки таблиці «Користувачі» має того самого власника, але
// належить механіці рядка (mechanics-units.test.ts), а не шару.
const platformUnits = (model: CompiledModel) =>
  withoutMechanics(model.sqlUnits).filter((u) => u.ownerObjectId === USERS_ID)

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
    // Механіка рядка лежить у `simetra` і без «Користувачів» — це не шар.
    // Шукаємо кваліфіковане ім'я: роль команд `simetra_command` — не схема.
    expect(
      withoutMechanics(model.sqlUnits).filter(
        (u) =>
          u.schema === PLATFORM_SCHEMA || u.sql.includes(`${PLATFORM_SCHEMA}.`)
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

  it("schema grants: REVOKE ALL FROM PUBLIC, USAGE for API roles and the command role only", async () => {
    const model = await withUsers()
    const schemaGrants = platformUnits(model)
      .filter((u) => u.class === "grant" && u.sql.includes("ON SCHEMA"))
      .map((u) => u.sql)
      .sort()
    expect(schemaGrants).toEqual([
      "GRANT USAGE ON SCHEMA simetra TO anon;",
      "GRANT USAGE ON SCHEMA simetra TO authenticated;",
      "GRANT USAGE ON SCHEMA simetra TO service_role;",
      `GRANT USAGE ON SCHEMA simetra TO ${PLATFORM_ROLES.command};`,
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
      `GRANT EXECUTE ON FUNCTION simetra.current_user_id() TO ${PLATFORM_ROLES.command};`,
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

  it("the command role executes current_user_id and uses the simetra schema", async () => {
    // Функції прав від ролі команд кличуть `current_user_id` (спека прав §5.1).
    const model = await withUsers()
    const grants = platformUnits(model)
      .filter((u) => u.class === "grant")
      .map((u) => u.sql)
    const command = PLATFORM_ROLES.command
    expect(grants).toContain(
      `GRANT EXECUTE ON FUNCTION simetra.current_user_id() TO ${command};`
    )
    expect(grants).not.toContain(
      `REVOKE EXECUTE ON FUNCTION simetra.current_user_id() FROM ${command};`
    )
    expect(platformSchemaGrants("supabase")).toContain(
      `GRANT USAGE ON SCHEMA simetra TO ${command};`
    )
  })

  it("generated SQL never manages the command role itself", async () => {
    // Роль кластерна (платформна спека §6.9): її створює `simetra roles`, а
    // згенерований SQL не створює, не змінює й не видає її. Таблиці їй
    // відкриває лише генератор доступу (спека П4 §6.2) і лише DML-привілеями.
    const parse = await loadSqlParser()
    const models = [
      await compile(kitchenSink()),
      await compileRights(withRoles()),
    ]
    for (const result of models) {
      expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual(
        []
      )
      for (const unit of result.model!.sqlUnits) {
        const parsed = parse(unit.sql)
        expect(parsed.ok, unit.identity).toBe(true)
        if (!parsed.ok) continue
        for (const { stmt } of parsed.statements) {
          expect(
            "CreateRoleStmt" in stmt ||
              "AlterRoleStmt" in stmt ||
              "GrantRoleStmt" in stmt,
            unit.identity
          ).toBe(false)
          if (!("GrantStmt" in stmt)) continue
          if (stmt.GrantStmt.objtype !== "OBJECT_TABLE") continue
          const grantees = (stmt.GrantStmt.grantees ?? []).map((g) =>
            "RoleSpec" in g ? g.RoleSpec.rolename : undefined
          )
          if (!grantees.includes(PLATFORM_ROLES.command)) continue
          expect(unit.generator, unit.identity).toBe("access")
          const privileges = (stmt.GrantStmt.privileges ?? []).map((p) =>
            "AccessPriv" in p ? p.AccessPriv.priv_name : undefined
          )
          expect(privileges.length, unit.identity).toBe(1)
          expect(
            ["select", "insert", "update", "delete"],
            unit.identity
          ).toContain(privileges[0])
        }
      }
    }
  })

  it("current_user_id reads sub of the claims and skips invalid users", async () => {
    const model = await withUsers()
    const { sql } = unit(model, CURRENT_USER)
    expect(sql).toContain("LANGUAGE plpgsql STABLE SECURITY DEFINER")
    expect(sql).toContain(
      `nullif(current_setting('${SESSION_CLAIMS_SETTING}', true), '')::jsonb ->> 'sub'`
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
      // Регістр має мітку з плану прав (Р1a-9): в'юха бере її з того самого
      // факту реєстру, а не з переліку видів 1С.
      "information-registers/Price/Price.meta.json": {
        id: uuid(72),
        kind: "InformationRegister",
        name: "Price",
        physicalName: "price",
        kindLabel: "price",
        writeMode: "Independent",
        periodicity: "NonPeriodic",
        dimensions: [attribute("item", { id: uuid(73), type: "Text" })],
      },
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
    expect(view.sql).toContain(
      `('price', 'InformationRegister', '${uuid(72)}'::uuid, 'Price', 'app', 'price')`
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
    // Довжина, відмінна від типової: інакше вшита в генератор константа
    // пройшла б тест.
    const model = await compileOk({
      [USERS_FILE]: catalog("Users", {
        id: USERS_ID,
        role: "users",
        scope: "none",
        descriptionLength: 60,
      }),
    })
    const provision = unit(model, PROVISION).sql
    expect(provision).toContain("ON CONFLICT DO NOTHING")
    expect(provision).toContain("left(p_display_name, 60)")
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
      subjectIsUserId: true,
      anonymousClaim: null,
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
    const sqlOf = (identity: string) =>
      units.find((u) => u.identity === identity)!.sql
    expect(text).toContain("ON idp.accounts")
    // Ключ облікового запису — subject, id користувача й нейтральне ім'я: усі
    // три місця беруть підставлену колонку.
    expect(sqlOf(ON_CREATED).match(/NEW\.account_id\b/g)).toHaveLength(3)
    expect(sqlOf(ON_REMOVED)).toContain("OLD.account_id::text")
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
        subjectIsUserId: true,
        anonymousClaim: null,
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

/**
 * Без «Користувачів» поточного користувача дає `sub` (Р2d1-6, спека
 * користувачів §7): лише з прийнятим джерелом членства на провайдері, де
 * `sub` — id користувача (С8).
 */
describe("platform layer without users", () => {
  const UUID_PATTERN =
    "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
  let model: CompiledModel
  beforeAll(async () => {
    await loadShapeParsers()
    const result = await compileRights(adoptedSourcesDomain(withoutUsers()))
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
    model = result.model!
  })

  const layer = (m: CompiledModel) =>
    m.sqlUnits.filter((u) => u.generator === "platformLayer")

  const subjectFunction = (): SqlUnit => {
    const functions = layer(model).filter((u) => u.class === "function")
    expect(functions.map((u) => u.identity)).toEqual([CURRENT_USER])
    return functions[0]!
  }

  /** Оператори гілки `IF` з умовою `condition`; без такого `IF` — помилка. */
  function branch(condition: string) {
    const shape = bodyShape(subjectFunction().sql)
    const at = shape.findIndex(
      (s) =>
        s.type === "if" &&
        isDeepStrictEqual(s.expressions[0]?.tree, tree(`SELECT ${condition}`))
    )
    expect(at, condition).toBeGreaterThanOrEqual(0)
    const rest = shape.slice(at + 1)
    const end = rest.findIndex((s) => s.depth <= shape[at]!.depth)
    return { at, statements: end === -1 ? rest : rest.slice(0, end) }
  }

  it("without users the session user is the subject as uuid", () => {
    expect(model.contracts.users).toBeUndefined()
    const fn = subjectFunction()
    // Функція спільна для проєкту, як функції прав: власника-об'єкта немає.
    expect(fn.ownerObjectId).toBeUndefined()
    expect(routineLanguage(fn.tree as never)).toBe("plpgsql")
    expect(hasEmptySearchPath(fn.tree as never)).toBe(true)
    const options = nodes(fn.tree, "DefElem") as {
      defname: string
      arg?: { String?: { sval?: string }; Boolean?: { boolval?: boolean } }
    }[]
    const option = (name: string) => options.find((o) => o.defname === name)
    expect(option("volatility")?.arg?.String?.sval).toBe("stable")
    expect(option("security")?.arg?.Boolean?.boolval).toBe(true)
    // `sub` з claims сесії; до uuid приводиться лише рядок формату uuid.
    const shape = bodyShape(fn.sql)
    expect(
      shape.some((s) =>
        s.expressions.some((e) =>
          isDeepStrictEqual(
            e.tree,
            tree(
              `SELECT nullif(current_setting('${SESSION_CLAIMS_SETTING}', true), '')::jsonb`
            )
          )
        )
      )
    ).toBe(true)
    const guarded = branch(`v_subject ~ '${UUID_PATTERN}'`)
    expect(
      guarded.statements.map((s) => [s.type, s.expressions[0]?.tree])
    ).toEqual([["return", tree("SELECT v_subject::uuid")]])
    const casts = nodes(
      shape.map((s) => s.expressions.map((e) => e.tree)),
      "TypeCast"
    ).filter((c) => JSON.stringify(c).includes('"sval":"uuid"'))
    expect(casts).toHaveLength(1)
    expect(
      shape.at(-1 - shape.filter((s) => s.type === "declare").length)
    ).toMatchObject({ type: "return", depth: 1, returns: { null: true } })
    // `EXECUTE` — ті самі ролі сесії, що з «Користувачами»; гранти схеми
    // дає стан застосування, шар їх не повторює (state.test.ts).
    const grants = layer(model)
      .filter((u) => u.class === "grant")
      .map((u) => u.sql)
      .sort()
    expect(grants).toEqual([
      "GRANT EXECUTE ON FUNCTION simetra.current_user_id() TO anon;",
      "GRANT EXECUTE ON FUNCTION simetra.current_user_id() TO authenticated;",
      "GRANT EXECUTE ON FUNCTION simetra.current_user_id() TO service_role;",
      `GRANT EXECUTE ON FUNCTION simetra.current_user_id() TO ${PLATFORM_ROLES.command};`,
      "REVOKE EXECUTE ON FUNCTION simetra.current_user_id() FROM PUBLIC;",
    ])
  })

  it("an anonymous session is not a user", () => {
    // Анонімного входу провізія не створює (`anonymousColumn`), тож без
    // «Користувачів» його відкидає сама функція — інакше він мав би права
    // `everyUser`. Перевірка — до приведення `sub`.
    const anonymous = branch("v_claims ->> 'is_anonymous' = 'true'")
    expect(anonymous.statements).toMatchObject([
      { type: "return", returns: { null: true } },
    ])
    expect(anonymous.at).toBeLessThan(
      branch(`v_subject ~ '${UUID_PATTERN}'`).at
    )
  })

  it("a provider without anonymous sessions has no anonymous check", async () => {
    const parse = await loadSqlParser()
    const units = buildPlatformUnits(
      {
        objects: model.objects,
        physical: model.physical,
        contracts: model.contracts,
        project: model.project,
      },
      parse,
      { ...PROVIDER_IDENTITY_SOURCES.supabase, anonymousClaim: null }
    )
    const fn = units.find((u) => u.identity === CURRENT_USER)!
    expect(bodyShape(fn.sql).filter((s) => s.type === "if")).toHaveLength(1)
    expect(fn.sql).not.toContain("is_anonymous")
  })

  it("without users and without a membership source there is no session user", async () => {
    const parse = await loadSqlParser()
    const units = buildPlatformUnits(
      {
        objects: model.objects,
        physical: model.physical,
        contracts: { ...model.contracts, membershipSources: [] },
        project: model.project,
      },
      parse,
      PROVIDER_IDENTITY_SOURCES.supabase
    )
    expect(units).toEqual([])
    // Проєкт без «Користувачів» і без джерела членства: ні шару, ні прав.
    const plain = await compileOk({
      "catalogs/Currency/Currency.meta.json": catalog("Currency"),
    })
    expect(
      plain.sqlUnits.filter(
        (u) => u.generator === "platformLayer" || u.generator === "rights"
      )
    ).toEqual([])
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
