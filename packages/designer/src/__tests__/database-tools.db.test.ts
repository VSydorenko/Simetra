import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Client } from "@modelcontextprotocol/client"
import { InMemoryTransport } from "@modelcontextprotocol/server"
import pg from "pg"
import type { EngineScope } from "simetra/schema"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { runTool, type CliArgs } from "../cli/command"
import { databaseResource } from "../io/database"
import { createMcpServer } from "../mcp/server"
import { createPgDeltaEngine } from "../schema-engine"
import { readOnlyPool } from "../schema-engine/pg-delta/adapter"
import type { DiffData } from "../tools/database-tools"
import { toolByName } from "../tools/catalog"
import { invoke } from "../tools/invoke"
import type { InvokeOptions, ToolResult } from "../tools/types"
import {
  shadowDatabaseCount,
  testDatabaseUrl,
} from "../../../simetra/test/support"
import { project, snapshotOf, useTmpProjects } from "./helpers/catalog"

/**
 * Інструменти `introspect` і `diff` над живою базою (план E2b, задача 5):
 * ціль — тінь стеку з SQL фікстури; інструменти бачать її лише через ресурс
 * запуску з середовища, як у справжньому запуску.
 */

const engine = createPgDeltaEngine()
const stack = { url: testDatabaseUrl() }
const SIMETRA = resolve(__dirname, "../../../simetra")
const ENV = "SIMETRA_DATABASE_URL"

useTmpProjects()

let shadowsBefore = 0
const disposers: (() => Promise<void>)[] = []
const clients: Client[] = []
beforeEach(async () => {
  shadowsBefore = await shadowDatabaseCount()
})
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()))
  await Promise.all(disposers.splice(0).map((d) => d()))
  // Жодної тіні після виклику: ні від інструмента, ні від цілі фікстури
  expect(await shadowDatabaseCount()).toBe(shadowsBefore)
})

/** Корінь проєкту з `node_modules/simetra`; тека метаданих ще не існує. */
async function freshProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "simetra-db-tools-"))
  await mkdir(join(root, "node_modules"))
  await symlink(SIMETRA, join(root, "node_modules", "simetra"), "dir")
  disposers.push(() => rm(root, { recursive: true }))
  return join(root, "metadata")
}

const scopeOf = (schemas: string[]): EngineScope => ({
  schemas,
  provider: "supabase",
})

/** Розгортає `sql` у тимчасову базу поруч зі стеком; її прибирає порт. */
async function inTarget(
  sql: string,
  schemas: string[],
  fn: (url: string) => Promise<void>
): Promise<void> {
  const outcome = await engine.withDesiredShadow(
    { target: stack },
    sql,
    scopeOf(schemas),
    (target) => fn(target.url)
  )
  if (outcome.status !== "loaded")
    throw new Error(
      `target did not load: ${outcome.diagnostics.map((d) => d.message).join("; ")}`
    )
}

async function exec(url: string, sql: string): Promise<void> {
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    await client.query(sql)
  } finally {
    await client.end()
  }
}

const options = (
  dir: string,
  env: NodeJS.ProcessEnv,
  shadow?: string
): InvokeOptions => ({
  dir,
  readOnly: false,
  dryRun: false,
  confirmed: false,
  database: databaseResource(env, {
    url: ENV,
    ...(shadow === undefined ? {} : { shadow }),
  }),
})

const call = (
  name: "introspect" | "diff",
  input: unknown,
  o: InvokeOptions
): Promise<ToolResult> => invoke(toolByName(name)!, input, o)

const errors = (r: ToolResult) =>
  r.diagnostics.filter((d) => d.severity === "error")

async function connectMcp(
  dir: string,
  env: NodeJS.ProcessEnv
): Promise<Client> {
  const server = createMcpServer({
    dir,
    readOnly: false,
    database: databaseResource(env, { url: ENV }),
    databaseEnv: ENV,
  })
  const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: "test", version: "0.0.0" })
  clients.push(client)
  await server.connect(serverEnd)
  await client.connect(clientEnd)
  return client
}

