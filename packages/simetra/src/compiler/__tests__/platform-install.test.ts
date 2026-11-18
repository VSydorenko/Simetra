import { beforeAll, describe, expect, it } from "vitest"
import {
  grantAtoms,
  loadSqlParser,
  platformInstall,
  platformRecogniser,
  readSqlUnits,
  ROW_VERSION_SEQUENCE,
  type SqlParser,
} from "simetra/compiler"
import {
  catalogFromSnapshot,
  DATABASE_PROVIDERS,
  SIGNAL_OUTBOX,
} from "simetra/model"
import { outboxUnits } from "../platform/outbox"

/**
 * Платформна установка (`platformInstall`): що платформа ставить у кожну
 * базу провайдера — виведено з порожнього проєкту, а не переліком.
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

describe("platformInstall", () => {
  it.each(DATABASE_PROVIDERS)(
    "%s: holds the signal outbox table and every unit of its generator",
    async (provider) => {
      const install = await platformInstall(provider)
      expect(install.tables.map((t) => [t.schema, t.name])).toEqual([
        [SIGNAL_OUTBOX.schema, SIGNAL_OUTBOX.name],
      ])
      const identities = new Set(install.units.map((u) => u.identity))
      const outbox = outboxUnits("Any", provider, parse)
      expect(outbox.length).toBeGreaterThan(0)
      expect(outbox.filter((u) => !identities.has(u.identity))).toEqual([])
      expect(identities).toContain(
        `sequence:${ROW_VERSION_SEQUENCE.schema}.${ROW_VERSION_SEQUENCE.name}`
      )
    }
  )

  it.each(DATABASE_PROVIDERS)(
    "%s: the recogniser takes install objects and the install's own grants only",
    async (provider) => {
      const install = await platformInstall(provider)
      const platform = platformRecogniser(install, parse)
      const outbox = catalogFromSnapshot({
        tables: [...install.tables],
        enumTypes: [],
      }).tables[0]!
      expect([outbox.schema, outbox.name]).toEqual([
        SIGNAL_OUTBOX.schema,
        SIGNAL_OUTBOX.name,
      ])
      expect(platform.table(outbox)).toBe(true)
      expect(platform.table({ ...outbox, schema: "app" })).toBe(false)
      const ofPlatform = [
        // Форма каталогу: грант по колонці, злиті привілеї однієї ролі
        'GRANT INSERT ("method") ON TABLE simetra.signal_outbox TO simetra_command;',
        "GRANT DELETE, SELECT ON TABLE simetra.signal_outbox TO simetra_signal_consumer;",
        'GRANT INSERT ("payload") ON TABLE simetra.signal_outbox TO simetra_command;',
        "REVOKE EXECUTE ON FUNCTION simetra.signal_outbox_prune(interval) FROM PUBLIC;",
        "CREATE TRIGGER simetra_signal_outbox_stamp BEFORE INSERT ON simetra.signal_outbox FOR EACH ROW EXECUTE FUNCTION simetra.signal_outbox_stamp();",
      ]
      // Грант на об'єкт установки, якого установка не дає: інша роль,
      // `PUBLIC`, інший привілей чи інша колонка — тека, а не платформа
      const notPlatform = [
        "GRANT SELECT ON TABLE simetra.signal_outbox TO some_extra_role;",
        "GRANT ALL ON TABLE simetra.signal_outbox TO PUBLIC;",
        // Опція гранту — не установки: її несе атом дерева розбору
        "GRANT DELETE, SELECT ON TABLE simetra.signal_outbox TO simetra_signal_consumer WITH GRANT OPTION;",
        "GRANT SELECT ON TABLE simetra.signal_outbox TO simetra_command;",
        'GRANT INSERT ("partition") ON TABLE simetra.signal_outbox TO simetra_command;',
        "GRANT EXECUTE ON FUNCTION simetra.signal_outbox_prune(interval) TO PUBLIC;",
        "GRANT USAGE ON SEQUENCE simetra.signal_outbox_id_seq TO simetra_command;",
        "GRANT USAGE ON SEQUENCE simetra.row_version TO simetra_command;",
        "GRANT SELECT ON TABLE simetra.signal_outbox, app.note TO simetra_command;",
        "GRANT EXECUTE ON FUNCTION simetra.signal_outbox_prune(text) TO simetra_command;",
        "CREATE TRIGGER own AFTER INSERT ON simetra.signal_outbox FOR EACH ROW EXECUTE FUNCTION simetra.signal_outbox_stamp();",
        "CREATE FUNCTION simetra.signal_outbox_extra() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;",
      ]
      expect(ofPlatform.filter((sql) => !platform.unit(unitOf(sql)))).toEqual(
        []
      )
      expect(notPlatform.filter((sql) => platform.unit(unitOf(sql)))).toEqual(
        []
      )
    }
  )
  // Грант установки з опцією під ідентичністю гранту установки (#277):
  // помічник судить атоми дерева розбору, а не ідентичність
  it.each(DATABASE_PROVIDERS)(
    "%s: a grant with the option under the identity of an install grant is not the platform's",
    async (provider) => {
      const install = await platformInstall(provider)
      const platform = platformRecogniser(install, parse)
      const grants = install.units.filter(
        (u) => u.class === "grant" && u.identity.startsWith("grant:grant:")
      )
      expect(grants.length).toBeGreaterThan(0)
      const optioned = grants.map((u) =>
        unitOf(`${u.sql.trim().replace(/;$/, "")} WITH GRANT OPTION;`)
      )
      expect(
        optioned.filter((u) => platform.unit(u)).map((u) => u.identity)
      ).toEqual([])
      expect(optioned.map((u) => u.identity.replaceAll("*", ""))).toEqual(
        grants.map((u) => u.identity)
      )
    }
  )

  // Роль у лапках з комою чи двокрапкою не ділить ідентичність гранту
  it("splits grant atoms by quoted role names", () => {
    const unit = unitOf(
      'GRANT SELECT ON public.t TO "a,b", "x:""y""" WITH GRANT OPTION;'
    )
    expect(unit.identity).toBe(
      'grant:grant:table:public.t:"a,b","x:""y""":select*'
    )
    expect(grantAtoms(unit.identity)).toEqual([
      'grant|table|public.t|"a,b"|select*',
      'grant|table|public.t|"x:""y"""|select*',
    ])
  })
})
