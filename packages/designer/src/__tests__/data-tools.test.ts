import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { Client } from "@modelcontextprotocol/client"
import { InMemoryTransport } from "@modelcontextprotocol/server"
import pg from "pg"
import { compile } from "simetra/compiler"
import { ROW_VERSION_EPOCH_FUNCTION_NAME } from "simetra/model"
import type { CommandDatabase } from "simetra/server"
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import {
  acceptDebt,
  fakeDatabase,
  GAUGE_LOG_FILE,
  policyDomain,
  runtimeValuesLayer,
  type Answer,
} from "../../../simetra/test/support"
import { DataGuardRefusal } from "../io/data-guard-refusal"
import { dataResource, dataSession, withData } from "../io/data"
import { createMcpServer } from "../mcp/server"
import {
  dataCommandTool,
  dataReadTool,
  logRuntimeEntry,
  summarizeData,
} from "../tools/data-tools"
import { invoke } from "../tools/invoke"
import type { DataResource, InvokeOptions } from "../tools/types"
import { TOOL_PIPELINE } from "./helpers/budget"
import { withObjectModule } from "./helpers/object-module"

const AS = "00000000-0000-4000-8000-0000000000a1"
const AGENT = "00000000-0000-4000-8000-0000000000a2"
const ID = "00000000-0000-4000-8000-00000000d001"
const ORG = "00000000-0000-4000-8000-00000000d0a0"
const GAUGE = { kind: "Catalog", name: "Gauge" } as const
const LOG = { kind: "Catalog", name: "GaugeLog" } as const
const ASSIGNMENTS = { kind: "Catalog", name: "OrgRoleAssignments" } as const
/** Більше за `Number.MAX_SAFE_INTEGER`: число JSON його спотворило б. */
const BIG = "9007199254740993"
/** Ім'я входу в тексті помилки бази: не мусить потрапити у вивід. */
const MARKER = "login_marker_7f3e"

let root: string
let dir: string
let hash: string

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "simetra-data-tools-"))
  dir = join(root, "metadata")
  // `GaugeLog` — з модулем: об'єкт, який designer відмовляє писати
  const files = await acceptDebt(
    withObjectModule(policyDomain(runtimeValuesLayer()), GAUGE_LOG_FILE)
  )
  for (const [path, content] of files) {
    await mkdir(dirname(join(dir, path)), { recursive: true })
    await writeFile(join(dir, path), content)
  }
  const compiled = await compile(files)
  expect(compiled.diagnostics).toEqual([])
  hash = compiled.model!.hash
}, 60_000)

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

afterEach(() => {
  vi.restoreAllMocks()
})

/** Відповіді бази рантайму: звірка проходить, ядро віддає рядок `Gauge`. */
function answer(text: string): Answer {
  if (text.includes("applied_snapshot_hash")) return { rows: [{ hash }] }
  if (text.includes("pg_has_role")) return { rows: [{ member: "t" }] }
  // Оператор епохи читання частин: база без рядка епохи відповідає `NULL`.
  if (text.includes(ROW_VERSION_EPOCH_FUNCTION_NAME))
    return { rows: [{ epoch: null }] }
  if (text.includes("current_user_id")) return { rows: [{ user_id: AS }] }
  const row = JSON.stringify({ id: ID, version: 2, counter: BIG, org_id: ORG })
  if (text.includes(" AS row FROM ")) return { rows: [{ row }] }
  if (text.endsWith("AS r")) return { rows: [{ r: row }] }
  return {}
}

/** Ресурс даних-заглушка над порт-фейком: рахує `open` і `close`. */
function stubData(
  o: {
    agent?: string
    open?: () => Promise<never>
    script?: (text: string) => Answer
  } = {}
) {
  const fake = fakeDatabase({ query: (text) => (o.script ?? answer)(text) })
  const counts = { open: 0, close: 0 }
  const resource: DataResource = {
    describe: "localhost:54322/app",
    as: AS,
    ...(o.agent === undefined ? {} : { agent: o.agent }),
    async open(provider) {
      counts.open++
      if (o.open !== undefined) return o.open()
      return {
        database: fake.database as CommandDatabase,
        session: dataSession(provider, {
          as: AS,
          ...(o.agent === undefined ? {} : { agent: o.agent }),
        }),
        close: async () => {
          counts.close++
        },
      }
    },
  }
  return { resource, counts, calls: fake.calls }
}