const SHOP = `
  CREATE SCHEMA app;
  CREATE TYPE app.order_status AS ENUM ('new', 'paid');
  CREATE TABLE app.customer (id uuid PRIMARY KEY, name text NOT NULL);
  CREATE TABLE app.orders (
    id uuid PRIMARY KEY,
    customer_id uuid NOT NULL REFERENCES app.customer (id),
    status app.order_status NOT NULL,
    total numeric(12, 2)
  );
  CREATE INDEX orders_customer_idx ON app.orders (customer_id);
`

const introspectInput = {
  schemas: ["app"],
  project: { name: "Shop", attributeCase: "snake_case" },
}

/** Ціль SHOP і тека, вже прочитана з неї. */
async function introspected(
  fn: (dir: string, env: NodeJS.ProcessEnv, url: string) => Promise<void>
): Promise<void> {
  await inTarget(SHOP, ["app"], async (url) => {
    const dir = await freshProject()
    const env = { [ENV]: url }
    const r = await call("introspect", introspectInput, options(dir, env))
    expect(errors(r)).toEqual([])
    expect(r.written).toBe(true)
    await fn(dir, env, url)
  })
}

describe("introspect", () => {
  it("introspect writes metadata that compiles", async () => {
    await introspected(async (dir) => {
      const compiled = await invoke(
        toolByName("compile")!,
        {},
        {
          dir,
          readOnly: false,
          dryRun: false,
          confirmed: false,
        }
      )
      expect(compiled.ok).toBe(true)
      expect(errors(compiled)).toEqual([])
      expect(existsSync(join(dir, "project.meta.json"))).toBe(true)
      expect(
        existsSync(join(dir, "custom-tables/Orders/Orders.meta.json"))
      ).toBe(true)
    })
  })

  it("introspect twice changes nothing", async () => {
    await introspected(async (dir, env) => {
      const before = await snapshotOf(dir)
      const again = await call("introspect", {}, options(dir, env))
      expect(errors(again)).toEqual([])
      expect(again.changes).toEqual([])
      expect(again.written).toBe(false)
      expect(await snapshotOf(dir)).toEqual(before)
    })
  })

  it("introspect with errors writes nothing", async () => {
    await inTarget(
      `CREATE SCHEMA app;
       CREATE TABLE app.note (id uuid PRIMARY KEY);
       CREATE TABLE app.booking (
         id uuid PRIMARY KEY,
         during tstzrange NOT NULL,
         CONSTRAINT booking_no_overlap EXCLUDE USING gist (during WITH &&)
       );`,
      ["app"],
      async (url) => {
        const dir = await freshProject()
        const r = await call(
          "introspect",
          introspectInput,
          options(dir, { [ENV]: url })
        )
        expect(r.ok).toBe(false)
        expect(r.written).toBe(false)
        expect(r.changes).toEqual([])
        expect(errors(r).map((d) => d.code)).toContain("engine.unrepresentable")
        // Навіть таблиця без вад не записана: помилка зупиняє весь запис
        expect(existsSync(dir)).toBe(false)
      }
    )
  })

  it("introspect into a fresh dir without schemas is refused", async () => {
    const dir = await freshProject()
    let connects = 0
    const r = await call(
      "introspect",
      {},
      {
        ...options(dir, {}),
        database: {
          describe: "localhost:5432/app",
          connect: () => {
            connects++
            return Promise.reject(new Error("must not connect"))
          },
        },
      }
    )
    expect(r.refusal?.message).toContain("pass schemas")
    expect(connects).toBe(0)
    expect(existsSync(dir)).toBe(false)
  })
})

