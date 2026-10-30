import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  compareFingerprints,
  readFingerprint,
  type CatalogFingerprint,
  type EngineScope,
  type FingerprintSection,
} from "simetra/schema"
import { createApplyDatabase } from ".."
import {
  testRoleName,
  testSuperuserUrl,
} from "../../../../simetra/test/support"
import {
  asSuperuser,
  dropRoles,
  inTarget as loadTarget,
  query,
} from "../../__tests__/support/db"

/**
 * SQL-відбиток каталогу. Ціль кожного тесту — окрема
 * база від `withDesiredShadow`; база стеку лише читається. Тестова роль —
 * спільна для кластера, тож її створює й прибирає суперкористувач стеку.
 */

const scope: EngineScope = { schemas: ["app"], provider: "supabase" }
const ROLE = testRoleName("fingerprint_owner")

/** Базовий стан цілі: таблиця, функція, політика, грант. */
const FIXTURE = `
  create type app.mood as enum ('a');
  create table app.t (id int primary key, name text);
  create function app.f() returns int language sql as $$ select 1 $$;
  create policy p on app.t for select to authenticated using (true);
  grant select on app.t to authenticated;
  grant create on schema app to ${ROLE};
`

beforeAll(() =>
  query(
    testSuperuserUrl(),
    `create role ${ROLE} nologin; grant ${ROLE} to postgres;`
  )
)
afterAll(() => dropRoles(ROLE))

/**
 * Розгортає `create schema app` і `setup` у тимчасову базу; її прибирає порт.
 * На відміну від спільного `inTarget`, бажаний стан — лише схема, а `setup`
 * іде окремим запитом по вже завантаженій цілі.
 */
const inTarget = <T>(
  setup: string,
  fn: (url: string) => Promise<T>
): Promise<T> =>
  loadTarget("create schema app;", scope, async (url) => {
    await query(url, setup)
    return fn(url)
  })

const read = (url: string): Promise<CatalogFingerprint> =>
  createApplyDatabase({ readOnly: true }).transaction(
    { url },
    "rollback",
    (tx) => readFingerprint(tx, scope)
  )

/** Секції, що змінилися від `mutate`, з власником. */
async function changedBy(
  url: string,
  mutate: () => Promise<unknown>
): Promise<FingerprintSection[]> {
  const before = await read(url)
  await mutate()
  const result = compareFingerprints(before, await read(url), { owner: true })
  if (!result.comparable) throw new Error("same version must be comparable")
  return result.differing
}

