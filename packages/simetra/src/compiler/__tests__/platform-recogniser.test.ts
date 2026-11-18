import { beforeAll, describe, expect, it } from "vitest"
import {
  compile,
  loadSqlParser,
  platformInstall,
  platformRecogniser,
  readSqlUnits,
  type PlatformInstall,
  type PlatformReference,
  type SqlParser,
} from "simetra/compiler"
import {
  catalogFromSnapshot,
  DATABASE_PROVIDERS,
  SIGNAL_OUTBOX,
  type CatalogTable,
  type DatabaseProvider,
} from "simetra/model"
import {
  CATALOG_OUTBOX_TABLE,
  CATALOG_UNIT_FORMS,
} from "./fixtures/platform-catalog-forms"
import { catalog, metaFiles, project } from "./helpers"

/**
 * Помічник «платформне — за вмістом» (`platformRecogniser`, план #286 Р1):
 * одиниця чи таблиця платформна лише тоді, коли її вміст збігається з
 * еталоном; невідоме — не платформне.
 */

let parse: SqlParser
beforeAll(async () => {
  parse = await loadSqlParser()
})

const unitOf = (sql: string) => {
  const read = readSqlUnits(
    [{ file: "x.sql", text: sql, schema: "" }],
    parse,
    []
  )
  expect(read.diagnostics).toEqual([])
  expect(read.units).toHaveLength(1)
  return read.units[0]!
}

/** Згенеровані одиниці й таблиці платформи проєкту з довідником `app.item`. */
async function catalogReference(
  provider: DatabaseProvider
): Promise<PlatformReference> {
  const compiled = await compile(
    metaFiles({
      "project.meta.json": project({
        defaultSchema: "app",
        database: { provider },
      }),
      "catalogs/Item/Item.meta.json": catalog("Item"),
    })
  )
  expect(compiled.diagnostics.filter((d) => d.severity === "error")).toEqual([])
  const install = await platformInstall(provider)
  return {
    tables: install.tables,
    units: compiled.model!.sqlUnits.filter((u) => u.file === undefined),
  }
}

const outbox = (install: PlatformInstall) =>
  catalogFromSnapshot({ tables: [...install.tables], enumTypes: [] }).tables[0]!

describe("platformRecogniser: catalog forms of the platform (Р5)", () => {
  // Кожна пара — текст каталогу ↔ текст генератора тієї самої ідентичності:
  // тексти різні, вміст той самий
  it.each(DATABASE_PROVIDERS)(
    "%s: every recorded catalog unit is the platform's, and its text differs from the generator's",
    async (provider) => {
      const reference = await catalogReference(provider)
      const platform = platformRecogniser(reference, parse)
      const generated = new Map(reference.units.map((u) => [u.identity, u.sql]))
      const rows = Object.entries(CATALOG_UNIT_FORMS).map(([identity, sql]) => {
        const unit = unitOf(sql)
        return {
          identity,
          read: unit.identity,
          differs: generated.get(identity) !== sql,
          platform: platform.unit(unit),
        }
      })
      expect(rows).toEqual(
        Object.keys(CATALOG_UNIT_FORMS).map((identity) => ({
          identity,
          read: identity,
          differs: true,
          platform: true,
        }))
      )
    }
  )

  it.each(DATABASE_PROVIDERS)(
    "%s: the extracted outbox table is the install's, its check texts differ",
    async (provider) => {
      const install = await platformInstall(provider)
      const platform = platformRecogniser(install, parse)
      expect(platform.table(CATALOG_OUTBOX_TABLE)).toBe(true)
      const own = outbox(install)
      expect(
        own.checks.filter(
          (c) =>
            CATALOG_OUTBOX_TABLE.checks.find((k) => k.name === c.name)
              ?.expression === c.expression
        )
      ).toEqual([])
    }
  )
})