const options = (data: DataResource): InvokeOptions => ({
  dir,
  readOnly: false,
  allowDatabaseWrite: false,
  allowDataWrite: true,
  dryRun: false,
  confirmed: false,
  channel: "mcp",
  data,
})

const updateGauge = {
  action: "update",
  object: GAUGE,
  id: ID,
  expectedVersion: 1,
}
const readGauge = { query: { object: GAUGE, id: ID } }

const clients: Client[] = []
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()))
})

async function callMcp(
  data: DataResource | undefined,
  name: string,
  args: Record<string, unknown>,
  at = dir
) {
  const server = createMcpServer({
    dir: at,
    readOnly: false,
    allowDataWrite: true,
    ...(data === undefined ? {} : { data }),
  })
  const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: "test", version: "0.0.0" })
  clients.push(client)
  await server.connect(serverEnd)
  await client.connect(clientEnd)
  const r = await client.callTool({ name, arguments: args })
  return {
    isError: r.isError === true,
    structured: r.structuredContent as Record<string, unknown>,
    text: (r.content as { text?: string }[]).map((c) => c.text ?? "").join(""),
    raw: JSON.stringify(r),
  }
}

// Кожен виклик компілює домен прав — бюджет `TOOL_PIPELINE`
describe("summarizeData", () => {
  it.each([
    [{ rows: [{}, {}] }, "data-read: 2 rows"],
    [{ count: 1 }, "data-read: 1 row counted"],
    [
      { count: 10_000, capped: true as const },
      "data-read: over 10000 rows counted",
    ],
    [
      { error: { code: "command.invalid" as const, reason: "lazy" } },
      "data-read: command.invalid: lazy",
    ],
  ])("summarizes %j", (data, text) => {
    expect(summarizeData("data-read", data)).toBe(text)
  })
})

