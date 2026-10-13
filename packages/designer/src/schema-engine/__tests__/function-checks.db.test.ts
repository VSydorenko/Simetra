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
import { compile } from "simetra/compiler"
import {
  desiredForApply,
  executePlan,
  footprintTables,
  planFootprint,
  planLocks,
  readFingerprint,
  readProviderLocks,
  readSessionSearchPath,
  SUPABASE_LOCKS,
  tableKey,
  type ApplyDesired,
  type CatalogFingerprint,
  type ExecutablePlan,
  type ExecuteOptions,
  type PlanStep,
  type TableLock,
} from "simetra/schema"
import { createApplyDatabase, createPgDeltaEngine } from ".."
import {
  catalog,
  metaFiles,
  project,
  shadowDatabaseCount,
  testDatabaseUrl,
  testSuperuserUrl,
} from "../../../../simetra/test/support"

/**
 * Ревалідація тіл функцій раннером на справжній базі (рішення 1–5 плану
 * П3-2b-1): валідатори мов `sql` і `plpgsql` до кроків і після, під шляхом
 * ревалідації й власними налаштуваннями функції, проти базової лінії в тій
 * самій транзакції. Ціль кожного тесту — окрема база від `withDesiredShadow`,
 * як у `execute-plan.db.test.ts`.
 */

const engine = createPgDeltaEngine()
const stack = { url: testDatabaseUrl() }
const apply = createApplyDatabase({ readOnly: false })
const reader = createApplyDatabase({ readOnly: true })

/** Роль-власник, членом якої роль застосування не є. */
const STRANGER = "simetra_fncheck_owner"

const PREAMBLE: ExecutablePlan["preamble"] = [
  { name: "search_path", value: "pg_catalog" },
  { name: "check_function_bodies", value: "off" },
]

const options: ExecuteOptions = {
  mode: "apply",
  planHash: "c".repeat(64),
  allow: [],
  snapshot: { tables: [] },
  sleep: async () => {},
}

let desired: ApplyDesired

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

/** Та сама база, але сесією суперкористувача стеку. */
function asSuperuser(url: string): string {
  const su = new URL(testSuperuserUrl())
  su.pathname = new URL(url).pathname
  return su.toString()
}

beforeAll(async () => {
  const compiled = await compile(
    metaFiles({
      "project.meta.json": project({ defaultSchema: "app" }),
      "catalogs/Party/Party.meta.json": catalog("Party"),
    })
  )
  expect(compiled.diagnostics).toEqual([])
  desired = await desiredForApply(compiled.model!)
  // Роль могла лишитися від убитого прогону
  await other(testSuperuserUrl(), `drop role if exists ${STRANGER}`)
  await other(testSuperuserUrl(), `create role ${STRANGER} nologin`)
})
afterAll(() => other(testSuperuserUrl(), `drop role if exists ${STRANGER}`))

let shadowsBefore = 0
beforeEach(async () => {
  shadowsBefore = await shadowDatabaseCount()
})
afterEach(async () => {
  expect(await shadowDatabaseCount()).toBe(shadowsBefore)
})

/**
 * Ціль: бажаний стан моделі, далі `setup` роллю застосування й `superuser`
 * сесією суперкористувача; базу прибирає порт.
 */