describe("platformRecogniser: a grant is the platform's only atom by atom (И1)", () => {
  it.each(DATABASE_PROVIDERS)(
    "%s: install grants are the platform's in their own and in the catalog form",
    async (provider) => {
      const install = await platformInstall(provider)
      const platform = platformRecogniser(install, parse)
      const grants = install.units.filter((u) => u.class === "grant")
      expect(grants.length).toBeGreaterThan(0)
      expect(
        grants.filter((u) => !platform.unit(unitOf(u.sql))).map((u) => u.sql)
      ).toEqual([])
    }
  )

  // Кожна опція, що змінює дію гранту, — свій рядок: мутація, що не кладе в
  // атом `grant_option`, `behavior` чи `grantor`, червонить саме свої рядки
  it.each(DATABASE_PROVIDERS)(
    "%s: an install grant with an option that changes its action is not the platform's",
    async (provider) => {
      const install = await platformInstall(provider)
      const platform = platformRecogniser(install, parse)
      const bare = (sql: string) => sql.trim().replace(/;$/, "")
      const grants = install.units.filter(
        (u) => u.class === "grant" && /^GRANT /.test(u.sql)
      )
      const revokes = install.units.filter(
        (u) => u.class === "grant" && /^REVOKE /.test(u.sql)
      )
      expect(grants.length).toBeGreaterThan(0)
      expect(revokes.length).toBeGreaterThan(0)
      const variants = [
        ...grants.flatMap((u) => [
          `${bare(u.sql)} WITH GRANT OPTION;`,
          `${bare(u.sql)} GRANTED BY CURRENT_USER;`,
        ]),
        ...revokes.flatMap((u) => [
          `${bare(u.sql).replace(/^REVOKE /, "REVOKE GRANT OPTION FOR ")};`,
          `${bare(u.sql)} CASCADE;`,
          `${bare(u.sql)} GRANTED BY CURRENT_USER;`,
        ]),
      ]
      expect(variants.filter((sql) => platform.unit(unitOf(sql)))).toEqual([])
    }
  )

  // Поле `GrantStmt`, якого атом не знає (новий Postgres), не губиться
  // мовчки
  it.each(DATABASE_PROVIDERS)(
    "%s: a grant with a non-empty field outside the atom is not the platform's",
    async (provider) => {
      const install = await platformInstall(provider)
      const grants = install.units.filter((u) => u.class === "grant")
      expect(grants.length).toBeGreaterThan(0)
      // Парсер-обгортка додає поле лише тексту з міткою: еталон розібрано
      // як є, одиницю каталогу — з полем
      const MARK = "\n-- future\n"
      const withField: SqlParser = (sql) => {
        const parsed = parse(sql)
        if (!parsed.ok || !sql.endsWith(MARK)) return parsed
        return {
          ok: true,
          statements: parsed.statements.map((s) =>
            "GrantStmt" in s.stmt
              ? {
                  ...s,
                  stmt: {
                    GrantStmt: { ...s.stmt.GrantStmt, future_option: true },
                  } as typeof s.stmt,
                }
              : s
          ),
        }
      }
      const platform = platformRecogniser(install, withField)
      expect(grants.filter((u) => !platform.unit(u))).toEqual([])
      expect(
        grants.filter((u) => platform.unit({ ...u, sql: `${u.sql}${MARK}` }))
      ).toEqual([])
    }
  )

  it.each(DATABASE_PROVIDERS)(
    "%s: a grant on an install object the install does not give is not the platform's",
    async (provider) => {
      const platform = platformRecogniser(
        await platformInstall(provider),
        parse
      )
      const notPlatform = [
        "GRANT SELECT ON TABLE simetra.signal_outbox TO some_extra_role;",
        "GRANT ALL ON TABLE simetra.signal_outbox TO PUBLIC;",
        "GRANT SELECT ON TABLE simetra.signal_outbox TO simetra_command;",
        'GRANT INSERT ("partition") ON TABLE simetra.signal_outbox TO simetra_command;',
        "GRANT EXECUTE ON FUNCTION simetra.signal_outbox_prune(interval) TO PUBLIC;",
        "GRANT EXECUTE ON FUNCTION simetra.signal_outbox_prune(interval) TO simetra_command;",
        "GRANT USAGE ON SEQUENCE simetra.signal_outbox_id_seq TO simetra_command;",
        "GRANT USAGE ON SEQUENCE simetra.row_version TO simetra_command;",
        "GRANT SELECT ON TABLE simetra.signal_outbox, app.note TO simetra_command;",
        "GRANT EXECUTE ON FUNCTION simetra.signal_outbox_prune(text) TO simetra_command;",
        // Роль у лапках з комою — один вузол `RoleSpec`, а не дві ролі
        'GRANT SELECT ON TABLE simetra.signal_outbox TO "simetra_signal_consumer,simetra_command";',
      ]
      expect(notPlatform.filter((sql) => platform.unit(unitOf(sql)))).toEqual(
        []
      )
    }
  )
})