describe("diff", () => {
  it("diff of an introspected database is empty", async () => {
    await introspected(async (dir, env) => {
      const r = await runTool(
        toolByName("diff")!,
        { _: [dir] },
        undefined,
        process.cwd(),
        env
      )
      expect(r.stdout).toContain("diff: the database matches the metadata")
      expect(r.exitCode).toBe(0)
    })
  })

  it("diff names a dropped index in cli and mcp structured output", async () => {
    await introspected(async (dir, env, url) => {
      await exec(url, "DROP INDEX app.orders_customer_idx")
      const cli = await runTool(
        toolByName("diff")!,
        { _: [dir] },
        undefined,
        process.cwd(),
        env
      )
      expect(cli.exitCode).toBe(1)
      expect(cli.stdout).toContain("orders_customer_idx")

      const json = await runTool(
        toolByName("diff")!,
        { _: [dir], format: "json" },
        undefined,
        process.cwd(),
        env
      )
      const parsed = JSON.parse(json.stdout) as DiffData
      expect(parsed.empty).toBe(false)
      expect(parsed.plan.map((a) => a.sql).join("\n")).toContain(
        "orders_customer_idx"
      )

      const mcp = await (
        await connectMcp(dir, env)
      ).callTool({
        name: "diff",
        arguments: {},
      })
      // Відмінності — не помилка виклику
      expect(mcp.isError).not.toBe(true)
      const data = mcp.structuredContent as unknown as DiffData
      expect(data.empty).toBe(false)
      expect(data.plan.some((a) => a.sql.includes("orders_customer_idx"))).toBe(
        true
      )
      expect(
        data.differences.some((d) => d.path.includes("orders_customer_idx"))
      ).toBe(true)
    })
  })

  it("diff tables filter", async () => {
    await introspected(async (dir, env, url) => {
      // FK замовлення посилається на клієнта, але його дія належить
      // замовленню: фільтр клієнта її не бачить
      await exec(
        url,
        `DROP INDEX app.orders_customer_idx;
         ALTER TABLE app.orders DROP CONSTRAINT orders_customer_id_fkey;`
      )
      const narrowed = async (tables: string[]) =>
        (await call("diff", { tables }, options(dir, env))).data as DiffData

      const other = await narrowed(["app.customer"])
      expect(other).toMatchObject({ plan: [], differences: [], empty: true })

      const own = await narrowed(["orders"])
      expect(own.empty).toBe(false)
      expect(own.plan.length).toBeGreaterThan(0)
      expect(own.differences.length).toBeGreaterThan(0)

      const unknown = await call(
        "diff",
        { tables: ["app.nope"] },
        options(dir, env)
      )
      expect(unknown.refusal?.message).toContain("app.nope")
    })
  })
})

describe("sessions", () => {
  it("target session is read-only", async () => {
    await inTarget(SHOP, ["app"], async (url) => {
      const pool = readOnlyPool(url)
      try {
        await expect(
          pool.query("CREATE TABLE app.intruder (id int)")
        ).rejects.toMatchObject({ code: "25006" })
      } finally {
        await pool.end()
      }
    })
  })

  it("shadow session is not read-only", async () => {
    // Завантаження бажаного стану пише в тінь, поки ціль лише читається
    await inTarget(SHOP, ["app"], async (url) => {
      const outcome = await engine.withDesiredShadow(
        { target: { url } },
        `${SHOP} CREATE TABLE app.extra (id int);`,
        scopeOf(["app"]),
        async (_shadow, plan) => plan
      )
      expect(outcome.status).toBe("loaded")
      if (outcome.status === "loaded")
        expect(
          outcome.value.actions.some((a) =>
            a.produces.includes("table:app.extra")
          )
        ).toBe(true)
    })
  })

  it("a shadow on another server of the same major version is accepted", async () => {
    // Другий сервер тієї самої версії локально — той самий стек під іншою
    // змінною: шлях `--shadow-url-env` проходить повністю
    await introspected(async (dir, env) => {
      const r = await call(
        "diff",
        {},
        options(dir, { ...env, SHADOW_URL: stack.url }, "SHADOW_URL")
      )
      expect(errors(r)).toEqual([])
      expect((r.data as DiffData).empty).toBe(true)
    })
  })
})