async function inTarget<T>(
  setup: string,
  fn: (url: string) => Promise<T>,
  superuser?: string
): Promise<T> {
  const outcome = await engine.withDesiredShadow(
    { target: stack },
    desired.sql,
    desired.scope,
    async (target) => {
      await other(target.url, setup)
      if (superuser !== undefined)
        await other(asSuperuser(target.url), superuser)
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
  reader.transaction({ url }, "rollback", (tx) =>
    readFingerprint(tx, desired.scope)
  )

/**
 * Відбиток бажаного стану: окрема база, де `setup` і кроки вже виконано;
 * `bodiesOff` — кроки під вимкненою валідацією тіл, як під преамбулою.
 */
const desiredFingerprint = (
  setup: string,
  steps: readonly PlanStep[],
  o: { bodiesOff?: boolean; superuser?: string } = {}
): Promise<CatalogFingerprint> =>
  inTarget(
    `${setup};\n${o.bodiesOff === true ? "set check_function_bodies = off;\n" : ""}${steps.map((s) => `${s.sql};`).join("\n")}`,
    read,
    o.superuser
  )

function step(id: string, sql: string, over: Partial<PlanStep> = {}): PlanStep {
  return {
    id,
    origin: "engine",
    sql,
    verb: "create",
    class: "catalogOnly",
    lockClass: "none",
    transactionality: "transactional",
    newSegmentBefore: false,
    lockedTables: [],
    produces: [],
    consumes: [],
    destroys: [],
    produced: [],
    destroyed: [],
    consumed: [],
    dataLoss: false,
    rewriteRisk: false,
    guards: [],
    ...over,
  }
}

const EMPTY_MODEL = { tables: [], enumTypes: [], units: [] }

/** Блокування за слідом кроків без моделей (кроки тут без FK). */
function locksOf(steps: readonly PlanStep[]): TableLock[] {
  const footprint = planFootprint(steps, {
    source: EMPTY_MODEL,
    desired: EMPTY_MODEL,
    typeChanges: [],
    newToOld: new Map(),
    columnsNewToOld: new Map(),
    live: [],
    providerStatements: new Map(),
    providerLocks: [],
  })
  const rights = new Map(
    footprintTables(footprint).map((t) => [tableKey(t.schema, t.name), true])
  )
  return planLocks({ footprint, rights }).locks
}

const sessionPath = (url: string): Promise<string> =>
  reader.transaction({ url }, "rollback", readSessionSearchPath)

/** План над живою ціллю; `desiredFingerprint` — з окремої бази. */
async function planFor(
  url: string,
  steps: PlanStep[],
  desiredFingerprint: CatalogFingerprint,
  over: Partial<ExecutablePlan> = {}
): Promise<ExecutablePlan> {
  return {
    fromHash: null,
    toHash: "1".repeat(64),
    scope: desired.scope,
    engine: engine.identity,
    steps,
    requiredPermissions: [],
    drift: null,
    role: "postgres",
    locks: locksOf(steps),
    implicitLocks: [],
    providerLocks: await reader.transaction({ url }, "rollback", (tx) =>
      readProviderLocks(tx, "postgres", SUPABASE_LOCKS)
    ),
    preamble: [],
    revalidationSearchPath: await sessionPath(url),
    // Режим, який план дає на стеку: supautils ставить розширення
    plpgsqlCheck: "transient",
    promotion: null,
    environment: { defaultPrivileges: [] },
    resultCatalog: EMPTY_MODEL,
    targetFingerprint: await read(url),
    desiredFingerprint,
    ...over,
  }
}

const TABLE_T = "create table app.t (id int, a text)"
const NEUTRAL = step("s1", "CREATE TABLE app.n (id int)")
const RENAME_A = step("s1", "ALTER TABLE app.t RENAME COLUMN a TO b", {
  verb: "alter",
  lockClass: "accessExclusive",
  lockedTables: [{ schema: "app", name: "t" }],
})

const columnsOf = async (url: string, table: string): Promise<string[]> =>
  (
    await other<{ name: string }>(
      url,
      `select attname as name from pg_attribute where attrelid = '${table}'::regclass and attnum > 0 and not attisdropped order by attnum`
    )
  ).map((r) => r.name)

describe("function body revalidation", () => {
  it("refuses a step that breaks a SQL function body", async () => {
    const setup = `${TABLE_T};
      create function app.fa() returns text language sql as $$ select a from app.t $$`
    const steps = [RENAME_A]
    const wanted = await desiredFingerprint(setup, steps)
    await inTarget(setup, async (url) => {
      const outcome = await executePlan(
        apply,
        { url },
        await planFor(url, steps, wanted),
        options
      )
      expect(outcome).toMatchObject({
        status: "failed",
        diagnostics: [{ code: "apply.function-check-failed" }],
      })
      expect(outcome.diagnostics[0]!.params).toMatchObject({ count: 1 })
      expect(String(outcome.diagnostics[0]!.params.functions)).toContain(
        "app.fa(): 42703"
      )
      expect(await columnsOf(url, "app.t")).toEqual(["id", "a"])
    })
  })

  // Review Focus 1: під преамбулою крок проходить, а валідатор `plpgsql`
  // компілює тіло в ревалідації
  it("refuses a plpgsql body that does not compile although the preamble turned validation off", async () => {
    const steps = [
      step(
        "s1",
        "CREATE FUNCTION app.bad() RETURNS int LANGUAGE plpgsql AS $$ BEGIN RETURN; END $$"
      ),
    ]
    const wanted = await desiredFingerprint("select 1", steps, {
      bodiesOff: true,
    })
    await inTarget("select 1", async (url) => {
      const outcome = await executePlan(
        apply,
        { url },
        await planFor(url, steps, wanted, { preamble: PREAMBLE }),
        options
      )
      expect(outcome).toMatchObject({
        status: "failed",
        diagnostics: [{ code: "apply.function-check-failed" }],
      })
      expect(String(outcome.diagnostics[0]!.params.functions)).toContain(
        "app.bad()"
      )
      expect(
        await other(url, "select to_regprocedure('app.bad()') is null as gone")
      ).toEqual([{ gone: true }])
    })
  })

  it("does not count a SQL function that was broken before the plan", async () => {
    const setup = `${TABLE_T};
      set check_function_bodies = off;
      create function app.fb() returns int language sql as $$ select nope from app.t $$`
    const steps = [NEUTRAL]
    const wanted = await desiredFingerprint(setup, steps)
    await inTarget(setup, async (url) => {
      const outcome = await executePlan(
        apply,
        { url },
        await planFor(url, steps, wanted),
        options
      )
      expect(outcome).toMatchObject({ status: "committed", diagnostics: [] })
    })
  })

  // Без `proconfig` функції `t` не знайшлася б ні до кроків, ні після, і
  // перейменування колонки пройшло б непоміченим
  it("validates a SQL function under its own search_path", async () => {
    const setup = `${TABLE_T};
      create function app.fc() returns text language sql set search_path = app as $$ select a from t $$`
    for (const [steps, broken] of [
      [[NEUTRAL], false],
      [[RENAME_A], true],
    ] as const) {
      const wanted = await desiredFingerprint(setup, steps)
      await inTarget(setup, async (url) => {
        const outcome = await executePlan(
          apply,
          { url },
          await planFor(url, [...steps], wanted),
          options
        )
        if (!broken) {
          expect(outcome).toMatchObject({ status: "committed" })
          return
        }
        expect(outcome).toMatchObject({
          status: "failed",
          diagnostics: [{ code: "apply.function-check-failed" }],
        })
        expect(String(outcome.diagnostics[0]!.params.functions)).toContain(
          "app.fc()"
        )
      })
    }
  })

  // Review Focus 2: валідатор чекає на чужий замок таблиці поза слідом
  it("retries instead of blaming a function when a table it names is locked", async () => {
    const setup = `create schema other;
      create table other.far (x int);
      create function app.fr() returns int language sql as $$ select x from other.far $$`
    const steps = [NEUTRAL]
    const wanted = await desiredFingerprint(setup, steps)
    await inTarget(setup, async (url) => {
      const plan = await planFor(url, steps, wanted)
      const holder = new pg.Client({ connectionString: url })
      holder.on("error", () => {})
      await holder.connect()
      try {
        await holder.query(
          "begin; lock table other.far in access exclusive mode"
        )
        const outcome = await executePlan(apply, { url }, plan, {
          ...options,
          timeouts: { lockTimeoutMs: 200, attempts: 2 },
        })
        expect(outcome).toMatchObject({
          status: "failed",
          attempts: 2,
          diagnostics: [
            { code: "apply.lock-timeout", params: { attempts: 2 } },
          ],
        })
      } finally {
        await holder.end()
      }
      expect(
        await other(url, "select to_regclass('app.n') is null as absent")
      ).toEqual([{ absent: true }])
    })
  })

  // Обмеження плану 2a «тіло функції з посиланням уперед» знято: під
  // преамбулою функція створюється до таблиці, а ревалідація після кроків
  // таблицю вже бачить
  it("proves a forward-referencing SQL function", async () => {
    const steps = [
      step(
        "s1",
        "CREATE FUNCTION app.ff() RETURNS bigint LANGUAGE sql AS $$ SELECT count(*) FROM app.later $$"
      ),
      step("s2", "CREATE TABLE app.later (id int)"),
    ]
    const wanted = await desiredFingerprint("select 1", steps, {
      bodiesOff: true,
    })
    const outcome = await inTarget("select 1", async (url) =>
      executePlan(
        apply,
        { url },
        await planFor(url, steps, wanted, { preamble: PREAMBLE }),
        { ...options, mode: "proof" }
      )
    )
    expect(outcome).toMatchObject({ status: "committed", diagnostics: [] })
  })

  it("warns about a function it cannot check", async () => {
    const setup = `${TABLE_T};
      create function app.fh() returns text language sql as $$ select a from app.t $$`
    const superuser = `alter function app.fh() owner to ${STRANGER};
      revoke execute on function app.fh() from public`
    const steps = [NEUTRAL]
    const wanted = await desiredFingerprint(setup, steps, { superuser })
    await inTarget(
      setup,
      async (url) => {
        const outcome = await executePlan(
          apply,
          { url },
          await planFor(url, steps, wanted),
          options
        )
        expect(outcome).toMatchObject({
          status: "committed",
          diagnostics: [
            {
              code: "apply.function-check-blind",
              severity: "warning",
              params: { count: 1, functions: "app.fh()" },
            },
          ],
        })
      },
      superuser
    )
  })

  it("leaves the transaction settings as they were", async () => {
    // Запис стану йде після ревалідації: тригер на ledger бачить, що
    // повернула фаза 15
    const setup = `create table app.seen (path text, bodies text);
      create function app.seen_state() returns trigger language plpgsql as $$
      begin
        insert into app.seen values (current_setting('search_path'), current_setting('check_function_bodies'));
        return null;
      end $$;
      create trigger seen_state after insert on simetra.ledger
        for each row execute function app.seen_state();`
    const steps = [NEUTRAL]
    const wanted = await desiredFingerprint(setup, steps)
    await inTarget(setup, async (url) => {
      const session = await sessionPath(url)
      // Шлях ревалідації інший за сесійний: повернення видно
      const outcome = await executePlan(
        apply,
        { url },
        await planFor(url, steps, wanted, {
          preamble: PREAMBLE,
          revalidationSearchPath: "app, public",
        }),
        options
      )
      expect(outcome).toMatchObject({ status: "committed" })
      expect(session).not.toBe("app, public")
      expect(
        await other<{ path: string; bodies: string }>(
          url,
          "select path, bodies from app.seen"
        )
      ).toEqual([{ path: session, bodies: "on" }])
    })
  })
})

/**
 * `plpgsql_check` проти базової лінії (рішення 4 плану П3-2b-1): тимчасове
 * розширення в точці збереження, наявне — на місці.
 */
describe("plpgsql_check", () => {
  const FP = `${TABLE_T};
    create function app.fp() returns text language plpgsql as $$ declare r text; begin select a into r from app.t limit 1; return r; end $$`

  /** Прогін `steps` на цілі після `setup`; `fn` бачить результат і базу. */
  async function run(
    setup: string,
    steps: PlanStep[],
    over: Partial<ExecutablePlan> = {},
    fn: (
      outcome: Awaited<ReturnType<typeof executePlan>>,
      url: string
    ) => Promise<void> = async () => {},
    superuser?: string
  ) {
    const wanted = await desiredFingerprint(
      setup,
      steps,
      superuser === undefined ? {} : { superuser }
    )
    await inTarget(
      setup,
      async (url) =>
        fn(
          await executePlan(
            apply,
            { url },
            await planFor(url, steps, wanted, over),
            options
          ),
          url
        ),
      superuser
    )
  }

  const checkFailed = (
    outcome: Awaited<ReturnType<typeof executePlan>>
  ): string => {
    expect(outcome).toMatchObject({
      status: "failed",
      diagnostics: [{ code: "apply.function-check-failed" }],
    })
    return String(outcome.diagnostics[0]!.params.functions)
  }

  it("refuses a step that breaks a plpgsql body", async () => {
    await run(FP, [RENAME_A], {}, async (outcome, url) => {
      expect(checkFailed(outcome)).toContain("app.fp(): 42703")
      expect(await columnsOf(url, "app.t")).toEqual(["id", "a"])
    })
    // Валідатор мови колонок у запитах тіла не розв'язує: без розширення
    // той самий крок проходить, тож відмову вище дав саме plpgsql_check
    await run(
      FP,
      [RENAME_A],
      { plpgsqlCheck: "unavailable" },
      async (outcome) => expect(outcome).toMatchObject({ status: "committed" })
    )
  })

  it("checks a trigger function with each table it fires on", async () => {
    const setup = `${TABLE_T};
      create table app.t2 (id int, a text);
      create function app.tg() returns trigger language plpgsql as $$ begin new.a := upper(new.a); return new; end $$;
      create trigger tg before insert on app.t for each row execute function app.tg();
      create trigger tg before insert on app.t2 for each row execute function app.tg()`
    await run(setup, [RENAME_A], {}, async (outcome) => {
      const functions = checkFailed(outcome)
      expect(outcome.diagnostics[0]!.params.count).toBe(1)
      expect(functions).toMatch(/^app\.tg\(\) on app\.t: /)
      expect(functions).not.toContain("app.t2")
    })
  })

  it("checks a trigger with transition tables", async () => {
    const setup = `${TABLE_T};
      create function app.tt() returns trigger language plpgsql as $$ begin perform count(*) from n; return null; end $$;
      create trigger tt after insert on app.t referencing new table as n
        for each statement execute function app.tt()`
    await run(setup, [NEUTRAL], {}, async (outcome) =>
      expect(outcome).toMatchObject({ status: "committed", diagnostics: [] })
    )
  })

  // Review Focus 3: базова лінія поглинає наявну помилку функції чужої
  // ролі, а нова помилка в тій самій функції однаково ловиться
  it("keeps an error of another role's function that was there before", async () => {
    const setup = `${TABLE_T};
      create function app.fo() returns int language plpgsql as $$ declare x int; begin select nope into x from app.t; perform a from app.t; return x; end $$`
    const superuser = `alter function app.fo() owner to ${STRANGER}`
    await run(
      setup,
      [NEUTRAL],
      {},
      async (outcome) =>
        expect(outcome).toMatchObject({ status: "committed", diagnostics: [] }),
      superuser
    )
    await run(
      setup,
      [RENAME_A],
      {},
      async (outcome) => {
        expect(checkFailed(outcome)).toContain("app.fo(): 42703")
        expect(outcome.diagnostics[0]!.params.count).toBe(1)
      },
      superuser
    )
  })

  // Review Focus 4: oid перествореної функції інший — збіг за сигнатурою
  it("matches a function the plan recreates with the same error", async () => {
    const body = `RETURNS int LANGUAGE plpgsql AS $$ DECLARE x int; BEGIN SELECT nope INTO x FROM app.t; RETURN x; END $$`
    const setup = `${TABLE_T};
      create function app.fz() ${body}`
    await run(
      setup,
      [
        step("s1", "DROP FUNCTION app.fz()", { verb: "drop" }),
        step("s2", `CREATE FUNCTION app.fz() ${body}`),
      ],
      {},
      async (outcome) =>
        expect(outcome).toMatchObject({ status: "committed", diagnostics: [] })
    )
  })

  it("installs the extension only for the check", async () => {
    const leftover = (url: string) =>
      other(
        url,
        `select
           exists (select 1 from pg_extension where extname = 'plpgsql_check') as extension,
           exists (select 1 from pg_namespace where nspname = 'simetra_plpgsql_check') as schema`
      )
    const broken = await desiredFingerprint(FP, [RENAME_A])
    const neutral = await desiredFingerprint(FP, [NEUTRAL])
    await inTarget(FP, async (url) => {
      // Розширення в цій базі немає, і помилку тіла, якої валідатор мови не
      // бачить, ловить лише воно: тимчасове встановлення справді відбулося
      expect(await leftover(url)).toEqual([{ extension: false, schema: false }])
      const failed = await executePlan(
        apply,
        { url },
        await planFor(url, [RENAME_A], broken),
        options
      )
      expect(failed).toMatchObject({
        status: "failed",
        diagnostics: [{ code: "apply.function-check-failed" }],
      })
      expect(String(failed.diagnostics[0]!.params.functions)).toContain(
        "app.fp(): 42703"
      )
      // Та сама база, закомічений прогін: розширення й схема не пережили
      // своєї точки збереження
      const committed = await executePlan(
        apply,
        { url },
        await planFor(url, [NEUTRAL], neutral),
        options
      )
      expect(committed).toMatchObject({ status: "committed", diagnostics: [] })
      expect(await leftover(url)).toEqual([{ extension: false, schema: false }])
    })
  })

  it("uses an installed extension in place", async () => {
    const setup = `${FP};
      create schema ext;
      create extension plpgsql_check schema ext`
    await run(
      setup,
      [RENAME_A],
      { plpgsqlCheck: "installed" },
      async (outcome, url) => {
        expect(checkFailed(outcome)).toContain("app.fp(): 42703")
        expect(
          await other(
            url,
            "select extnamespace::regnamespace::text as schema from pg_extension where extname = 'plpgsql_check'"
          )
        ).toEqual([{ schema: "ext" }])
      }
    )
  })

  it("refuses a taken check schema", async () => {
    const setup = `${TABLE_T};
      create schema simetra_plpgsql_check`
    await run(setup, [NEUTRAL], {}, async (outcome, url) => {
      expect(outcome).toMatchObject({
        status: "refused",
        diagnostics: [
          {
            code: "apply.temp-name-taken",
            params: { name: "simetra_plpgsql_check" },
          },
        ],
      })
      expect(
        await other(url, "select to_regclass('app.n') is null as absent")
      ).toEqual([{ absent: true }])
    })
  })
})
