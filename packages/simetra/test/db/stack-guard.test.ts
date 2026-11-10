import {
  existsSync,
  globSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { PROVIDER_EVENT_SOURCES, PROVIDER_OWNER_ROLES } from "simetra/model"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import designerConfig, {
  ON_POSTGRES as DESIGNER_ON_POSTGRES,
} from "../../../designer/vitest.config"
import simetraConfig, {
  ON_POSTGRES as SIMETRA_ON_POSTGRES,
} from "../../vitest.config"
import type { Exec, Fetch } from "./external"
import {
  PROVIDER_ENV,
  SUPERUSER_PRELUDE,
  TEST_STACKS,
  type TestProvider,
} from "./profile"
import {
  acquireLock,
  diff,
  IDENTITY_SQL,
  leakMessage,
  endChecks,
  leftoverReport,
  lockPath,
  startChecks,
} from "./stack-guard"
import {
  type ClientFactory,
  dropRunDatabase,
  manualSweepSql,
  stackMismatch,
  stopRunBackends,
  sweepRun,
} from "./sweep"

const PROVIDERS: TestProvider[] = ["supabase", "postgres"]

describe("lockPath", () => {
  it.each([
    ["supabase", "simetra-db-stack.lock"],
    ["postgres", "simetra-db-stack-postgres.lock"],
  ] as const)("lock path per provider: %s", (p, file) => {
    expect(basename(lockPath(p))).toBe(file)
  })

  // Різні шляхи — прогони різних стеків не чекають один одного
  it("differs between providers", () => {
    expect(lockPath("supabase")).not.toBe(lockPath("postgres"))
  })
})

describe("leakMessage", () => {
  it.each(PROVIDERS)(
    "names the %s superuser for dropping an added role",
    (p) => {
      const message = leakMessage(
        [{ kind: "roles", name: "simetra_probe_abc123", change: "added" }],
        p
      )
      expect(message).toContain(
        `  DROP OWNED BY "simetra_probe_abc123"; DROP ROLE "simetra_probe_abc123";  -- as ${TEST_STACKS[p].superuserName}, in database postgres`
      )
    }
  )

  // `DROP OWNED BY` діє в поточній базі: на `postgres` тести працюють у `simetra`
  it("postgres: names DROP OWNED BY in the test database too", () => {
    const message = leakMessage(
      [{ kind: "roles", name: "simetra_probe_abc123", change: "added" }],
      "postgres"
    )
    expect(message).toContain(
      `  DROP OWNED BY "simetra_probe_abc123";  -- as postgres, in database simetra`
    )
    expect(message.indexOf("in database simetra")).toBeLessThan(
      message.indexOf("in database postgres")
    )
  })
})

describe("external resources", () => {
  const empty = {
    databases: [],
    roles: [],
    schemas: [],
    extensions: [],
    templates: [],
    containers: [],
    buckets: [],
  }

  it("a container or bucket left by the run is a leak with its cleanup", () => {
    const changes = diff(empty, {
      ...empty,
      containers: ["simetra-run-abc123-x"],
      buckets: ["run-abc123"],
    })
    expect(changes).toEqual([
      { kind: "containers", name: "simetra-run-abc123-x", change: "added" },
      { kind: "buckets", name: "run-abc123", change: "added" },
    ])
    const message = leakMessage(changes, "postgres")
    expect(message).toContain("  docker rm -f -v simetra-run-abc123-x")
    expect(message).toMatch(/run-abc123.*empty and delete in Garage/)
  })

  it("names leftover buckets under their run and leftover containers", () => {
    const lines = leftoverReport(
      {
        databases: [],
        roles: [],
        containers: ["stray"],
        buckets: ["run-abc123"],
      },
      "postgres"
    )
    expect(lines).toContainEqual(
      expect.stringMatching(/run abc123: bucket run-abc123/)
    )
    expect(lines).toContainEqual(
      expect.stringContaining("docker rm -f -v stray")
    )
  })
})

describe("dropping a tagged database", () => {
  const statements = async (isTemplate: boolean): Promise<string[]> => {
    const sql: string[] = []
    const client = {
      query: async (text: string) => {
        sql.push(text)
        return { rows: [] }
      },
      escapeIdentifier: (name: string) => `"${name}"`,
    }
    await dropRunDatabase(client, "simetra_tpl_abc123_k3j2h1", isTemplate)
    return sql
  }

  // Postgres відмовляє `DROP` бази з `datistemplate`: без зняття ознаки шаблон
  // тегованого прогону лишався б на стеку назавжди
  it("clears the template flag before the DROP", async () => {
    expect(await statements(true)).toEqual([
      'ALTER DATABASE "simetra_tpl_abc123_k3j2h1" WITH IS_TEMPLATE false',
      'DROP DATABASE "simetra_tpl_abc123_k3j2h1" WITH (FORCE)',
    ])
  })

  it("a plain database is only dropped", async () => {
    expect(await statements(false)).toEqual([
      'DROP DATABASE "simetra_tpl_abc123_k3j2h1" WITH (FORCE)',
    ])
  })

  it("the manual sweep SQL and the leak message clear the flag first", () => {
    expect(manualSweepSql("abc123", "postgres")).toContain(
      "ALTER DATABASE %I WITH IS_TEMPLATE false; DROP DATABASE %I WITH (FORCE);"
    )
    const message = leakMessage(
      [{ kind: "databases", name: "t_abc123", change: "added" }],
      "postgres"
    )
    expect(message.indexOf("IS_TEMPLATE false")).toBeGreaterThan(-1)
    expect(message.indexOf("IS_TEMPLATE false")).toBeLessThan(
      message.indexOf("DROP DATABASE")
    )
  })
})

describe("manualSweepSql", () => {
  it.each(PROVIDERS)("runs as the %s superuser", (p) => {
    expect(manualSweepSql("abc123", p).split("\n")[0]).toMatch(
      new RegExp(`^-- as ${TEST_STACKS[p].superuserName}; `)
    )
  })

  it("supabase: one block, in database postgres", () => {
    expect(
      manualSweepSql("abc123", "supabase")
        .split("\n")
        .filter((line) => line.startsWith("-- in database"))
    ).toEqual(["-- in database postgres:"])
  })

  it("postgres: DROP OWNED BY in database simetra, then the rest in postgres", () => {
    const lines = manualSweepSql("abc123", "postgres").split("\n")
    expect(lines.filter((line) => line.startsWith("-- in database"))).toEqual([
      "-- in database simetra:",
      "-- in database postgres:",
    ])
    expect(lines[2]).toContain("SELECT format('DROP OWNED BY %I;', rolname)")
  })
})

/**
 * Підставні з'єднання сторожа: кожне записує базу, оператори й відповідає
 * за `answer`. Порядок записів — порядок операторів у всіх з'єднаннях.
 */
function fakeConnections(
  answer: (sql: string, database: string) => Record<string, unknown>[]
) {
  const log: { database: string; sql: string }[] = []
  const factory: ClientFactory = (config) => {
    const url = new URL(String(config.connectionString))
    const database = decodeURIComponent(url.pathname.slice(1))
    return {
      connect: async () => {
        log.push({ database, sql: `connect ${url.username}${url.search}` })
      },
      query: async <R>(sql: string) => {
        log.push({ database, sql })
        return { rows: answer(sql, database) as R[] }
      },
      end: async () => undefined,
      escapeIdentifier: (name: string) => `"${name}"`,
    }
  }
  return { log, factory }
}

const noDocker: Exec = async () => ""
const noBuckets: Fetch = async () => new Response("[]")

const OWNER = PROVIDER_OWNER_ROLES.postgres
const USER_COLUMNS = PROVIDER_EVENT_SOURCES.postgres.find(
  (s) => s.schema === "better_auth" && s.table === "user"
)!.columns

/** Каталог `better_auth` бази `simetra`, яким його лишає `db:pg:start`. */
interface IdentityState {
  columns: string[]
  owners: { object: string; owner: string }[]
  grants: { object: string; grantee: string; privilege: string }[]
  defaultAcl: { type: string; role: string }[]
  triggers: { name: string; enabled: string }[]
}

const identityState = (): IdentityState => ({
  columns: [...USER_COLUMNS],
  owners: [
    { object: "schema better_auth", owner: "simetra_auth" },
    { object: "relation session", owner: "simetra_auth" },
    { object: "relation user", owner: "simetra_auth" },
    { object: "relation user_pkey", owner: "simetra_auth" },
  ],
  grants: [
    {
      object: "schema better_auth",
      grantee: "simetra_auth",
      privilege: "USAGE",
    },
    { object: "schema better_auth", grantee: OWNER, privilege: "USAGE" },
    { object: "relation user", grantee: "simetra_auth", privilege: "SELECT" },
    { object: "relation user", grantee: OWNER, privilege: "TRIGGER" },
  ],
  defaultAcl: [],
  triggers: [{ name: "RI_ConstraintTrigger_a_16474", enabled: "O" }],
})

const IDENTITY_QUERIES = new Set<string>(Object.values(IDENTITY_SQL))

// Відповідь на запити звірки `better_auth` з поточного стану; відбиток —
// увесь стан, тож будь-яка його зміна між знімками змінює й відбиток
function identityAnswer(
  state: IdentityState,
  sql: string
): Record<string, unknown>[] | undefined {
  if (sql === IDENTITY_SQL.columns)
    return state.columns.map((name) => ({ name }))
  if (sql === IDENTITY_SQL.owners) return state.owners
  if (sql === IDENTITY_SQL.grants) return state.grants
  if (sql === IDENTITY_SQL.defaultAcl) return state.defaultAcl
  if (sql === IDENTITY_SQL.triggers) return state.triggers
  if (sql === IDENTITY_SQL.fingerprint)
    return [{ fingerprint: JSON.stringify(state) }]
  return undefined
}

describe("guard connections on the postgres stack", () => {
  beforeEach(() => {
    vi.stubEnv(PROVIDER_ENV, "postgres")
    for (const name of [
      "SIMETRA_TEST_DATABASE_URL",
      "SIMETRA_TEST_SUPERUSER_URL",
    ]) {
      vi.stubEnv(name, "")
      delete process.env[name]
    }
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  const stackAnswer =
    (role: { role: string; superuser: boolean }) =>
    (sql: string): Record<string, unknown>[] => {
      if (sql.includes("'supabase_admin'")) return [{ present: false }]
      if (sql.startsWith("select current_user as role")) return [role]
      return identityAnswer(identityState(), sql) ?? []
    }
  const owner = { role: PROVIDER_OWNER_ROLES.postgres, superuser: false }

  // Кожне адмінське з'єднання — у базі `postgres` і з прелюдією до першого
  // запиту; лише перевірка ролі адреси тестів іде без прелюдії: вона й
  // перевіряє стартову роль
  it("assertStack and the snapshot run in database postgres after the prelude", async () => {
    const { log, factory } = fakeConnections(stackAnswer(owner))
    await startChecks("postgres", {
      client: factory,
      exec: noDocker,
      fetch: noBuckets,
    })
    const connects = log.filter((entry) => entry.sql.startsWith("connect"))
    expect(connects.map((c) => `${c.database} ${c.sql}`)).toEqual([
      "postgres connect postgres?options=-c%20role%3Dsimetra_owner",
      "postgres connect postgres",
      "simetra connect postgres?options=-c%20role%3Dsimetra_owner",
      // Звірка `better_auth` (Р3) — у базі тестів, до знімка
      "simetra connect postgres",
      "postgres connect postgres",
      "simetra connect postgres",
    ])
    log.forEach((entry, i) => {
      if (!entry.sql.startsWith("connect")) return
      const next = log.slice(i + 1, i + 3).map((e) => e.sql)
      if (entry.sql.includes("options") && entry.database === "simetra")
        expect(next[0]).toMatch(/^select current_user as role/)
      else expect(next).toEqual([...SUPERUSER_PRELUDE])
    })
    const queries = log.filter(
      (e) => !e.sql.startsWith("connect") && !SUPERUSER_PRELUDE.includes(e.sql)
    )
    for (const { sql } of queries) expect(sql).toMatch(/pg_catalog\.pg_/)
    // Схеми й розширення — з кожної бази стека: і тести, і базовий стан пишуть
    // у свою. Запити звірки `better_auth` теж читають `pg_namespace`, але не
    // є знімком
    expect(
      queries
        .filter(
          (e) =>
            /pg_namespace|pg_extension/.test(e.sql) &&
            !IDENTITY_QUERIES.has(e.sql)
        )
        .map(
          (e) =>
            `${e.database} ${/pg_namespace/.test(e.sql) ? "schemas" : "extensions"}`
        )
        .sort()
    ).toEqual([
      "postgres extensions",
      "postgres schemas",
      "simetra extensions",
      "simetra schemas",
    ])
    // Факти шаблонів — з `pg_database` бази `postgres`: до шаблону з
    // `datallowconn = false` сторож не під'єднується
    expect(
      queries.filter((e) => /pg_database/.test(e.sql)).map((e) => e.database)
    ).toEqual(["postgres", "postgres"])
    expect(connects.some((c) => c.database.endsWith("_template"))).toBe(false)
  })

  it.each([
    { role: "postgres", superuser: true },
    { role: "simetra_user", superuser: false },
    { role: PROVIDER_OWNER_ROLES.postgres, superuser: true },
  ])(
    "refuses a test URL that runs as $role (superuser $superuser) before the snapshot",
    async (role) => {
      const { log, factory } = fakeConnections(stackAnswer(role))
      await expect(
        startChecks("postgres", {
          client: factory,
          exec: noDocker,
          fetch: noBuckets,
        })
      ).rejects.toThrow(
        `test database URL does not run as ${PROVIDER_OWNER_ROLES.postgres} (SIMETRA_TEST_DATABASE_URL?)`
      )
      expect(log.some((e) => e.sql.includes("pg_database"))).toBe(false)
    }
  )

  it("stopRunBackends runs in database postgres after the prelude", async () => {
    const { log, factory } = fakeConnections(() => [])
    await stopRunBackends("abc123", { client: factory })
    expect(log.map((e) => `${e.database} ${e.sql}`).slice(0, 4)).toEqual([
      "postgres connect postgres",
      ...SUPERUSER_PRELUDE.map((sql) => `postgres ${sql}`),
      expect.stringMatching(
        /^postgres select pid from pg_catalog\.pg_stat_activity/
      ),
    ])
  })

  it("the sweep drops what a run role owns in database simetra and in postgres", async () => {
    let roleListed = false
    const { log, factory } = fakeConnections((sql) => {
      if (sql.includes("'supabase_admin'")) return [{ present: false }]
      if (sql.includes("from pg_catalog.pg_roles where rolname ~")) {
        if (roleListed) return []
        roleListed = true
        return [{ name: "simetra_probe_abc123" }]
      }
      return []
    })
    const result = await sweepRun("abc123", {
      client: factory,
      exec: noDocker,
      fetch: noBuckets,
    })
    expect(result.dropped).toContain("simetra_probe_abc123")
    expect(
      log
        .filter((e) => e.sql.startsWith("DROP OWNED BY"))
        .map((e) => `${e.database} ${e.sql}`)
    ).toEqual([
      'simetra DROP OWNED BY "simetra_probe_abc123"',
      'postgres DROP OWNED BY "simetra_probe_abc123"; DROP ROLE "simetra_probe_abc123"',
    ])
  })
})

describe("the better_auth check at the start of a run on the postgres stack", () => {
  beforeEach(() => {
    vi.stubEnv(PROVIDER_ENV, "postgres")
    for (const name of [
      "SIMETRA_TEST_DATABASE_URL",
      "SIMETRA_TEST_SUPERUSER_URL",
    ]) {
      vi.stubEnv(name, "")
      delete process.env[name]
    }
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  const start = (
    state: IdentityState,
    o: { supabaseAdmin?: boolean; announce?: () => void } = {}
  ) => {
    const connections = fakeConnections((sql) => {
      if (sql.includes("'supabase_admin'"))
        return [{ present: o.supabaseAdmin ?? false }]
      if (sql.startsWith("select current_user as role"))
        return [{ role: OWNER, superuser: false }]
      return identityAnswer(state, sql) ?? []
    })
    const announce = (): void => {
      connections.log.push({ database: "-", sql: "announce" })
      o.announce?.()
    }
    return {
      log: connections.log,
      run: () =>
        startChecks("postgres", {
          client: connections.factory,
          exec: noDocker,
          fetch: noBuckets,
          announce,
        }),
    }
  }
  const snapshotStarted = (log: { sql: string }[]): boolean =>
    log.some((e) => e.sql.includes("pg_database"))

  it("runs after assertStack and before the snapshot, in database simetra", async () => {
    const { log, run } = start(identityState())
    await run()
    const at = (match: (sql: string) => boolean): number[] =>
      log.flatMap((e, i) => (match(e.sql) ? [i] : []))
    const stack = at((sql) => sql.includes("'supabase_admin'"))
    const identity = at((sql) => IDENTITY_QUERIES.has(sql))
    const snapshot = at((sql) => sql.includes("pg_database"))
    expect(identity.length).toBeGreaterThan(0)
    expect(Math.min(...identity)).toBeGreaterThan(Math.max(...stack))
    expect(Math.max(...identity)).toBeLessThan(Math.min(...snapshot))
    expect(new Set(identity.map((i) => log[i]!.database))).toEqual(
      new Set(["simetra"])
    )
  })

  it.each<[string, (s: IdentityState) => void, RegExp]>([
    [
      "an extra grantee in relacl",
      (s) =>
        s.grants.push({
          object: "relation user",
          grantee: "simetra_user",
          privilege: "SELECT",
        }),
      /relation user grants SELECT to simetra_user/,
    ],
    [
      "a grant to PUBLIC on the schema",
      (s) =>
        s.grants.push({
          object: "schema better_auth",
          grantee: "PUBLIC",
          privilege: "USAGE",
        }),
      /schema better_auth grants USAGE to PUBLIC/,
    ],
    [
      "a privilege of the owner beyond TRIGGER",
      (s) =>
        s.grants.push({
          object: "relation user",
          grantee: OWNER,
          privilege: "INSERT",
        }),
      /relation user grants INSERT to simetra_owner/,
    ],
    [
      "another owner of a relation",
      (s) => (s.owners[1]!.owner = OWNER),
      /relation session is owned by simetra_owner/,
    ],
    [
      "another owner of the schema",
      (s) => (s.owners[0]!.owner = "postgres"),
      /schema better_auth is owned by postgres/,
    ],
    [
      "a pg_default_acl row of the schema",
      (s) => s.defaultAcl.push({ type: "r", role: "simetra_auth" }),
      /default privileges of simetra_auth for type r in schema better_auth/,
    ],
    [
      'a disabled trigger on better_auth."user"',
      (s) => s.triggers.push({ name: "simetra_provision_user", enabled: "D" }),
      /trigger simetra_provision_user on user is disabled/,
    ],
  ])("refuses %s before the snapshot", async (_label, change, detail) => {
    const state = identityState()
    change(state)
    const { log, run } = start(state)
    const failure = run()
    await expect(failure).rejects.toThrow(
      "better_auth of database simetra is not in the db:pg:start state ("
    )
    await expect(failure).rejects.toThrow(detail)
    expect(snapshotStarted(log)).toBe(false)
  })

  it("an enabled trigger of the platform passes", async () => {
    const state = identityState()
    state.triggers.push({ name: "simetra_provision_user", enabled: "O" })
    await expect(start(state).run()).resolves.toBeDefined()
  })

  it("a missing column is refused with pnpm db:pg:start", async () => {
    const state = identityState()
    state.columns = state.columns.filter((c) => c !== "isAnonymous")
    const { log, run } = start(state)
    const failure = run()
    await expect(failure).rejects.toThrow(
      'better_auth."user" of database simetra does not match this branch (missing column(s) isAnonymous: run pnpm db:pg:start'
    )
    await expect(failure).rejects.not.toThrow(/owner's call/)
    expect(snapshotStarted(log)).toBe(false)
  })

  it("an extra column is refused as the owner's call", async () => {
    const state = identityState()
    state.columns.push("nickname")
    const { log, run } = start(state)
    const failure = run()
    await expect(failure).rejects.toThrow(
      /does not match this branch \(extra column\(s\) nickname: .*stopping the stack is the owner's call/
    )
    expect(snapshotStarted(log)).toBe(false)
  })

  it("another column order is refused as the owner's call", async () => {
    const state = identityState()
    state.columns.reverse()
    await expect(start(state).run()).rejects.toThrow(
      /does not match this branch \(column order .*owner's call/
    )
  })

  // Рядок «DB run … on postgres stack» на чужому стеку збрехав би в лозі
  it("prints the start line only after assertStack passed", async () => {
    const announce = vi.fn()
    const wrong = start(identityState(), { supabaseAdmin: true, announce })
    await expect(wrong.run()).rejects.toThrow(/this is not the postgres stack/)
    expect(announce).not.toHaveBeenCalled()

    const { log, run } = start(identityState(), { announce })
    await run()
    expect(announce).toHaveBeenCalledOnce()
    const line = log.findIndex((e) => e.sql === "announce")
    const stack = log.flatMap((e, i) =>
      e.sql.includes("'supabase_admin'") ? [i] : []
    )
    expect(line).toBeGreaterThan(Math.max(...stack))
  })
})

describe("the better_auth check on the supabase stack", () => {
  beforeEach(() => {
    vi.stubEnv(PROVIDER_ENV, "supabase")
    for (const name of [
      "SIMETRA_TEST_DATABASE_URL",
      "SIMETRA_TEST_SUPERUSER_URL",
    ]) {
      vi.stubEnv(name, "")
      delete process.env[name]
    }
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  // Схемою ідентичності Supabase володіє провайдер: стану `db:pg:start` у неї немає
  it("is not run", async () => {
    const { log, factory } = fakeConnections((sql) => {
      if (sql.includes("'supabase_admin'")) return [{ present: true }]
      if (sql.startsWith("select current_user as role"))
        return [{ role: PROVIDER_OWNER_ROLES.supabase, superuser: false }]
      return []
    })
    const deps = { client: factory, exec: noDocker, fetch: noBuckets }
    const before = await startChecks("supabase", deps)
    await endChecks("supabase", before, deps)
    expect(before.identity).toBeUndefined()
    expect(log.some((e) => IDENTITY_QUERIES.has(e.sql))).toBe(false)
  })
})

describe("acquireLock", () => {
  // Два DB-проєкти в одному процесі ділять env прогону, а свого замка процес
  // не дочекався б — замість 45 хвилин очікування одразу відмова
  it("refuses a lock this process already holds", async () => {
    const dir = mkdtempSync(join(tmpdir(), "simetra-lock-"))
    try {
      const lock = join(dir, "stack.lock")
      writeFileSync(lock, `${process.pid}\n${process.cwd()}\nnow\n`)
      await expect(acquireLock(lock, "postgres")).rejects.toThrow(
        "one DB project per vitest process (run each with its own --project)"
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("stackMismatch", () => {
  it.each([
    { p: "supabase", supabaseAdmin: true, mismatch: false },
    { p: "supabase", supabaseAdmin: false, mismatch: true },
    { p: "postgres", supabaseAdmin: false, mismatch: false },
    { p: "postgres", supabaseAdmin: true, mismatch: true },
  ] as const)(
    "$p stack with supabase_admin=$supabaseAdmin: mismatch $mismatch",
    ({ p, supabaseAdmin, mismatch }) => {
      const result = stackMismatch(p, { supabaseAdmin })
      if (mismatch) expect(result).toMatch(/SIMETRA_TEST_/)
      else expect(result).toBeNull()
    }
  )
})

describe("vitest configs", () => {
  const packages = [
    {
      dir: fileURLToPath(new URL("../..", import.meta.url)),
      config: simetraConfig,
    },
    {
      dir: fileURLToPath(new URL("../../../designer", import.meta.url)),
      config: designerConfig,
    },
  ]
  const files = packages.flatMap(({ dir, config }) =>
    (config.test?.projects ?? []).flatMap((project) => {
      if (typeof project !== "object" || !("test" in project)) return []
      const test = project.test ?? {}
      const name = `${basename(dir)}/${String(test.name)}`
      return [test.globalSetup, test.setupFiles]
        .flatMap((value) =>
          value === undefined ? [] : Array.isArray(value) ? value : [value]
        )
        .map((path) => ({ name, path: resolve(dir, path) }))
    })
  )

  // Перейменований чи видалений файл vitest помітив би лише на старті DB-проєкту
  it.each(files)("globalSetup paths exist: $name $path", ({ path }) => {
    expect(existsSync(path)).toBe(true)
  })

  // Файли проєкту за його ж `include` і `exclude`, як їх збирає vitest
  const projects = packages.flatMap(({ dir, config }) =>
    (config.test?.projects ?? []).flatMap((project) => {
      if (typeof project !== "object" || !("test" in project)) return []
      const test = project.test ?? {}
      const setups = [test.globalSetup ?? []].flat()
      return [
        {
          name: `${basename(dir)}/${String(test.name)}`,
          dir,
          stack: setups
            .map((path) => /stack-guard\.(\w+)\.ts$/.exec(path)?.[1])
            .find((s) => s !== undefined),
          files: globSync(test.include ?? [], {
            cwd: dir,
            exclude: test.exclude ?? [],
          }).sort(),
        },
      ]
    })
  )
  const project = (name: string) => projects.find((p) => p.name === name)!

  // Зламаний `include` інакше дав би зелений рядок CI без жодного тесту
  it.each(projects.filter((p) => p.stack !== undefined))(
    "DB project $name has at least one file",
    ({ files }) => {
      expect(files.length).toBeGreaterThan(0)
    }
  )

  it.each([
    ["simetra", SIMETRA_ON_POSTGRES],
    ["designer", DESIGNER_ON_POSTGRES],
  ] as const)(
    "%s: db excludes every ON_POSTGRES file and db-pg includes it",
    (pkg, moved) => {
      const { dir } = project(`${pkg}/db`)
      for (const pattern of moved) {
        const files = globSync(pattern, { cwd: dir })
        expect(files.length, pattern).toBeGreaterThan(0)
        for (const file of files) {
          expect(project(`${pkg}/db`).files).not.toContain(file)
          expect(project(`${pkg}/db-pg`).files).toContain(file)
        }
      }
    }
  )

  // Шлях guard і прибиральника переривання — на кожному стеку рівно раз
  it("interrupt.db.test.ts runs once on each stack", () => {
    const interrupt = "test/db/interrupt.db.test.ts"
    const on = (stack: string) =>
      projects
        .filter((p) => p.stack === stack && p.files.includes(interrupt))
        .map((p) => p.name)
    expect(on("supabase")).toEqual(["simetra/db-supabase"])
    expect(on("postgres")).toEqual(["simetra/db-pg"])
  })

  // Проєкт без stack-guard ішов би на стек без замка й без звірки
  it("guards every DB project", () => {
    expect(
      new Set(
        files
          .filter(({ path }) => basename(path).startsWith("stack-guard"))
          .map(({ name }) => name)
      )
    ).toEqual(
      new Set([
        "simetra/db",
        "simetra/db-supabase",
        "simetra/db-pg",
        "simetra/bench",
        "designer/db",
        "designer/db-supabase",
        "designer/db-pg",
      ])
    )
  })
})

describe("leftoverReport", () => {
  const NOW = Date.UTC(2026, 9, 15, 12, 0, 0)
  const stamp = (minutesAgo: number): string =>
    (NOW - minutesAgo * 60_000).toString(36)
  const sweepCommand = (p: TestProvider, tag: string): string =>
    `    cd packages/simetra && SIMETRA_TEST_PROVIDER=${p} node --import tsx test/db/sweep.ts ${tag}`

  it("is empty when no run objects are on the stack", () => {
    expect(
      leftoverReport(
        {
          databases: ["postgres", "metahub_copy", "p3_3_spike_a"],
          roles: ["postgres", "simetra_build_plan_owner"],
        },
        "supabase",
        NOW
      )
    ).toEqual([])
  })

  it.each(PROVIDERS)(
    "names tagged objects by tag with that tag's %s sweep command",
    (p) => {
      const lines = leftoverReport(
        {
          databases: [
            "postgres",
            `pgdelta_shadow_${stamp(30)}_abc123_k3j2h1`,
            "simetra_copy_abc123_q1w2e3",
            "simetra_copy_zz9zz9_q1w2e3",
          ],
          roles: ["simetra_build_plan_owner_abc123", "simetra_probe_zz9zz9"],
        },
        p,
        NOW
      )
      expect(lines).toEqual([
        expect.stringContaining("they are not removed"),
        `  run abc123: database pgdelta_shadow_${stamp(30)}_abc123_k3j2h1 (30 min old), database simetra_copy_abc123_q1w2e3, role simetra_build_plan_owner_abc123`,
        sweepCommand(p, "abc123"),
        "  run zz9zz9: database simetra_copy_zz9zz9_q1w2e3, role simetra_probe_zz9zz9",
        sweepCommand(p, "zz9zz9"),
      ])
    }
  )

  it("names untagged shadows with a DROP each, apart from tagged objects", () => {
    const untagged = `pgdelta_shadow_${stamp(90)}_6uepn5`
    const lines = leftoverReport(
      {
        databases: [untagged, "simetra_copy_abc123_q1w2e3"],
        roles: [],
      },
      "supabase",
      NOW
    )
    expect(lines.slice(-2)).toEqual([
      expect.stringContaining("they are not removed"),
      `  DROP DATABASE "${untagged}" WITH (FORCE);  -- 90 min old`,
    ])
    expect(lines.filter((line) => line.includes("sweep.ts"))).toEqual([
      sweepCommand("supabase", "abc123"),
    ])
  })
})

describe("the end of a run on the postgres stack", () => {
  beforeEach(() => {
    vi.stubEnv(PROVIDER_ENV, "postgres")
    for (const name of [
      "SIMETRA_TEST_DATABASE_URL",
      "SIMETRA_TEST_SUPERUSER_URL",
    ]) {
      vi.stubEnv(name, "")
      delete process.env[name]
    }
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  interface StackState {
    schemas: Record<string, string[]>
    extensions: Record<string, string[]>
    template: { allowconn: boolean; acl: string }
    identity: IdentityState
  }

  const baseState = (): StackState => ({
    schemas: { postgres: ["public"], simetra: ["public", "better_auth"] },
    extensions: { postgres: ["plpgsql"], simetra: ["plpgsql"] },
    template: { allowconn: false, acl: "{simetra_owner=CTc/simetra_owner}" },
    identity: identityState(),
  })

  // Підставний стек: відповіді читають поточний стан, тож зміна стану між
  // знімками — те, що лишив прогін
  const stack = (state: StackState) =>
    fakeConnections((sql, database) => {
      if (sql.includes("'supabase_admin'")) return [{ present: false }]
      if (sql.startsWith("select current_user as role"))
        return [{ role: PROVIDER_OWNER_ROLES.postgres, superuser: false }]
      const identity = identityAnswer(state.identity, sql)
      if (identity !== undefined) return identity
      if (sql.includes("pg_namespace"))
        return (state.schemas[database] ?? []).map((name) => ({ name }))
      if (sql.includes("pg_extension"))
        return (state.extensions[database] ?? []).map((name) => ({ name }))
      if (sql.includes("datallowconn"))
        return [
          {
            name: "simetra_template",
            allowconn: state.template.allowconn,
            template: true,
            owner: "simetra_owner",
            acl: state.template.acl,
          },
        ]
      return []
    }).factory

  it.each<[string, (state: StackState) => void]>([
    ["a schema left in simetra", (s) => s.schemas.simetra!.push("leak")],
    ["a schema left in postgres", (s) => s.schemas.postgres!.push("leak")],
    [
      "an extension left in simetra",
      (s) => s.extensions.simetra!.push("citext"),
    ],
    [
      "an extension left in postgres",
      (s) => s.extensions.postgres!.push("citext"),
    ],
    [
      "datallowconn of simetra_template turned on",
      (s) => (s.template.allowconn = true),
    ],
    [
      "a grant on simetra_template",
      (s) =>
        (s.template.acl = "{simetra_owner=CTc/simetra_owner,=c/simetra_owner}"),
    ],
  ])("%s fails the run", async (_label, change) => {
    const state = baseState()
    const deps = { client: stack(state), exec: noDocker, fetch: noBuckets }
    const before = await startChecks("postgres", deps)
    change(state)
    await expect(endChecks("postgres", before, deps)).rejects.toThrow(
      /left the local stack different/
    )
  })

  // Знімок стека ACL не містить: грант, лишений тестом поза відкатом, ловить
  // лише відбиток `better_auth`
  it("a grant on better_auth.user left by the run fails it", async () => {
    const state = baseState()
    const deps = { client: stack(state), exec: noDocker, fetch: noBuckets }
    const before = await startChecks("postgres", deps)
    state.identity.grants.push({
      object: "relation user",
      grantee: OWNER,
      privilege: "UPDATE",
    })
    await expect(endChecks("postgres", before, deps)).rejects.toThrow(
      /The run changed better_auth of database simetra/
    )
  })

  it("an unchanged stack passes", async () => {
    const state = baseState()
    const deps = { client: stack(state), exec: noDocker, fetch: noBuckets }
    const before = await startChecks("postgres", deps)
    await expect(endChecks("postgres", before, deps)).resolves.toBeUndefined()
  })

  it("names the database of a left schema in its cleanup", async () => {
    const state = baseState()
    const deps = { client: stack(state), exec: noDocker, fetch: noBuckets }
    const before = await startChecks("postgres", deps)
    state.schemas.simetra!.push("leak")
    await expect(endChecks("postgres", before, deps)).rejects.toThrow(
      'DROP SCHEMA "leak";  -- in database simetra'
    )
  })
})
