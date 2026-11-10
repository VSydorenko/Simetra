import { describe, expect, it } from "vitest"
import { canonicalSnapshot, platformTriggers } from "simetra/compiler"
import { executePlan, type PlanArtifact } from "simetra/schema"
import { attribute, catalog, uuid } from "../../../../simetra/test/support"
import { asSuperuser, query } from "../../__tests__/support/db"
import {
  compiled,
  EMPTY,
  establish,
  inTarget,
  type Json,
  NOTES,
  notes,
  params,
  PARTY,
  plan,
  planned,
  useBuildPlanRoles,
  writer,
} from "./build-plan.support"

/**
 * Раннер виконує кроки заповнення `NULL` перед `NOT NULL` на справжній базі
 * (платформна спека §6.6; спека промоції §7.2): лише `NULL` отримують
 * default, кроки — однією транзакцією, тригери за Р4а, `SET CONSTRAINTS`
 * після `UPDATE`, згода на обсяг (Р3а) і перевірка `NULL` перед
 * `SET NOT NULL` без заповнення (Р7). Підрахунок на плані — у
 * `build-plan-backfill.db.test.ts`.
 */

useBuildPlanRoles()

const REQUIRED = { type: "String", length: 20, notNull: true }
const FILLED = { ...REQUIRED, default: "'n/a'" }

/**
 * Прийнята таблиця журналу з однією текстовою колонкою: таблиці — метадані,
 * а не SQL-файли, тож тригери пишуть сюди.
 */
function logTable(
  id: number,
  name: string,
  physicalName: string,
  column: string
) {
  return {
    ...(notes() as unknown as Json),
    id: uuid(id),
    name,
    physicalName,
    kindLabel: physicalName,
    columns: [
      {
        id: uuid(id + 1),
        name: "id",
        physicalName: "id",
        type: "UUID",
        notNull: true,
        default: "gen_random_uuid()",
      },
      { id: uuid(id + 2), name: column, physicalName: column, type: "Text" },
    ],
    primaryKey: { name: `${physicalName}_pkey`, columns: ["id"] },
  }
}

/**
 * Дослівний тригер користувача на прийнятій таблиці: кожне оновлення
 * рядка пише в журнал `app.note_log` — так видно, чи вимикав його крок.
 */
const AUDIT_SQL = {
  "custom-tables/NoteLog/NoteLog.meta.json": logTable(
    9400,
    "NoteLog",
    "note_log",
    "note"
  ),
  "sql/app/audit.sql": `CREATE FUNCTION app.log_note() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$ BEGIN INSERT INTO app.note_log (note) VALUES (NEW.note); RETURN NEW; END $$;
CREATE TRIGGER notes_audit AFTER UPDATE ON app.notes FOR EACH ROW EXECUTE FUNCTION app.log_note();`,
}

/** Рядки `app.notes`; `null` — `NULL` у `note`. */
const rows = (...values: (string | null)[]) =>
  `insert into app.notes (id, note) values ${values
    .map((v) => `(gen_random_uuid(), ${v === null ? "null" : `'${v}'`})`)
    .join(", ")};`

const notesOf = async (url: string) =>
  (
    await query<{ note: string | null }>(
      url,
      "select note from app.notes order by note nulls first"
    )
  ).map((r) => r.note)

const backfillOf = (artifact: PlanArtifact) => {
  const steps = artifact.steps.filter((s) => s.origin === "backfill")
  expect(steps).toHaveLength(1)
  return steps[0]!
}

const apply = (
  url: string,
  artifact: PlanArtifact,
  model: Parameters<typeof canonicalSnapshot>[0],
  allow: readonly string[] = artifact.requiredPermissions
) =>
  executePlan(writer, { url }, artifact, {
    mode: "apply",
    planHash: artifact.planHash,
    allow,
    snapshot: canonicalSnapshot(model),
  })

const ledgerRows = async (url: string) =>
  (
    await query<{ n: number }>(
      url,
      "select count(*)::int as n from simetra.ledger"
    )
  )[0]!.n