describe("platformRecogniser: other units by their normalised tree (И4)", () => {
  it.each(DATABASE_PROVIDERS)(
    "%s: a policy, function or trigger under an install name with other content is not the platform's",
    async (provider) => {
      const install = await platformInstall(provider)
      const platform = platformRecogniser(install, parse)
      const own = (identity: string) => {
        const unit = install.units.find((u) => u.identity === identity)
        expect(unit?.identity).toBe(identity)
        return unit!.sql
      }
      const policy = own(
        "policy:simetra.signal_outbox.signal_outbox_consumer_select"
      )
      const fn = own("function:simetra.signal_outbox_prune(interval)")
      const trigger = own(
        "trigger:simetra.signal_outbox.simetra_signal_outbox_stamp"
      )
      // Еталон без змін — платформний: зміна нижче й лише вона робить «ні»
      expect(
        [policy, fn, trigger].map((sql) => platform.unit(unitOf(sql)))
      ).toEqual([true, true, true])
      const changed = [
        policy.replace("TO simetra_signal_consumer", "TO some_extra_role"),
        fn.replace("created_at < now()", "created_at <= now()"),
        trigger.replace("BEFORE INSERT", "AFTER INSERT"),
      ]
      expect(
        changed.filter((sql, i) => sql === [policy, fn, trigger][i])
      ).toEqual([])
      expect(changed.filter((sql) => platform.unit(unitOf(sql)))).toEqual([])
    }
  )

  // Нормалізація прибирає лише типовий `SECURITY INVOKER`: зміна безпеки
  // функції в будь-який бік і її `SET` — інший вміст. Рядок на напрям
  it.each(DATABASE_PROVIDERS)(
    "%s: a platform function with other security or settings is not the platform's",
    async (provider) => {
      const reference = await catalogReference(provider)
      const platform = platformRecogniser(reference, parse)
      const own = (identity: string) => {
        const unit = reference.units.find((u) => u.identity === identity)
        expect(unit?.identity).toBe(identity)
        return unit!.sql
      }
      const invoker = own("function:simetra.signal_outbox_prune(interval)")
      const definer = own("function:simetra.touch()")
      const catalogDefiner = CATALOG_UNIT_FORMS["function:simetra.touch()"]!
      expect(
        [invoker, definer, catalogDefiner].map((sql) =>
          platform.unit(unitOf(sql))
        )
      ).toEqual([true, true, true])
      const rows = {
        "invoker → definer": invoker.replace(
          "SECURITY INVOKER",
          "SECURITY DEFINER"
        ),
        "definer → no security clause": definer.replace(
          " SECURITY DEFINER",
          ""
        ),
        "definer → invoker": definer.replace(
          "SECURITY DEFINER",
          "SECURITY INVOKER"
        ),
        "catalog definer → no security clause": catalogDefiner.replace(
          " SECURITY DEFINER\n",
          ""
        ),
        "no search_path": invoker.replace("SET search_path = ''\n", ""),
        "other search_path": invoker.replace(
          "SET search_path = ''",
          "SET search_path = 'public'"
        ),
        "extra setting": invoker.replace(
          "SET search_path = ''",
          "SET search_path = ''\nSET row_security = off"
        ),
      }
      const source = [
        invoker,
        definer,
        definer,
        catalogDefiner,
        invoker,
        invoker,
        invoker,
      ]
      expect(
        Object.entries(rows)
          .filter(([, sql], i) => sql === source[i])
          .map(([name]) => name)
      ).toEqual([])
      expect(
        Object.entries(rows)
          .filter(([, sql]) => platform.unit(unitOf(sql)))
          .map(([name]) => name)
      ).toEqual([])
    }
  )
})

describe("platformRecogniser: tables by catalog comparison (И5)", () => {
  it.each(DATABASE_PROVIDERS)(
    "%s: the outbox with an extra column or without RLS is not the platform's",
    async (provider) => {
      const install = await platformInstall(provider)
      const platform = platformRecogniser(install, parse)
      const own = outbox(install)
      expect(platform.table(own)).toBe(true)
      const extra: CatalogTable = {
        ...own,
        columns: [
          ...own.columns,
          { name: "note", type: "text", notNull: false },
        ],
      }
      const open: CatalogTable = { ...own, rowLevelSecurity: "off" }
      const check: CatalogTable = {
        ...own,
        checks: own.checks.map((c) =>
          c.name === "signal_outbox_method_check"
            ? { ...c, expression: "(method = 'other'::text)" }
            : c
        ),
      }
      expect([extra, open, check].map((t) => platform.table(t))).toEqual([
        false,
        false,
        false,
      ])
      // Таблиця з тим самим вмістом поза схемою установки — теж не еталон
      expect(platform.table({ ...own, schema: "app" })).toBe(false)
      expect(own.schema).toBe(SIGNAL_OUTBOX.schema)
    }
  )
})

describe("platformRecogniser: the unknown is not the platform's (И6)", () => {
  it.each(DATABASE_PROVIDERS)(
    "%s: SQL that does not parse and a unit without a reference identity",
    async (provider) => {
      const install = await platformInstall(provider)
      const platform = platformRecogniser(install, parse)
      const policy = install.units.find((u) => u.class === "policy")!
      expect(platform.unit(policy)).toBe(true)
      expect(
        [
          { ...policy, sql: "CREATE POLICY broken ON" },
          { ...policy, sql: `${policy.sql} ${policy.sql}` },
          { ...policy, identity: `${policy.identity}_other` },
          { ...policy, class: "trigger" as const },
          unitOf(
            "CREATE FUNCTION simetra.signal_outbox_extra() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;"
          ),
        ].map((u) => platform.unit(u))
      ).toEqual([false, false, false, false, false])
      const own = outbox(install)
      expect(
        platform.table({
          ...own,
          checks: own.checks.map((c) =>
            c.name === "signal_outbox_method_check"
              ? { ...c, expression: "method = (" }
              : c
          ),
        })
      ).toBe(false)
    }
  )
})
