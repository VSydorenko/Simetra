import pg from "pg"
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest"
import {
  compareFingerprints,
  readFingerprint,
  type CatalogFingerprint,
  type EngineScope,
  type FingerprintSection,
} from "simetra/schema"
import { createApplyDatabase, createPgDeltaEngine } from ".."
import {
  shadowDatabaseCount,
  testDatabaseUrl,
  testSuperuserUrl,
} from "../../../../simetra/test/support"

/**
 * SQL-відбиток каталогу (план П3-1, задача 4). Ціль кожного тесту — окрема
 * база від `withDesiredShadow`; база стеку лише читається. Тестова роль —
 * спільна для кластера, тож її створює й прибирає суперкористувач стеку.
 */

const engine = createPgDeltaEngine()
const stack = { url: testDatabaseUrl() }
const scope: EngineScope = { schemas: ["app"], provider: "supabase" }
const ROLE = "simetra_fingerprint_owner"

/** Базовий стан цілі: таблиця, функція, політика, грант. */
const FIXTURE = `
  create type app.mood as enum ('a');
  create table app.t (id int primary key, name text);
  create function app.f() returns int language sql as $$ select 1 $$;
  create policy p on app.t for select to authenticated using (true);
  grant select on app.t to authenticated;
  grant create on schema app to ${ROLE};
`

/** Один запит (чи кілька операторів) з окремого з'єднання. */
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

/**
 * Суперкористувач у тимчасовій базі цілі: класи й сімейства операторів
 * створює лише суперкористувач, а `postgres` на стеку ним не є.
 */
function superuserIn(url: string): string {
  const su = new URL(testSuperuserUrl())
  su.pathname = new URL(url).pathname
  return su.toString()
}

async function dropRole(): Promise<void> {
  await other(testSuperuserUrl(), `drop role if exists ${ROLE}`)
}

beforeAll(async () => {
  // Роль могла лишитися від убитого прогону
  await dropRole()
  await other(
    testSuperuserUrl(),
    `create role ${ROLE} nologin; grant ${ROLE} to postgres;`
  )
})
afterAll(dropRole)

let shadowsBefore = 0
beforeEach(async () => {
  shadowsBefore = await shadowDatabaseCount()
})
afterEach(async () => {
  expect(await shadowDatabaseCount()).toBe(shadowsBefore)
})

/** Розгортає `create schema app` і `setup` у тимчасову базу; її прибирає порт. */
async function inTarget<T>(
  setup: string,
  fn: (url: string) => Promise<T>
): Promise<T> {
  const outcome = await engine.withDesiredShadow(
    { target: stack },
    "create schema app;",
    scope,
    async (target) => {
      await other(target.url, setup)
      return fn(target.url)
    }
  )
  if (outcome.status !== "loaded")
    throw new Error(
      `target did not load: ${outcome.diagnostics.map((d) => d.message).join("; ")}`
    )
  return outcome.value
}

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

  it.each<[string, string, FingerprintSection]>([
    ["comment on table", "comment on table app.t is 'x'", "comments"],
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
  ])("section per mutation: %s", async (_name, sql, section) => {
    await inTarget(FIXTURE, async (url) => {
      expect(await changedBy(url, () => other(url, sql))).toEqual([section])
    })
  })

  it("sees aggregates", async () => {
    await inTarget(FIXTURE, async (url) => {
      const created = await changedBy(url, () =>
        other(url, "create aggregate app.s(int) (sfunc = int4pl, stype = int)")
      )
      expect(created).toEqual(
        expect.arrayContaining(["functions", "inventory"])
      )
      expect(
        await changedBy(url, () =>
          other(
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
      const by = as === "superuser" ? superuserIn(url) : url
      expect(await changedBy(url, () => other(by, sql))).toContain("inventory")
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
          other(
            url,
            "create policy app_read on storage.objects for select to authenticated using (true)"
          )
        )
      ).toEqual(["policies"])
      expect(
        await changedBy(url, () =>
          other(url, "create table storage.app_extra (id int)")
        )
      ).toEqual([])
    })
  })
})