describe.concurrent("apply backfill", () => {
  it("fills only the NULL values of an adopted table under its permission, with the shown triggers off", async () => {
    // І1, І10, І14, Р8: дані споживача — під дозволом за id кроку; порожній
    // рядок — наявне значення; показаний тригер вимкнено на час `UPDATE`
    // і ввімкнено після
    const before = await compiled({ [NOTES]: notes(), ...AUDIT_SQL })
    const after = await compiled({ [NOTES]: notes(FILLED), ...AUDIT_SQL })
    await inTarget(EMPTY, async (url) => {
      await establish(url, before)
      await query(url, rows(null, "", "a", null))
      const artifact = planned(await plan(url, after))
      const fill = backfillOf(artifact)
      expect(fill.backfill).toMatchObject({
        table: { schema: "app", name: "notes" },
        column: "note",
        rowsAtPlan: 2,
        permission: true,
        triggers: [{ name: "notes_audit", enabled: "O" }],
      })
      expect(artifact.requiredPermissions).toContain(fill.id)

      // І14: тригер, якого план не показав, мовчки не вимикається
      const hidden: PlanArtifact = {
        ...artifact,
        steps: artifact.steps.map((s) =>
          s.id === fill.id
            ? { ...s, backfill: { ...s.backfill!, triggers: [] } }
            : s
        ),
      }
      expect(await apply(url, hidden, after)).toMatchObject({
        status: "refused",
        diagnostics: [
          {
            code: "apply.backfill-triggers-changed",
            params: {
              step: fill.id,
              table: "app.notes",
              reason: "unshown",
              triggers: "notes_audit",
            },
          },
        ],
      })
      // І10: без дозволу на крок — відмова до будь-якого запису
      expect(
        await apply(
          url,
          artifact,
          after,
          artifact.requiredPermissions.filter((p) => p !== fill.id)
        )
      ).toMatchObject({
        status: "refused",
        diagnostics: [{ code: "apply.permission-required" }],
      })
      expect(await notesOf(url)).toEqual([null, null, "", "a"])

      const outcome = await apply(url, artifact, after)
      expect(outcome.diagnostics).toEqual([])
      expect(outcome).toMatchObject({
        status: "committed",
        backfills: [
          {
            step: fill.id,
            schema: "app",
            table: "notes",
            column: "note",
            rowsAtPlan: 2,
            rows: 2,
          },
        ],
      })
      expect(await notesOf(url)).toEqual(["", "a", "n/a", "n/a"])
      expect(await query(url, "select note from app.note_log")).toEqual([])
      // Після кроку тригер знову ввімкнений
      await query(url, "update app.notes set note = 'b' where note = 'a'")
      expect(await query(url, "select note from app.note_log")).toEqual([
        { note: "b" },
      ])
    })
  })

  it("fills a kind table without a permission and keeps its platform triggers on", async () => {
    // І10, І7, доповнення п. 2(б) і 6: таблиця виду з default у формі
    // компілятора дозволу не просить; тригер механіки — платформний за
    // визначенням (функція кваліфікована схемою), тож не показаний і
    // підвищує версію заповненого рядка, а тригер підписки — тригер
    // користувача: вимкнений на заповненні й знову ввімкнений після
    const party = (over: Json = {}) =>
      catalog("Party", {
        id: uuid(9001),
        attributes: [
          attribute("note", {
            id: uuid(9002),
            type: "String",
            length: 20,
            ...over,
          }),
        ],
      })
    const subscription = {
      "event-subscriptions/PartyWritten/PartyWritten.meta.json": {
        id: uuid(9020),
        kind: "EventSubscription",
        name: "PartyWritten",
        physicalName: "party_written",
        sources: [{ kind: "Catalog", name: "Party" }],
        event: "onWrite",
        handler: { schema: "app", name: "party_written" },
      },
      // Обробник лише перевіряє рядок (спека прав §5.3): спрацювання на
      // заповненому значенні видно відмовою
      "sql/app/party.sql": `CREATE FUNCTION app.party_written() RETURNS trigger LANGUAGE plpgsql VOLATILE SET search_path = '' AS $$ BEGIN IF NEW.note = 'n/a' THEN RAISE EXCEPTION 'party_written: fired on %', NEW.note; END IF; RETURN NEW; END $$;`,
    }
    const before = await compiled({ [PARTY]: party(), ...subscription })
    const after = await compiled({
      [PARTY]: party({ required: true, defaultValue: "n/a" }),
      ...subscription,
    })
    const [empty, kept] = [uuid(9010), uuid(9011)]
    await inTarget(EMPTY, async (url) => {
      await establish(url, before)
      await query(
        url,
        `insert into app.party (id, note) values ('${empty}', null), ('${kept}', 'x')`
      )
      const versions = async () =>
        Object.fromEntries(
          (
            await query<{ id: string; version: string }>(
              url,
              "select id, version::text from app.party"
            )
          ).map((r) => [r.id, r.version])
        )
      const was = await versions()
      const artifact = planned(await plan(url, after))
      const fill = backfillOf(artifact)
      expect(fill.backfill).toMatchObject({ rowsAtPlan: 1, permission: false })
      // Показано лише тригер підписки: платформні — за визначенням поза ним
      expect(fill.backfill!.triggers).toHaveLength(1)
      expect(fill.backfill!.triggers[0]!.name).not.toMatch(/simetra/)
      expect(artifact.requiredPermissions).not.toContain(fill.id)
      const outcome = await apply(url, artifact, after)
      expect(outcome.diagnostics).toEqual([])
      expect(outcome).toMatchObject({
        status: "committed",
        backfills: [{ step: fill.id, rows: 1, rowsAtPlan: 1 }],
      })
      expect(
        await query(url, "select id, note from app.party order by note")
      ).toEqual([
        { id: empty, note: "n/a" },
        { id: kept, note: "x" },
      ])
      const now = await versions()
      expect(BigInt(now[empty]!)).toBeGreaterThan(BigInt(was[empty]!))
      expect(now[kept]).toBe(was[kept])
      // Після кроку підписка знову ввімкнена
      await expect(
        query(url, "update app.party set note = 'n/a' where note = 'x'")
      ).rejects.toThrow(/party_written: fired/)
    })
  })

  it("rolls the fill back with a later step that finds NULL values written after the plan", async () => {
    // І2, І6, Р7: `NULL` у `tag` з'явилися після плану — керована відмова
    // перед її `SET NOT NULL`, і разом з нею відкочено заповнення `note`
    const two = (note: Json, code: Json) => {
      const t = notes(note) as unknown as { columns: Json[] }
      // Ім'я після `note`: двигун упорядковує дії колонок за ідентичністю,
      // тож заповнення `note` стоїть раніше за кроком, що впаде
      t.columns.push({
        id: uuid(9205),
        name: "tag",
        physicalName: "tag",
        ...code,
      })
      return t
    }
    const plain = { type: "String", length: 20 }
    const before = await compiled({ [NOTES]: two(plain, plain) })
    const after = await compiled({ [NOTES]: two(FILLED, REQUIRED) })
    await inTarget(EMPTY, async (url) => {
      await establish(url, before)
      await query(
        url,
        "insert into app.notes (id, note, tag) values (gen_random_uuid(), null, 'c')"
      )
      const artifact = planned(await plan(url, after))
      const fill = backfillOf(artifact)
      const [check] = artifact.steps.filter((s) =>
        s.notNull?.some((c) => c.column === "tag")
      )
      expect(check?.notNull).toEqual([
        { table: { schema: "app", name: "notes" }, column: "tag" },
      ])
      // Заповнення справді йде раніше за кроком, що впаде: інакше відкат
      // нижче нічого б не доводив
      expect(artifact.steps.indexOf(fill)).toBeLessThan(
        artifact.steps.indexOf(check!)
      )
      await query(
        url,
        "insert into app.notes (id, note, tag) values (gen_random_uuid(), 'z', null)"
      )
      const ledger = await ledgerRows(url)
      const outcome = await apply(url, artifact, after)
      expect(outcome).toMatchObject({
        status: "failed",
        diagnostics: [
          {
            code: "apply.not-null-violation",
            params: {
              step: check!.id,
              table: "app.notes",
              column: "tag",
              rows: 1,
            },
          },
        ],
      })
      expect(await notesOf(url)).toEqual([null, "z"])
      expect(await ledgerRows(url)).toBe(ledger)
    })
  })

  it("refuses more NULL values than the permission covered and rolls back", async () => {
    // І11, Р3а: згода власника — на обсяг, який показав план
    const before = await compiled({ [NOTES]: notes() })
    const after = await compiled({ [NOTES]: notes(FILLED) })
    await inTarget(EMPTY, async (url) => {
      await establish(url, before)
      await query(url, rows(null, null, "a"))
      const artifact = planned(await plan(url, after))
      const fill = backfillOf(artifact)
      await query(url, rows(null))
      expect(await apply(url, artifact, after)).toMatchObject({
        status: "refused",
        diagnostics: [
          {
            code: "apply.backfill-rows-changed",
            params: {
              step: fill.id,
              table: "app.notes",
              column: "note",
              planned: 2,
              rows: 3,
            },
          },
        ],
      })
      expect(await notesOf(url)).toEqual([null, null, null, "a"])
    })
  })

  it("fills a column under a deferred foreign key", async () => {
    // І12: подія відкладеного FK заповненої колонки спрацьовує до
    // увімкнення тригерів і наступного `SET NOT NULL`, інакше `55006`
    const PARENTS = "custom-tables/Parents/Parents.meta.json"
    const parent = uuid(9300)
    const parents = {
      ...(notes() as unknown as Json),
      id: uuid(9301),
      name: "Parents",
      physicalName: "parents",
      kindLabel: "parents",
      columns: [
        {
          id: uuid(9302),
          name: "id",
          physicalName: "id",
          type: "UUID",
          notNull: true,
        },
      ],
      primaryKey: { name: "parents_pkey", columns: ["id"] },
    }
    const child = (over: Json) => ({
      ...(notes() as unknown as Json),
      columns: [
        {
          id: uuid(9202),
          name: "id",
          physicalName: "id",
          type: "UUID",
          notNull: true,
        },
        {
          id: uuid(9303),
          name: "parent",
          physicalName: "parent",
          type: "UUID",
          ...over,
        },
      ],
      foreignKeys: [
        {
          name: "notes_parent_fkey",
          columns: ["parent"],
          references: {
            object: { kind: "CustomTable", name: "Parents" },
            columns: ["id"],
          },
          deferrable: "initiallyDeferred",
        },
      ],
    })
    const before = await compiled({ [PARENTS]: parents, [NOTES]: child({}) })
    const after = await compiled({
      [PARENTS]: parents,
      [NOTES]: child({ notNull: true, default: `'${parent}'::uuid` }),
    })
    await inTarget(EMPTY, async (url) => {
      await establish(url, before)
      await query(
        url,
        `insert into app.parents (id) values ('${parent}');
         insert into app.notes (id, parent) values (gen_random_uuid(), null);`
      )
      const artifact = planned(await plan(url, after))
      backfillOf(artifact)
      const outcome = await apply(url, artifact, after)
      expect(outcome.diagnostics).toEqual([])
      expect(outcome.status).toBe("committed")
      expect(await query(url, "select parent from app.notes")).toEqual([
        { parent },
      ])
    })
  })

  it("runs the deferred triggers of the fill under the transaction settings", async () => {
    // І17, Р4: default пише в таблицю з відкладеним тригером споживача;
    // той спрацьовує на `SET CONSTRAINTS` уже після повернення
    // налаштувань транзакції, а не під `row_security = off`
    const sql = {
      "custom-tables/Fills/Fills.meta.json": logTable(
        9410,
        "Fills",
        "fills",
        "mark"
      ),
      "custom-tables/RlsLog/RlsLog.meta.json": logTable(
        9420,
        "RlsLog",
        "rls_log",
        "rls"
      ),
      "sql/app/fills.sql": `CREATE FUNCTION app.note_default() RETURNS text LANGUAGE plpgsql VOLATILE SET search_path = '' AS $$ BEGIN INSERT INTO app.fills (mark) VALUES ('x'); RETURN 'n/a'; END $$;
CREATE FUNCTION app.log_rls() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$ BEGIN INSERT INTO app.rls_log (rls) VALUES (pg_catalog.current_setting('row_security')); RETURN NULL; END $$;
CREATE CONSTRAINT TRIGGER fills_rls AFTER INSERT ON app.fills DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.log_rls();`,
    }
    const before = await compiled({ [NOTES]: notes(), ...sql })
    const after = await compiled({
      [NOTES]: notes({ ...REQUIRED, default: "app.note_default()" }),
      ...sql,
    })
    await inTarget(EMPTY, async (url) => {
      await establish(url, before)
      await query(url, rows(null, null))
      const artifact = planned(await plan(url, after))
      backfillOf(artifact)
      const outcome = await apply(url, artifact, after)
      expect(outcome.diagnostics).toEqual([])
      expect(outcome.status).toBe("committed")
      expect(await notesOf(url)).toEqual(["n/a", "n/a"])
      expect(await query(url, "select rls from app.rls_log")).toEqual([
        { rls: "on" },
        { rls: "on" },
      ])
    })
  })

  it("refuses a platform trigger disabled before the fill", async () => {
    // І16: вимкнений тригер механіки (прийнятий дрейф) пропустив би підвищення
    // версії заповненого рядка, а в режимі `D` його ніхто не ввімкне
    const party = (over: Json = {}) =>
      catalog("Party", {
        id: uuid(9001),
        attributes: [
          attribute("note", {
            id: uuid(9002),
            type: "String",
            length: 20,
            ...over,
          }),
        ],
      })
    const before = await compiled({ [PARTY]: party() })
    const after = await compiled({
      [PARTY]: party({ required: true, defaultValue: "n/a" }),
    })
    const mechanics = platformTriggers({ schema: "app", name: "party" })[0]!
    await inTarget(EMPTY, async (url) => {
      await establish(url, before)
      await query(
        url,
        `insert into app.party (id, note) values (gen_random_uuid(), null);
         alter table app.party disable trigger ${mechanics.trigger};`
      )
      // Доказ плану виконує той самий раннер на копії, тож відмову дає вже
      // план: режим вимкнення двигун не моделює, і кроку, що ввімкнув би
      // тригер, немає
      const outcome = await plan(url, after)
      expect(outcome.status).toBe("refused")
      expect(params(outcome, "apply.backfill-triggers-changed")).toEqual([
        {
          step: expect.stringMatching(/^s\d+$/),
          table: "app.party",
          reason: "platform",
          triggers: mechanics.trigger,
        },
      ])
    })
  })

  it("refuses one constant default for several NULL values of a unique column", async () => {
    // І18: однакове значення дало б `23505` на кроці
    const unique = (type: Json) => ({
      ...(notes(type) as unknown as Json),
      uniques: [{ name: "notes_note_key", columns: ["note"] }],
    })
    const before = await compiled({
      [NOTES]: unique({ type: "String", length: 20 }),
    })
    const after = await compiled({ [NOTES]: unique(FILLED) })
    await inTarget(EMPTY, async (url) => {
      await establish(url, before)
      await query(url, rows(null, null, "a"))
      const outcome = await plan(url, after)
      expect(outcome.status).toBe("refused")
      expect(params(outcome, "plan.backfill-unique")).toEqual([
        expect.objectContaining({
          table: "app.notes",
          column: "note",
          rows: 2,
        }),
      ])
    })
  })

  it("refuses the fill of a table with descendants with the promotion code", async () => {
    // І15, Р13: тригери нащадка перелік таблиці не бачить
    const before = await compiled({ [NOTES]: notes() })
    const after = await compiled({ [NOTES]: notes(FILLED) })
    await inTarget(EMPTY, async (url) => {
      await establish(url, before)
      await query(url, rows(null))
      await query(
        asSuperuser(url),
        `create schema other;
         create table other.notes_child () inherits (app.notes);`
      )
      const outcome = await plan(url, after)
      expect(outcome.status).toBe("refused")
      expect(params(outcome, "plan.promotion-unsupported")).toEqual([
        expect.objectContaining({
          write: "backfill",
          reason: "dataStepTable",
          table: "app.notes",
        }),
      ])
    })
  })
})
