import pg from "pg"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  canonicalRenames,
  readEquivalenceObjects,
  type EngineScope,
  type EquivalenceObject,
} from "simetra/schema"
import { createApplyDatabase, createPgDeltaEngine } from ".."
import {
  shadowDatabaseCount,
  testDatabaseUrl,
} from "../../../../simetra/test/support"

/**
 * SQL ключів канонічних імен (рішення 4 плану П3-2a) на справжній базі: копія
 * після перейменувань таблиць і колонок і бажана тінь дають рівні ключі для
 * еквівалентних об'єктів, а кроки `canonicalRenames` прибирають їх із diff
 * двигуна, зберігши лічильник послідовності. Ціль кожного тесту — окрема
 * база від `withDesiredShadow`.
 */

const engine = createPgDeltaEngine()
const stack = { url: testDatabaseUrl() }
const scope: EngineScope = { schemas: ["app"], provider: "supabase" }
const reader = createApplyDatabase({ readOnly: true })
const writer = createApplyDatabase({ readOnly: false })

let shadowsBefore = 0
beforeEach(async () => {
  shadowsBefore = await shadowDatabaseCount()
})
afterEach(async () => {
  expect(await shadowDatabaseCount()).toBe(shadowsBefore)
})

async function other<R extends Record<string, unknown>>(
  url: string,
  sql: string
): Promise<R[]> {
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    return (await client.query<R>(sql)).rows
  } finally {
    await client.end()
  }
}

/** Окрема база з `sql`; базу прибирає порт. */
async function inDatabase<T>(
  target: string,
  sql: string,
  fn: (url: string) => Promise<T>
): Promise<T> {
  const outcome = await engine.withDesiredShadow(
    { target: { url: target } },
    sql,
    scope,
    (db) => fn(db.url)
  )
  if (outcome.status !== "loaded")
    throw new Error(
      `database did not load: ${outcome.diagnostics.map((d) => d.message).join("; ")}`
    )
  return outcome.value
}

const inTarget = <T>(sql: string, fn: (url: string) => Promise<T>) =>
  inDatabase(stack.url, sql, fn)

const read = (url: string, table: string): Promise<EquivalenceObject[]> =>
  reader.transaction({ url }, "rollback", (tx) =>
    readEquivalenceObjects(tx, [{ schema: "app", name: table }])
  )

const named = (
  objects: readonly EquivalenceObject[],
  name: string
): EquivalenceObject => {
  const found = objects.find((o) => o.name === name)
  if (found === undefined) throw new Error(`no equivalence object ${name}`)
  return found
}

/** Стан цілі до промоції: прийнята таблиця з власними іменами об'єктів. */
const CLONE = `
create schema app;
create table app.owners (id bigint primary key);
create table app.legacy (
  id serial,
  code text,
  owner bigint,
  name text,
  constraint legacy_pk primary key (id),
  constraint legacy_code_uq unique (code),
  constraint legacy_owner_fk foreign key (owner)
    references app.owners (id) on delete cascade
);
create index legacy_name_ix on app.legacy (name);
`

/** Бажаний стан: ті самі об'єкти під іменами виду. */
const DESIRED = `
create schema app;
create table app.owners (id bigint primary key);
create table app.items (
  id serial primary key,
  code text unique,
  owner bigint references app.owners (id) on delete cascade,
  title text
);
create index items_title_idx on app.items (title);
`

const CANONICAL: readonly (readonly [string, string])[] = [
  ["legacy_pk", "items_pkey"],
  ["legacy_code_uq", "items_code_key"],
  ["legacy_owner_fk", "items_owner_fkey"],
  ["legacy_name_ix", "items_title_idx"],
  ["legacy_id_seq", "items_id_seq"],
]

