import { describe, expect, it } from "vitest"
import {
  canonicalRenames,
  readEquivalenceObjects,
  type EngineScope,
  type EquivalenceObject,
} from "simetra/schema"
import { createApplyDatabase, createPgDeltaEngine } from ".."
import { inTarget, query } from "../../__tests__/support/db"

/**
 * SQL ключів канонічних імен (рішення 4 плану П3-2a) на справжній базі: копія
 * після перейменувань таблиць і колонок і бажана тінь дають рівні ключі для
 * еквівалентних об'єктів, а кроки `canonicalRenames` прибирають їх із diff
 * двигуна, зберігши лічильник послідовності. Ціль кожного тесту — окрема
 * база від `withDesiredShadow`.
 */

const engine = createPgDeltaEngine()
const scope: EngineScope = { schemas: ["app"], provider: "supabase" }
const reader = createApplyDatabase({ readOnly: true })
const writer = createApplyDatabase({ readOnly: false })

/**
 * Окрема база з `sql` поруч із довільною ціллю, а не зі стеком, як спільний
 * `inTarget`: бажана тінь тут лягає біля копії; базу прибирає порт.
 */
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
    await inTarget(CLONE, scope, async (clone) => {
      await query(
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
      scope,
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

        await query(url, "alter index app.k_incl rename to k_renamed")
        expect(named(await read(url, "k"), "k_renamed").key).toBe(
          named(before, "k_incl").key
        )
      }
    )
  })

  it("keys whether the operator classes are the defaults", async () => {
    // Форма `covered` (рішення 11 плану П3-3a1) покриває лише індекс з
    // типовими класами, а ім'я класу типовості не каже: її несе остання частина
    await inTarget(
      `create schema app;
       create table app.items (code text);
       create index items_code_pattern on app.items (code text_pattern_ops);
       create index items_code_plain on app.items (code);`,
      scope,
      async (url) => {
        const objects = await read(url, "items")
        const pattern = JSON.parse(
          named(objects, "items_code_pattern").key
        ) as unknown[]
        const plain = JSON.parse(
          named(objects, "items_code_plain").key
        ) as unknown[]
        expect(pattern).not.toEqual(plain)
        expect(pattern.at(-1)).toEqual([false])
        expect(plain.at(-1)).toEqual([true])
        // Колляція колонки за замовчуванням — не явна колляція індексу:
        // `covered` її пропускає саме в такій формі
        expect(plain[8]).toEqual(['pg_catalog."default"'])
      }
    )
  })

  it("leaves search_path intact", async () => {
    await inTarget(CLONE, scope, async (url) => {
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
    await inTarget(CLONE, scope, async (clone) => {
      await query(
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
        const [seq] = await query<{ last_value: string }>(
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
      scope,
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

  it("does not match an index whose operator class has other parameters", async () => {
    // Параметр класу (`siglen`, PG13+) живе в `pg_attribute.attoptions`
    // індексу, а частина колонки його не містить: без нього індекси з різною
    // сигнатурою злилися б у хибне перейменування. `tsvector_ops` для GiST —
    // вбудований клас з параметром, без розширення
    await inTarget(
      `create schema app;
       create table app.items (doc tsvector);
       create index legacy_doc_sig on app.items using gist (doc tsvector_ops (siglen = 32));`,
      scope,
      async (clone) => {
        await inDatabase(
          clone,
          `create schema app;
           create table app.items (doc tsvector);
           create index items_doc_idx on app.items using gist (doc tsvector_ops (siglen = 64));`,
          async (shadow) => {
            const { steps, renames } = canonicalRenames(
              await read(clone, "items"),
              await read(shadow, "items"),
              new Map()
            )
            expect(steps).toEqual([])
            expect(renames).toEqual([])
          }
        )
      }
    )
  })
})