describe("credentials never leak", () => {
  const USER = "leaky_user_q7x"
  const PASSWORD = "Wr0ng-pa55-Kx81"
  const badPassword = (() => {
    const u = new URL(stack.url)
    u.username = USER
    u.password = PASSWORD
    return u.toString()
  })()
  const unreachable = `postgresql://${USER}:${PASSWORD}@127.0.0.1:1/app_db`
  const secrets = [USER, PASSWORD, badPassword, unreachable]
  const leaks = (text: string) => secrets.filter((s) => text.includes(s))

  for (const [name, url] of [
    ["bad password", badPassword],
    ["unreachable host", unreachable],
  ] as const) {
    it(`${name} is redacted in text, structuredContent and stderr`, async () => {
      const printed: string[] = []
      const capture = (...args: unknown[]) => {
        printed.push(args.map(String).join(" "))
      }
      const spies = [
        vi.spyOn(console, "error").mockImplementation(capture),
        vi.spyOn(console, "warn").mockImplementation(capture),
        vi.spyOn(console, "log").mockImplementation(capture),
      ]
      try {
        const fresh = await freshProject()
        // `diff` доходить до бази лише з текою, що компілюється
        const reference = await project()
        const env = { [ENV]: url }
        const channels: string[] = []
        const cases: ["introspect" | "diff", CliArgs][] = [
          ["introspect", { _: [fresh], schemas: "app" }],
          ["diff", { _: [reference] }],
        ]
        for (const [tool, argv] of cases) {
          const r = await runTool(
            toolByName(tool)!,
            argv,
            undefined,
            process.cwd(),
            env
          )
          expect(r.exitCode, tool).toBe(2)
          expect(r.stderr, tool).toMatch(
            name === "bad password"
              ? /Authentication to the database at .* failed/
              : /is unreachable \(ECONNREFUSED\)/
          )
          channels.push(r.stdout, r.stderr)
        }

        for (const [tool, dir, args] of [
          ["introspect", fresh, { schemas: ["app"] }],
          ["diff", reference, {}],
        ] as const) {
          const client = await connectMcp(dir, env)
          const r = await client.callTool({ name: tool, arguments: args })
          expect(r.isError, tool).toBe(true)
          channels.push(
            JSON.stringify(r.content),
            JSON.stringify(r.structuredContent ?? null)
          )
          const direct = await call(tool, args, options(dir, env))
          expect(direct.refusal, tool).toBeDefined()
          channels.push(JSON.stringify(direct))
        }
        expect(channels.join("\n")).toContain(new URL(url).hostname)
        expect(leaks([...channels, ...printed].join("\n"))).toEqual([])
      } finally {
        for (const s of spies) s.mockRestore()
      }
    })
  }
})

describe("pools", () => {
  /** Сесії бази, крім власної, — їх лишив би незакритий пул. */
  async function sessions(url: string): Promise<number> {
    const client = new pg.Client({ connectionString: stack.url })
    await client.connect()
    try {
      const { rows } = await client.query<{ n: number }>(
        `select count(*)::int as n from pg_stat_activity
          where datname = $1 and pid <> pg_backend_pid()`,
        [new URL(url).pathname.slice(1)]
      )
      return rows[0]!.n
    } finally {
      await client.end()
    }
  }

  /** Закриті сесії зникають із `pg_stat_activity` не миттєво. */
  async function settled(url: string, expected: number): Promise<number> {
    let n = await sessions(url)
    for (let i = 0; i < 30 && n !== expected; i++) {
      await new Promise((r) => setTimeout(r, 100))
      n = await sessions(url)
    }
    return n
  }

  it("no pool is left open after a refused or failed call", async () => {
    await introspected(async (dir, env, url) => {
      const before = await sessions(url)
      // Відмова після читання бази: невідома таблиця фільтра
      const refused = await call(
        "diff",
        { tables: ["app.nope"] },
        options(dir, env)
      )
      expect(refused.refusal).toBeDefined()
      expect(await settled(url, before)).toBe(before)
      // Відмова до бази: схема провайдера не читається
      const failed = await call(
        "introspect",
        { schemas: ["auth"] },
        options(dir, env)
      )
      expect(failed.refusal).toBeDefined()
      expect(await settled(url, before)).toBe(before)
    })
  })

  it("no pool is left open after introspect with errors", async () => {
    await inTarget(
      `CREATE SCHEMA app;
       CREATE TABLE app.booking (
         id uuid PRIMARY KEY,
         during tstzrange NOT NULL,
         CONSTRAINT booking_no_overlap EXCLUDE USING gist (during WITH &&)
       );`,
      ["app"],
      async (url) => {
        const before = await sessions(url)
        const r = await call(
          "introspect",
          introspectInput,
          options(await freshProject(), { [ENV]: url })
        )
        expect(r.ok).toBe(false)
        expect(await settled(url, before)).toBe(before)
      }
    )
  })
})
