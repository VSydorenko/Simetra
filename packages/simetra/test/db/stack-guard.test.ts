import { spawn, type ChildProcess } from "node:child_process"
import { once } from "node:events"
import {
  existsSync,
  globSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { PROVIDER_EVENT_SOURCES, PROVIDER_OWNER_ROLES } from "simetra/model"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import designerConfig from "../../../designer/vitest.config"
import simetraConfig from "../../vitest.config"
import type { Exec, Fetch } from "./external"
import {
  PROVIDER_ENV,
  SUPERUSER_PRELUDE,
  profileStack,
  type TestProvider,
} from "./profile"
import {
  acquireStack,
  diff,
  IDENTITY_SQL,
  leakMessage,
  endChecks,
  leftoverReport,
  lockPath,
  probeStack,
  startChecks,
  takeStack,
} from "./stack-guard"
import {
  type ClientFactory,
  dropRunDatabase,
  assertStack,
  manualSweepSql,
  stackIndexMismatch,
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
        `  DROP OWNED BY "simetra_probe_abc123"; DROP ROLE "simetra_probe_abc123";  -- as ${profileStack(p).superuserName}, in database postgres`
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

// Тести стека N ≠ 1 ставлять SIMETRA_STACK: далі він не мусить дійти до інших
afterEach(() => {
  vi.unstubAllEnvs()
})

describe("manualSweepSql", () => {
  it.each(PROVIDERS)("runs as the %s superuser", (p) => {
    expect(manualSweepSql("abc123", p).split("\n")[0]).toMatch(
      new RegExp(`^-- as ${profileStack(p).superuserName}; `)
    )
  })

  it("names the stack in the header for N other than 1, unchanged for 1", () => {
    vi.stubEnv("SIMETRA_STACK", undefined)
    expect(manualSweepSql("abc123", "postgres").split("\n")[0]).toMatch(
      /\(DROP OWNED BY acts in the current database only\)$/
    )
    vi.stubEnv("SIMETRA_STACK", "2")
    expect(manualSweepSql("abc123", "postgres").split("\n")[0]).toMatch(
      /only\) \(stack postgres-2: connect with SIMETRA_STACK=2\)$/
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
  grants: {
    object: string
    grantee: string
    privilege: string
    grantable?: string
  }[]
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
    { object: "relation user", grantee: OWNER, privilege: "REFERENCES" },
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
      // Звірка `better_auth` — у базі тестів, до знімка
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

describe("every address of a run on stack 2", () => {
  beforeEach(() => {
    vi.stubEnv(PROVIDER_ENV, "postgres")
    vi.stubEnv("SIMETRA_STACK", "2")
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

  // Інваріант 1: адреса, обчислена не за індексом замка, веде прогін на чужий
  // стек. Усі з'єднання, запити до Garage і виклики Docker — на стек 2
  it("start, backends, sweep and end reach only stack 2", async () => {
    const urls: string[] = []
    const fetched: string[] = []
    const dockerCalls: string[] = []
    const { factory: inner } = fakeConnections((sql) => {
      if (sql.includes("'supabase_admin'"))
        return [{ present: false, stack_index: "2" }]
      if (sql.startsWith("select current_user as role"))
        return [{ role: PROVIDER_OWNER_ROLES.postgres, superuser: false }]
      return identityAnswer(identityState(), sql) ?? []
    })
    const client: ClientFactory = (config) => {
      urls.push(String(config.connectionString))
      return inner(config)
    }
    const exec: Exec = async (file, args) => {
      dockerCalls.push([file, ...args].join(" "))
      return ""
    }
    const fetch: Fetch = (async (input: Parameters<Fetch>[0]) => {
      fetched.push(String(input))
      return new Response("[]")
    }) as Fetch
    const deps = { client, exec, fetch }
    const before = await startChecks("postgres", deps)
    await stopRunBackends("abc123", { client })
    await endChecks("postgres", before, deps)
    await sweepRun("abc123", deps)
    expect(urls.length).toBeGreaterThan(0)
    expect(new Set(urls.map((url) => new URL(url).port))).toEqual(
      new Set(["54432"])
    )
    expect(fetched.length).toBeGreaterThan(0)
    expect(new Set(fetched.map((url) => new URL(url).port))).toEqual(
      new Set(["3913"])
    )
    expect(dockerCalls.length).toBeGreaterThan(0)
    for (const call of dockerCalls)
      expect(call).toContain("simetra-stack=postgres-2")
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
      "a privilege of the owner beyond TRIGGER and REFERENCES",
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
    [
      'a replica-only trigger on better_auth."user"',
      (s) => s.triggers.push({ name: "simetra_provision_user", enabled: "R" }),
      /trigger simetra_provision_user on user is enabled only for replica sessions/,
    ],
    [
      "an allowed grant of the owner with the grant option",
      (s) =>
        s.grants.push({
          object: "relation user",
          grantee: OWNER,
          privilege: "TRIGGER",
          grantable: "true",
        }),
      /relation user grants TRIGGER to simetra_owner WITH GRANT OPTION/,
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

describe("the bucket snapshot on the supabase stack", () => {
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

  it("keeps only run-<tag> rows of storage.buckets and names the Supabase cleanup", async () => {
    const { factory } = fakeConnections((sql) => {
      if (sql.includes("'supabase_admin'")) return [{ present: true }]
      if (sql.startsWith("select current_user as role"))
        return [{ role: PROVIDER_OWNER_ROLES.supabase, superuser: false }]
      if (sql.includes("storage.buckets"))
        return [
          { name: "run-abc123" },
          { name: "run-x" },
          { name: "simetra-dev" },
        ]
      return []
    })
    const before = await startChecks("supabase", {
      client: factory,
      exec: noDocker,
      fetch: noBuckets,
    })
    expect(before.snapshot.buckets).toEqual(["run-abc123"])
    expect(
      leakMessage(
        [{ kind: "buckets", name: "run-abc123", change: "added" }],
        "supabase"
      )
    ).toContain("bucket run-abc123: empty and delete in Supabase Storage")
  })
})

describe("acquireStack", () => {
  // Два DB-проєкти в одному процесі ділять env прогону, а свого замка процес
  // не дочекався б — замість 45 хвилин очікування одразу відмова
  it("refuses a lock this process already holds", async () => {
    const dir = mkdtempSync(join(tmpdir(), "simetra-lock-"))
    try {
      const lock = join(dir, "stack.lock")
      writeFileSync(lock, `${process.pid}\n${process.cwd()}\nnow\n`)
      await expect(
        acquireStack({
          candidates: [1],
          provider: "postgres",
          lockOf: () => lock,
        })
      ).rejects.toThrow(
        "one DB project per vitest process (run each with its own --project)"
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

const TSX = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href
const PICK_FIXTURE = fileURLToPath(
  new URL("./fixtures/pick-stack.ts", import.meta.url)
)

/** Рядок замка, який тримає живий процес, що не є цим тестом (батько воркера). */
const foreignLock = (): string =>
  `${process.ppid}\n/elsewhere\n2026-11-25T00:00:00.000Z\n`

describe("the pool pick", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "simetra-pool-"))
    vi.stubEnv("SIMETRA_STACK", undefined)
    vi.stubEnv("SIMETRA_STACK_POOL", undefined)
    vi.stubEnv("SIMETRA_TEST_DATABASE_URL", "")
    vi.stubEnv("SIMETRA_TEST_SUPERUSER_URL", "")
    delete process.env.SIMETRA_TEST_DATABASE_URL
    delete process.env.SIMETRA_TEST_SUPERUSER_URL
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true })
  })
  const lockOf = (index: number): string => join(dir, `stack-${index}.lock`)
  const base = {
    provider: "postgres",
    lockOf,
    pollMs: 10,
  } as const

  /** Конкуренти в окремих процесах стартують разом і друкують свої записи. */
  async function compete(
    count: number,
    candidates: string,
    mode: string[],
    env: Record<string, string> = {}
  ): Promise<{
    children: ChildProcess[]
    exited: Promise<unknown>[]
    output: string[][]
    /** Стандартний потік помилок кожного конкурента: у лог тесту він не йде. */
    errors: string[]
    wait: (done: () => boolean) => Promise<void>
  }> {
    const goFile = join(dir, "go")
    const output: string[][] = Array.from({ length: count }, () => [])
    const errors: string[] = Array.from({ length: count }, () => "")
    const childEnv = { ...process.env }
    delete childEnv.SIMETRA_STACK
    delete childEnv.SIMETRA_STACK_POOL
    const children = Array.from({ length: count }, (_, i) => {
      const child = spawn(
        process.execPath,
        ["--import", TSX, PICK_FIXTURE, dir, candidates, goFile, ...mode],
        {
          env: {
            ...childEnv,
            ...env,
          },
          stdio: ["ignore", "pipe", "pipe"],
        }
      )
      child.stderr!.setEncoding("utf8")
      child.stderr!.on("data", (chunk: string) => {
        errors[i] += chunk
      })
      child.stdout!.setEncoding("utf8")
      child.stdout!.on("data", (chunk: string) =>
        output[i]!.push(...chunk.split("\n").filter(Boolean))
      )
      return child
    })
    const until = async (done: () => boolean): Promise<void> => {
      for (let i = 0; i < 4000 && !done(); i++)
        await new Promise((resolve) => setTimeout(resolve, 10))
      if (!done()) throw new Error(`timeout: ${JSON.stringify(output)}`)
    }
    // Слухач `exit` — до виходу: пізніше подію вже не дочекатися
    const exited = children.map((child) => once(child, "exit"))
    await until(() => output.every((lines) => lines.includes("ready")))
    writeFileSync(goFile, "")
    return {
      children,
      exited,
      output,
      errors,
      wait: until,
    }
  }

  // Інваріант 2: вибір і замок — одна дія. Конкуренти в окремих процесах, що
  // стартують разом, ніколи не тримають один замок одночасно
  it("never lets two processes hold the same stack at once", async () => {
    const { exited, output, wait } = await compete(6, "1,2", [
      "hold",
      "3",
      "40",
    ])
    await wait(() =>
      output.every(
        (lines) => lines.filter((l) => l.startsWith("released")).length >= 40
      )
    )
    await Promise.all(exited)
    // Записи `picked`/`released` одного процесу йдуть парами, по колу за раз
    const spans = output.flatMap((lines) => {
      const picks = lines.filter((l) => l.startsWith("picked"))
      const releases = lines.filter((l) => l.startsWith("released"))
      expect(picks).toHaveLength(40)
      return picks.map((pick, i) => {
        const [, index, from] = pick.split(" ")
        return {
          index: index!,
          from: Number(from),
          to: Number(releases[i]!.split(" ")[2]),
        }
      })
    })
    expect(new Set(spans.map((s) => s.index))).toEqual(new Set(["1", "2"]))
    const clashes = spans.filter((a) =>
      spans.some(
        (b) => a !== b && a.index === b.index && a.from < b.to && b.from < a.to
      )
    )
    expect(clashes).toEqual([])
  }, 60_000)

  it("skips a stack that is not live and frees its lock", async () => {
    const { exited, output, wait } = await compete(1, "1,2", ["hold", "50"], {
      FAKE_DEAD: "1",
    })
    await wait(() => output[0]!.some((l) => l.startsWith("released")))
    await exited[0]
    expect(output[0]!.find((l) => l.startsWith("picked"))).toMatch(
      /^picked 2 \d+ env=2$/
    )
    expect(existsSync(lockOf(1))).toBe(false)
  }, 60_000)

  it("with no live candidate throws naming them and pnpm db:pg:start", async () => {
    await expect(
      acquireStack({ ...base, candidates: [1, 2], live: async () => false })
    ).rejects.toThrow(
      /candidates 1, 2: start one with pnpm db:pg:start or SIMETRA_STACK=2 pnpm db:pg:start/
    )
    expect([existsSync(lockOf(1)), existsSync(lockOf(2))]).toEqual([
      false,
      false,
    ])
  })

  // Усі живі зайняті: чекаємо будь-який, а не лише перший
  it("polls every live candidate and takes the one that frees", async () => {
    writeFileSync(lockOf(1), foreignLock())
    writeFileSync(lockOf(2), foreignLock())
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const taking = acquireStack({
      ...base,
      candidates: [1, 2],
      live: async () => true,
    })
    await new Promise((resolve) => setTimeout(resolve, 60))
    rmSync(lockOf(2))
    const taken = await taking
    expect(taken.index).toBe(2)
    expect(readFileSync(lockOf(1), "utf8")).toBe(foreignLock())
    expect(String(err.mock.calls[0]![0])).toMatch(
      /^All live local postgres stacks \(1, 2\) are busy: DB run PID \d+ \(\/elsewhere, since 2026-11-25T00:00:00.000Z\), /
    )
    taken.release()
    expect(existsSync(lockOf(2))).toBe(false)
  })

  it("busy line of stack 1 alone keeps its old form, of stack 2 names the index", async () => {
    writeFileSync(lockOf(1), foreignLock())
    writeFileSync(lockOf(2), foreignLock())
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    for (const [index, name] of [
      [1, "stack is busy"],
      [2, "stack 2 is busy"],
    ] as const) {
      err.mockClear()
      await expect(
        acquireStack({ ...base, candidates: [index], waitMs: 20, pollMs: 50 })
      ).rejects.toThrow()
      expect(String(err.mock.calls[0]![0])).toContain(
        `The local postgres ${name}: DB run PID`
      )
    }
  })

  it("takes over the lock of a dead process but not a fresh empty one", async () => {
    writeFileSync(lockOf(1), "2147483646\n/gone\nthen\n")
    expect((await acquireStack({ ...base, candidates: [1] })).index).toBe(1)
    rmSync(lockOf(1))
    writeFileSync(lockOf(2), "")
    await expect(
      acquireStack({ ...base, candidates: [2], waitMs: -1 })
    ).rejects.toThrow("still busy")
    expect(existsSync(lockOf(2))).toBe(true)
  })

  it("pool: puts the chosen index into SIMETRA_STACK", async () => {
    const taken = await takeStack("postgres", {
      lockOf,
      live: async (index) => index === 2,
      pollMs: 10,
    })
    expect(taken.index).toBe(2)
    expect(process.env.SIMETRA_STACK).toBe("2")
    taken.release()
  })

  it("explicit SIMETRA_STACK is one stack and is not probed", async () => {
    vi.stubEnv("SIMETRA_STACK", "3")
    const taken = await takeStack("postgres", { lockOf })
    expect(taken.index).toBe(3)
    expect(existsSync(lockOf(3))).toBe(true)
    expect([1, 2, 4].some((i) => existsSync(lockOf(i)))).toBe(false)
    taken.release()
  })

  // Живість підставна й рахує виклики: з пулом перебрались би 2 і 3, без пулу
  // лишається стек 1; жодного з'єднання з реальним стеком тест не робить
  it("a SIMETRA_TEST_*_URL override turns the pool off: stack 1 without SIMETRA_STACK", async () => {
    vi.stubEnv("SIMETRA_TEST_SUPERUSER_URL", "postgresql://x:x@127.0.0.1:1/y")
    vi.stubEnv("SIMETRA_STACK_POOL", "2,3")
    const probed: number[] = []
    const taken = await takeStack("postgres", {
      lockOf,
      live: async (index) => {
        probed.push(index)
        return true
      },
    })
    expect(taken.index).toBe(1)
    expect(probed.every((index) => index === 1)).toBe(true)
    expect(process.env.SIMETRA_STACK).toBe("1")
    expect([2, 3].some((i) => existsSync(lockOf(i)))).toBe(false)
    taken.release()
  })

  it("one live stack of the default pool, busy: the single-stack text of stack 1", async () => {
    writeFileSync(lockOf(1), foreignLock())
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    await expect(
      acquireStack({
        ...base,
        candidates: [1, 2, 3],
        live: async (index) => index === 1,
        waitMs: 20,
        pollMs: 50,
      })
    ).rejects.toThrow(/^The local postgres stack is still busy after /)
    expect(String(err.mock.calls[0]![0])).toMatch(
      /^The local postgres stack is busy: DB run PID /
    )
  })

  // Прибиральник на сигналі й `release` звільняють замок обраного N, а не 1
  it("on a signal the run frees the lock of the chosen stack only", async () => {
    writeFileSync(lockOf(1), foreignLock())
    const { children, exited, output, errors, wait } = await compete(1, "1,2", [
      "interrupt",
    ])
    await wait(() => output[0]!.some((l) => l.startsWith("picked")))
    expect(output[0]!.find((l) => l.startsWith("picked"))).toMatch(/ env=2$/)
    expect(existsSync(lockOf(2))).toBe(true)
    children[0]!.kill("SIGTERM")
    await exited[0]
    expect(existsSync(lockOf(2))).toBe(false)
    expect(readFileSync(lockOf(1), "utf8")).toBe(foreignLock())
    // Прибиральник порожній: на сигнал нічого не торкається стека чи Docker
    expect(errors[0]).toContain("SIGTERM: stopping DB run abc123")
    expect(errors[0]).not.toContain("did not finish cleanly")
  }, 90_000)

  it("release leaves a lock another run took over", async () => {
    const taken = await acquireStack({ ...base, candidates: [1] })
    writeFileSync(lockOf(1), foreignLock())
    taken.release()
    expect(readFileSync(lockOf(1), "utf8")).toBe(foreignLock())
  })

  describe("probeStack", () => {
    const fake = (reported: string | null | Error) => (): GuardClientLike => ({
      connect: async () => {
        if (reported instanceof Error) throw reported
      },
      query: async <R>() => ({ rows: [{ idx: reported }] as R[] }),
      end: async () => undefined,
      escapeIdentifier: (name: string) => name,
    })
    type GuardClientLike = ReturnType<ClientFactory>

    it.each([
      [2, "2", true],
      [2, "", false],
      [2, null, false],
      [2, "3", false],
      [1, "", true],
      [1, "2", false],
    ] as const)("stack %s reporting %j is live: %s", async (n, rep, ok) => {
      expect(await probeStack(n, fake(rep))).toBe(ok)
    })

    it("an unreachable stack is not live", async () => {
      expect(await probeStack(2, fake(new Error("ECONNREFUSED")))).toBe(false)
    })
  })
})

describe("the stack index check of assertStack", () => {
  beforeEach(() => {
    vi.stubEnv(PROVIDER_ENV, "postgres")
    vi.stubEnv("SIMETRA_STACK", undefined)
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
  const answer = (reported: string | null) => (sql: string) =>
    sql.includes("'supabase_admin'")
      ? [{ present: false, stack_index: reported }]
      : []
  const check = (locked: string | undefined, reported: string | null) => {
    vi.stubEnv("SIMETRA_STACK", locked)
    return assertStack("postgres", {
      client: fakeConnections(answer(reported)).factory,
    })
  }

  it("accepts the reported index equal to the locked one", async () => {
    await expect(check("2", "2")).resolves.toBeUndefined()
    await expect(check(undefined, "1")).resolves.toBeUndefined()
  })

  it("accepts an empty value only under the lock of stack 1", async () => {
    await expect(check(undefined, "")).resolves.toBeUndefined()
    await expect(check("1", null)).resolves.toBeUndefined()
    await expect(check("2", "")).rejects.toThrow(
      "reports stack index none, but the run holds the lock of stack 2"
    )
  })

  it("refuses another index naming both", async () => {
    await expect(check("2", "3")).rejects.toThrow(
      "reports stack index 3, but the run holds the lock of stack 2"
    )
    await expect(check(undefined, "2")).rejects.toThrow(
      "reports stack index 2, but the run holds the lock of stack 1"
    )
  })

  it("stackIndexMismatch is null for a match", () => {
    expect(stackIndexMismatch(4, "4")).toBeNull()
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

  // Проєкт `db` — стек postgres, `db-supabase` — Supabase, `bench` simetra
  // лишається на Supabase, `bench` designer (поріг злиття сигналів) — на
  // postgres; решта проєктів із сторожем — помилка конфігу
  it.each([
    ["simetra/db", "postgres"],
    ["simetra/db-supabase", "supabase"],
    ["simetra/bench", "supabase"],
    ["designer/db", "postgres"],
    ["designer/db-supabase", "supabase"],
    ["designer/bench", "postgres"],
  ] as const)("DB project %s runs on the %s stack", (name, stack) => {
    expect(project(name).stack).toBe(stack)
  })

  // Файл ішов би двічі за `test:db` і `test:db:supabase`, якби обидва проєкти
  // його брали; єдиний виняток — шлях переривання (нижче)
  it.each(["simetra", "designer"])(
    "%s: db and db-supabase share no file except interrupt",
    (pkg) => {
      const supabase = new Set(project(`${pkg}/db-supabase`).files)
      const shared = project(`${pkg}/db`).files.filter((f) => supabase.has(f))
      expect(shared).toEqual(
        pkg === "simetra" ? ["test/db/interrupt.db.test.ts"] : []
      )
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
    expect(on("postgres")).toEqual(["simetra/db"])
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
        "simetra/bench",
        "designer/db",
        "designer/db-supabase",
        "designer/bench",
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

  it("the sweep command carries SIMETRA_STACK for N other than 1", () => {
    vi.stubEnv("SIMETRA_STACK", "2")
    const lines = leftoverReport(
      { databases: ["simetra_copy_abc123_q1w2e3"], roles: [] },
      "postgres",
      NOW
    )
    expect(lines.filter((line) => line.includes("sweep.ts"))).toEqual([
      "    cd packages/simetra && SIMETRA_STACK=2 SIMETRA_TEST_PROVIDER=postgres node --import tsx test/db/sweep.ts abc123",
    ])
  })

  it("names the stack in one header line for N other than 1, none for 1", () => {
    const input = { databases: ["simetra_copy_abc123_q1w2e3"], roles: [] }
    vi.stubEnv("SIMETRA_STACK", undefined)
    expect(leftoverReport(input, "postgres", NOW)[0]).toContain("they are not")
    vi.stubEnv("SIMETRA_STACK", "2")
    expect(leftoverReport(input, "postgres", NOW)[0]).toBe(
      "Stack postgres-2 (SIMETRA_STACK=2) — the objects below are on it:"
    )
  })

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