describe("readEquivalenceObjects", () => {
  it("gives the renamed clone and the desired shadow equal keys", async () => {
    await inTarget(CLONE, async (clone) => {
      await other(
        clone,
        `alter table app.legacy rename to items;
         alter table app.items rename column name to title;`
      )
      const cloneObjects = await read(clone, "items")
      await inDatabase(clone, DESIRED, async (shadow) => {
        const shadowObjects = await read(shadow, "items")
        for (const [from, to] of CANONICAL) {
          const c = named(cloneObjects, from)
          const s = named(shadowObjects, to)
          expect({ kind: c.kind, key: c.key, valid: c.valid }).toEqual({
            kind: s.kind,
            key: s.key,
            valid: true,
          })
        }
        // FK посилається на таблицю в новому імені, кваліфіковано схемою
        expect(named(cloneObjects, "legacy_owner_fk").key).toContain(
          "REFERENCES app.owners(id) ON DELETE CASCADE"
        )
        // R10: колонка-власник і ознака, що DEFAULT вживає саме цю послідовність
        expect(named(cloneObjects, "legacy_id_seq").key).toBe(
          JSON.stringify(["id", true])
        )
      })
    })
  })

  it("keys the shape without the name", async () => {
    await inTarget(
      `create schema app;
       create table app.p (id int primary key);
       create table app.k (
         a int, b int, r int,
         constraint k_cascade foreign key (r) references app.p (id) on delete cascade,
         constraint k_restrict foreign key (r) references app.p (id) on delete restrict
       );
       create unique index k_incl on app.k (a) include (b);
       create unique index k_both on app.k (a, b);
       alter table app.k add constraint k_check check (a > 0) not valid;`,
      async (url) => {
        const before = await read(url, "k")
        expect(named(before, "k_incl").key).not.toBe(
          named(before, "k_both").key
        )
        expect(named(before, "k_cascade").key).not.toBe(
          named(before, "k_restrict").key
        )
        expect(named(before, "k_check").valid).toBe(false)
        expect(named(before, "k_incl").valid).toBe(true)

        await other(url, "alter index app.k_incl rename to k_renamed")
        expect(named(await read(url, "k"), "k_renamed").key).toBe(
          named(before, "k_incl").key
        )
      }
    )
  })

  it("leaves search_path intact", async () => {
    await inTarget(CLONE, async (url) => {
      const [before, after] = await reader.transaction(
        { url },
        "rollback",
        async (tx) => {
          const path = async (): Promise<unknown> =>
            (
              await tx.query<{ p: string }>(
                "select current_setting('search_path') as p"
              )
            )[0]?.p
          const first = await path()
          await readEquivalenceObjects(tx, [{ schema: "app", name: "legacy" }])
          return [first, await path()]
        }
      )
      expect(after).toBe(before)
      expect(after).not.toBe("pg_catalog, pg_temp")
    })
  })
})

describe("canonicalRenames", () => {
  it("removes the equivalent objects from the engine diff and keeps the counter", async () => {
    await inTarget(CLONE, async (clone) => {
      await other(
        clone,
        `insert into app.owners values (1);
         insert into app.legacy (code, owner) values ('x', 1), ('y', 1);
         alter table app.legacy rename to items;
         alter table app.items rename column name to title;`
      )
      await inDatabase(clone, DESIRED, async (shadow) => {
        const diff = async () =>
          engine.plan(
            (await engine.extract({ url: clone }, scope)).catalog,
            (await engine.extract({ url: shadow }, scope)).catalog,
            scope
          ).actions
        // Без канонічних імен двигун перебудовує кожен з об'єктів
        expect((await diff()).length).toBeGreaterThan(0)

        const { steps, tempNames } = canonicalRenames(
          await read(clone, "items"),
          await read(shadow, "items"),
          new Map()
        )
        expect(steps).toHaveLength(CANONICAL.length)
        expect(tempNames.size).toBe(0)
        await writer.transaction({ url: clone }, "commit", async (tx) => {
          for (const s of steps) await tx.query(s.sql)
        })

        expect((await diff()).map((a) => a.sql)).toEqual([])
        const [seq] = await other<{ last_value: string }>(
          clone,
          "select last_value from app.items_id_seq"
        )
        expect(seq?.last_value).toBe("2")
      })
    })
  })

  it("does not match an index with another operator class", async () => {
    // `text_pattern_ops` і клас за замовчуванням — різні індекси: хибне
    // перейменування сховало б зняття індексу користувача за чужим іменем
    await inTarget(
      `create schema app;
       create table app.items (code text);
       create index legacy_code_pattern on app.items (code text_pattern_ops);`,
      async (clone) => {
        await inDatabase(
          clone,
          `create schema app;
           create table app.items (code text);
           create index items_code_idx on app.items (code);`,
          async (shadow) => {
            const { steps, renames } = canonicalRenames(
              await read(clone, "items"),
              await read(shadow, "items"),
              new Map()
            )
            expect(steps).toEqual([])
            expect(renames).toEqual([])
            // Індекс копії лишається DROP двигуна, а індекс виду — CREATE
            const actions = engine.plan(
              (await engine.extract({ url: clone }, scope)).catalog,
              (await engine.extract({ url: shadow }, scope)).catalog,
              scope
            ).actions
            expect(actions.map((a) => a.sql)).toEqual(
              expect.arrayContaining([
                expect.stringMatching(/DROP INDEX .*legacy_code_pattern/),
                expect.stringMatching(/CREATE INDEX .*items_code_idx/),
              ])
            )
          }
        )
      }
    )
  })
})