describe("data tools", TOOL_PIPELINE, () => {
  it("refuses a batch with an object module before opening the data", async () => {
    const stub = stubData()
    const r = await invoke(
      dataCommandTool,
      { operations: [updateGauge, { ...updateGauge, object: LOG }] },
      options(stub.resource)
    )
    expect(r.ok).toBe(false)
    expect(r.data).toEqual({
      error: { code: "command.invalid", reason: "object-module", object: LOG },
    })
    expect(stub.counts.open).toBe(0)
  })

  it("refuses a rights catalog without the rights flag before opening the data", async () => {
    const stub = stubData()
    const r = await invoke(
      dataCommandTool,
      { operations: [{ action: "create", object: ASSIGNMENTS, id: ID }] },
      { ...options(stub.resource), launchArgs: ["simetra", "mcp"] }
    )
    expect(r.refusal?.reason).toBe("rights-write-disabled")
    expect(r.refusal?.message).toContain("--allow-rights-write")
    expect(stub.counts.open).toBe(0)
  })

  it("MCP data-command checks tabular arrays strictly", async () => {
    const stub = stubData()
    const mcp = await callMcp(stub.resource, "data-command", {
      operations: [{ ...updateGauge, tabularSections: { lines: [] } }],
    })
    expect(mcp.isError).toBe(false)
    // Сувора перевірка типова: без опції `fullTabularArrays` рантайм шле
    // оператор перевірки ТЧ перед ядром.
    expect(
      stub.calls.some((c) => "text" in c && c.text.includes(" AS missing "))
    ).toBe(true)
  })

  it("MCP refuses a rights catalog without --allow-rights-write", async () => {
    const stub = stubData()
    const mcp = await callMcp(stub.resource, "data-command", {
      operations: [{ action: "create", object: ASSIGNMENTS, id: ID }],
    })
    expect(mcp.isError).toBe(true)
    expect(mcp.structured.refusal).toEqual({ reason: "rights-write-disabled" })
    expect(stub.counts.open).toBe(0)
  })

  it("gives a guard refusal a stable reason and detail", async () => {
    const stub = stubData({
      open: () => Promise.reject(new DataGuardRefusal("not-development")),
    })
    const r = await invoke(dataReadTool, readGauge, options(stub.resource))
    expect(r.refusal).toMatchObject({
      reason: "data-guard",
      detail: "not-development",
    })
    const mcp = await callMcp(stub.resource, "data-read", readGauge)
    expect(mcp.isError).toBe(true)
    expect(mcp.structured.refusal).toEqual({
      reason: "data-guard",
      detail: "not-development",
    })
  })

  it("closes the data session on success and on a runtime failure", async () => {
    const ok = stubData()
    const r = await invoke(dataReadTool, readGauge, options(ok.resource))
    expect(r.ok).toBe(true)
    expect(ok.counts).toEqual({ open: 1, close: 1 })

    const stale = stubData({
      script: (text) =>
        text.includes("applied_snapshot_hash")
          ? { rows: [{ hash: "0".repeat(64) }] }
          : answer(text),
    })
    const failed = await invoke(
      dataReadTool,
      readGauge,
      options(stale.resource)
    )
    expect(failed.ok).toBe(false)
    expect(failed.data).toMatchObject({
      error: { code: "command.model-mismatch" },
    })
    expect(stale.counts).toEqual({ open: 1, close: 1 })
  })

  it("shows the diagnostics of broken metadata over MCP", async () => {
    const broken = await mkdtemp(join(tmpdir(), "simetra-data-broken-"))
    try {
      await writeFile(join(broken, "project.meta.json"), "{")
      const stub = stubData()
      const mcp = await callMcp(stub.resource, "data-read", readGauge, broken)
      expect(mcp.isError).toBe(true)
      expect(
        (mcp.structured.diagnostics as { code: string }[]).length
      ).toBeGreaterThan(0)
      expect(mcp.text).toContain("project.meta.json")
      expect(stub.counts.open).toBe(0)
    } finally {
      await rm(broken, { recursive: true, force: true })
    }
  })

  it("reports a failed guard query by address and code only", async () => {
    const failure = Object.assign(
      new Error(`permission denied for user ${MARKER}`),
      { code: "XX000" }
    )
    fakePool(() => {
      throw failure
    })
    const resource = dataResource(
      { APP_DATA: `postgresql://${MARKER}:pw@127.0.0.1:54322/app` },
      { urlEnv: "APP_DATA", as: AS }
    )!
    const mcp = await callMcp(resource, "data-read", readGauge)
    expect(mcp.isError).toBe(true)
    expect(mcp.structured.diagnostics).toMatchObject([
      {
        code: "database.failed",
        params: { database: "127.0.0.1:54322/app", sqlstate: "XX000" },
      },
    ])
    expect(mcp.raw).not.toContain(MARKER)
  })

  it("withData passes a guard refusal through unclassified", async () => {
    const refusal = new DataGuardRefusal("login-refused")
    const stub = stubData({ open: () => Promise.reject(refusal) })
    await expect(
      withData(stub.resource, "supabase", () => Promise.resolve(1))
    ).rejects.toBe(refusal)
  })

  describe("withData when closing the session fails", () => {
    // Збій закриття пулу після закоміченої команди не підміняє результат і
    // помилку `fn`: команда вже відбулася, а текст бази назовні не йде
    const closing = new Error(`terminating connection for ${MARKER}`)
    const failingClose: DataResource = {
      describe: "localhost:54322/app",
      as: AS,
      open: () =>
        Promise.resolve({
          database: fakeDatabase({ query: answer }).database as CommandDatabase,
          session: dataSession("supabase", { as: AS }),
          close: () => Promise.reject(closing),
        }),
    }

    it("returns the result of fn and logs the failure without its text", async () => {
      const write = vi.spyOn(process.stderr, "write").mockReturnValue(true)
      await expect(
        withData(failingClose, "supabase", () => Promise.resolve(42))
      ).resolves.toBe(42)
      const out = write.mock.calls.map((c) => String(c[0])).join("")
      expect(out).toContain("closing the data session failed")
      expect(out).not.toContain(MARKER)
    })

    it("rethrows the error of fn, not the closing one", async () => {
      vi.spyOn(process.stderr, "write").mockReturnValue(true)
      const refusal = new DataGuardRefusal("not-development")
      await expect(
        withData(failingClose, "supabase", () => Promise.reject(refusal))
      ).rejects.toBe(refusal)
    })
  })

  it("the runtime log keeps a table name with a line break on one line", () => {
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true)
    logRuntimeEntry({
      kind: "database",
      error: Object.assign(new Error("boom"), {
        code: "23505",
        table: "gauge\nsimetra: forged line",
      }),
    })
    const out = write.mock.calls.map((c) => String(c[0])).join("")
    expect(out.split("\n").filter((line) => line !== "")).toHaveLength(1)
    expect(out).toContain(JSON.stringify("gauge\nsimetra: forged line"))
  })

  it.each([
    [{ development: false }, "not-development"],
    [{ rolbypassrls: true }, "login-refused"],
  ])(
    "the real resource ends the pool on a guard refusal (%o)",
    async (facts, detail) => {
      const events = fakePool(() => ({ rows: [{ ...SAFE_FACTS, ...facts }] }))
      const resource = dataResource(
        { APP_DATA: "postgresql://u:p@127.0.0.1:54322/app" },
        { urlEnv: "APP_DATA", as: AS }
      )!
      const error: unknown = await resource
        .open("supabase")
        .catch((e: unknown) => e)
      expect((error as DataGuardRefusal).detail).toBe(detail)
      // Клієнт звільнено до закриття пулу, а відмова — після обох
      expect(events).toEqual(["release", "end"])
    }
  )

  it("the real resource opens a new pool and checks the guards on every open", async () => {
    // Ознака бази може зникнути між викликами: перший `open` її бачить,
    // другий — ні, і відмова мусить прийти саме з другого
    const answers = [SAFE_FACTS, { ...SAFE_FACTS, development: false }]
    let queries = 0
    fakePool(() => ({ rows: [answers[queries++]] }))
    const resource = dataResource(
      { APP_DATA: "postgresql://u:p@127.0.0.1:54322/app" },
      { urlEnv: "APP_DATA", as: AS }
    )!
    const first = await resource.open("supabase")
    await first.close()
    const error: unknown = await resource
      .open("supabase")
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DataGuardRefusal)
    expect((error as DataGuardRefusal).detail).toBe("not-development")
    expect(vi.mocked(pg.Pool)).toHaveBeenCalledTimes(2)
    expect(queries).toBe(2)
  })

  it("returns BigInt values as decimal strings", async () => {
    const stub = stubData()
    const r = await invoke(
      dataCommandTool,
      { operations: [updateGauge] },
      options(stub.resource)
    )
    expect(r.ok).toBe(true)
    expect(r.data).toMatchObject({
      result: { rows: [{ counter: BIG }], changes: [{ version: 2 }] },
    })
    const mcp = await callMcp(stubData().resource, "data-read", readGauge)
    expect(mcp.isError).toBe(false)
    expect(mcp.structured.rows).toMatchObject([{ counter: BIG }])
    expect(mcp.text).toContain("1 row")
  })

  it("acts as the user and names the agent in act", async () => {
    const stub = stubData({ agent: AGENT })
    const r = await invoke(dataReadTool, readGauge, options(stub.resource))
    expect(r.ok).toBe(true)
    const claims = stub.calls.find(
      (c) => "text" in c && c.text.includes("request.jwt.claims")
    )
    if (claims === undefined || !("params" in claims))
      throw new Error("no claims statement")
    const sent = JSON.parse(String(claims.params[0])) as Record<string, unknown>
    expect(sent).toMatchObject({ sub: AS, act: { sub: AGENT } })
  })

  it("the runtime log writes no database text", () => {
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true)
    logRuntimeEntry({
      kind: "database",
      error: Object.assign(
        new Error(`password authentication failed for user ${MARKER}`),
        { code: "28P01", detail: `Key (login)=(${MARKER}) exists.` }
      ),
    })
    const out = write.mock.calls.map((c) => String(c[0])).join("")
    expect(out).toContain("28P01")
    expect(out).not.toContain(MARKER)
  })
})

/** Факти безпечної ролі входу на базі розробника. */
const SAFE_FACTS = {
  rolsuper: false,
  rolbypassrls: false,
  command: true,
  migrator: false,
  service: false,
  development: true,
}

/**
 * `pg.Pool` справжнього `dataResource` — фейк: запит фактів відповідає
 * `facts` (чи кидає), а журнал подій фіксує порядок `release` і `end`.
 */
function fakePool(facts: () => { rows: unknown[] }): string[] {
  const events: string[] = []
  const client = {
    on() {},
    query(text: string) {
      if (text === "BEGIN READ ONLY" || text === "COMMIT")
        return Promise.resolve({ rows: [] })
      try {
        return Promise.resolve(facts())
      } catch (error) {
        return Promise.reject(error as Error)
      }
    },
    release() {
      events.push("release")
    },
  }
  vi.spyOn(pg, "Pool").mockImplementation(function () {
    return {
      on() {},
      connect: () => Promise.resolve(client),
      end() {
        events.push("end")
        return Promise.resolve()
      },
    } as unknown as pg.Pool
  })
  return events
}