describe("readFingerprint", () => {
  it("is stable", async () => {
    await inTarget(FIXTURE, async (url) => {
      expect(await read(url)).toEqual(await read(url))
    })
  })

  it("leaves search_path intact", async () => {
    await inTarget(FIXTURE, async (url) => {
      const [before, after] = await createApplyDatabase({
        readOnly: true,
      }).transaction({ url }, "rollback", async (tx) => {
        const path = async (): Promise<unknown> =>
          (
            await tx.query<{ p: string }>(
              "select current_setting('search_path') as p"
            )
          )[0]?.p
        const first = await path()
        await readFingerprint(tx, scope)
        return [first, await path()]
      })
      expect(after).toBe(before)
      expect(after).not.toBe("pg_catalog")
    })
  })

  // Четвертий елемент — підготовка поверх FIXTURE до першого читання
  it.each<[string, string, FingerprintSection, string?]>([
    ["comment on table", "comment on table app.t is 'x'", "comments"],
    // Провайдер міток на стеку — `pgsodium` у `shared_preload_libraries`
    [
      "security label",
      "security label for pgsodium on column app.t.name is 'ENCRYPT WITH KEY ID 00000000-0000-0000-0000-000000000000'",
      "comments",
    ],
    [
      "comment on rule",
      "comment on rule fr on app.t is 'x'",
      "comments",
      "create rule fr as on update to app.t do also nothing",
    ],
    [
      "comment on extension",
      "comment on extension citext is 'x'",
      "comments",
      "create extension citext with schema app",
    ],
    [
      "attach partition",
      "alter table app.pt attach partition app.pt1 for values from (0) to (10)",
      "relations",
      "create table app.pt (k int) partition by range (k); create table app.pt1 (k int);",
    ],
    [
      "detach partition",
      "alter table app.pt detach partition app.pt1",
      "relations",
      "create table app.pt (k int) partition by range (k); create table app.pt1 partition of app.pt for values from (0) to (10);",
    ],
    [
      "inherit",
      "alter table app.kid inherit app.base",
      "relations",
      "create table app.base (id int); create table app.kid (id int);",
    ],
    [
      "no inherit",
      "alter table app.kid no inherit app.base",
      "relations",
      "create table app.base (id int); create table app.kid () inherits (app.base);",
    ],
    [
      "sequence cache",
      "alter sequence app.sq cache 5",
      "sequences",
      "create sequence app.sq",
    ],
    [
      "sequence owned by",
      "alter sequence app.sq owned by app.t.id",
      "sequences",
      "create sequence app.sq",
    ],
    [
      "enable row level security",
      "alter table app.t enable row level security",
      "relations",
    ],
    [
      "force row level security",
      "alter table app.t force row level security",
      "relations",
    ],
    ["grant to anon", "grant select on app.t to anon", "acl"],
    [
      "create policy",
      "create policy p2 on app.t for insert to authenticated with check (true)",
      "policies",
    ],
    [
      "function body",
      "create or replace function app.f() returns int language sql as $$ select 2 $$",
      "functions",
    ],
    [
      "security definer",
      "alter function app.f() security definer",
      "functions",
    ],
    [
      "function search_path",
      "alter function app.f() set search_path = ''",
      "functions",
    ],
    ["owner", `alter table app.t owner to ${ROLE}`, "owner"],
    ["add column", "alter table app.t add column extra int", "columns"],
    ["enum value", "alter type app.mood add value 'b'", "types"],
    [
      "default privileges",
      "alter default privileges in schema app grant select on tables to anon",
      "defaultPrivileges",
    ],
  ])("section per mutation: %s", async (_name, sql, section, setup) => {
    await inTarget(FIXTURE, async (url) => {
      if (setup !== undefined) await query(url, setup)
      expect(await changedBy(url, () => query(url, sql))).toEqual([section])
    })
  })

  describe("default privileges", () => {
    const section = (setup: string): Promise<string> =>
      inTarget(FIXTURE, async (url) => {
        await query(asSuperuser(url), setup)
        return (await read(url)).sections.defaultPrivileges
      })

    it("ignores a schema default privilege equal to the built-in default", async () => {
      // Двигун пише лише відхилення від `acldefault`, тож запис «роль собі
      // ALL» він не бачить, а відбиток без нормалізації бачив би
      expect(
        await section(
          "alter default privileges for role postgres in schema app grant all on tables to postgres"
        )
      ).toBe(await section("select 1"))
    })

    it("keeps a real schema default privilege", async () => {
      expect(
        await section(
          "alter default privileges for role postgres in schema app grant select on tables to anon"
        )
      ).not.toBe(await section("select 1"))
    })

    it("keeps a schema default privilege to its own role with grant option", async () => {
      // `WITH GRANT OPTION` — відхилення від `acldefault`, хоч роль і та сама
      expect(
        await section(
          "alter default privileges for role postgres in schema app grant all on tables to postgres with grant option"
        )
      ).not.toBe(await section("select 1"))
    })

    it("ignores a PUBLIC default privilege equal to the built-in default", async () => {
      // `EXECUTE` для `PUBLIC` на функціях — вбудований типовий стан
      expect(
        await section(
          "alter default privileges for role postgres in schema app grant execute on functions to public"
        )
      ).toBe(await section("select 1"))
    })

    it("ignores default privileges of a provider service role", async () => {
      // Поза межею двигуна: політика провайдера виключає ADP системних ролей
      expect(
        await section(
          "alter default privileges for role supabase_admin in schema app grant all on tables to anon"
        )
      ).toBe(await section("select 1"))
    })
  })

  it("sees an invalid index", async () => {
    await inTarget(FIXTURE, async (url) => {
      await query(
        url,
        "create table app.d (v int); insert into app.d values (1)"
      )
      await query(url, "create unique index d_v on app.d (v)")
      // Збій `CONCURRENTLY` на дублікатах лишає індекс із тим самим
      // визначенням, але недійсним; `CONCURRENTLY` не йде в транзакції,
      // тож окремими операторами повз порт
      const changed = await changedBy(url, async () => {
        await query(url, "drop index app.d_v")
        await query(url, "insert into app.d values (1)")
        const error = await query(
          url,
          "create unique index concurrently d_v on app.d (v)"
        ).catch((e: unknown) => e)
        expect((error as { code?: string }).code).toBe("23505")
      })
      expect(changed).toEqual(["indexes"])
    })
  })

  it("reads defaults independently of the creating session's search_path", async () => {
    const body = (fn: string): string => `
      create function app.one() returns int language sql as $$ select 1 $$;
      create domain app.dd as int default ${fn};
      create table app.dt (x int default ${fn});
    `
    const bare = await inTarget(
      `set search_path = app, public; ${body("one()")} reset search_path;`,
      read
    )
    const qualified = await inTarget(body("app.one()"), read)
    expect(compareFingerprints(bare, qualified, { owner: true })).toEqual({
      comparable: true,
      differing: [],
    })
  })

  it("sees aggregates", async () => {
    await inTarget(FIXTURE, async (url) => {
      const created = await changedBy(url, () =>
        query(url, "create aggregate app.s(int) (sfunc = int4pl, stype = int)")
      )
      // Новий об'єкт має власника й типовий ACL (`acldefault`): `EXECUTE`
      // для власника й `public`
      expect(created).toEqual(["functions", "acl", "owner", "inventory"])
      expect(
        await changedBy(url, () =>
          query(
            url,
            "create or replace aggregate app.s(int) (sfunc = int4pl, stype = int, initcond = '1')"
          )
        )
      ).toEqual(["functions"])
    })
  })

  it.each<[string, string, "owner" | "superuser"]>([
    ["composite type", "create type app.c as (x int)", "owner"],
    ["range type", "create type app.r as range (subtype = int4)", "owner"],
    [
      "operator",
      "create operator app.=== (leftarg = int, rightarg = int, function = int4eq)",
      "owner",
    ],
    [
      "operator class",
      "create operator class app.oc for type int using btree as operator 1 <, function 1 btint4cmp(int, int)",
      "superuser",
    ],
    [
      "operator family",
      "create operator family app.of using btree",
      "superuser",
    ],
    ["collation", 'create collation app.co from "C"', "owner"],
    [
      "text search configuration",
      "create text search configuration app.tc (copy = simple)",
      "owner",
    ],
    [
      "text search dictionary",
      "create text search dictionary app.td (template = simple)",
      "owner",
    ],
    ["statistics", "create statistics app.st on id, name from app.t", "owner"],
    ["rule", "create rule r as on insert to app.t do instead nothing", "owner"],
  ])("inventory per class: %s", async (_name, sql, as) => {
    await inTarget(FIXTURE, async (url) => {
      const by = as === "superuser" ? asSuperuser(url) : url
      expect(await changedBy(url, () => query(by, sql))).toContain("inventory")
    })
  })

  it("owner-independent across databases", async () => {
    await inTarget(FIXTURE, async (a) => {
      const owned = await inTarget(
        `${FIXTURE}\nalter table app.t owner to ${ROLE};`,
        read
      )
      const own = await read(a)
      expect(compareFingerprints(own, owned, { owner: false })).toEqual({
        comparable: true,
        differing: [],
      })
      expect(compareFingerprints(own, owned, { owner: true })).toEqual({
        comparable: true,
        differing: ["owner"],
      })
    })
  })

  it("ignores column order", async () => {
    const ab = await inTarget("create table app.x (a int, b text);", read)
    const ba = await inTarget("create table app.x (b text, a int);", read)
    expect(ab.sections.columns).toBe(ba.sections.columns)
  })

  it("sees provider surface policies", async () => {
    await inTarget(FIXTURE, async (url) => {
      expect(
        await changedBy(url, () =>
          query(
            url,
            "create policy app_read on storage.objects for select to authenticated using (true)"
          )
        )
      ).toEqual(["policies"])
      // `storage.app_extra` — на поверхні тригерів, але не політик: політика
      // на ній не входить у відбиток, хоч схема та сама, що в `objects`
      expect(
        await changedBy(url, () =>
          query(
            url,
            "create table storage.app_extra (id int); create policy app_x on storage.app_extra for select to authenticated using (true)"
          )
        )
      ).toEqual([])
    })
  })
})
