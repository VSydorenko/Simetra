import { existsSync } from "node:fs"
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { Client } from "@modelcontextprotocol/client"
import { InMemoryTransport } from "@modelcontextprotocol/server"
import {
  compile,
  promotionRecordSchema,
  type PromotionRecord,
} from "simetra/compiler"
import {
  parsePlan,
  parseRehearsal,
  serializePlan,
  type ApplyDatabase,
  type PlanArtifact,
  stampPlan,
  type EngineScope,
} from "simetra/schema"
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import { runTool } from "../cli/command"
import { databaseResource } from "../io/database"
import { readMetadataDir } from "../io/metadata-dir"
import { createMcpServer } from "../mcp/server"
import { createPgDeltaEngine } from "../schema-engine"
import type { ApplyData, PlanData } from "../tools/apply-tools"
import { toolByName } from "../tools/catalog"
import { invoke } from "../tools/invoke"
import type {
  DatabaseResource,
  InvokeOptions,
  ToolResult,
} from "../tools/types"
import {
  acceptDebt,
  attribute,
  catalog,
  metaFiles,
  project as projectFile,
  testRoleName,
  testSuperuserUrl,
  uuid,
} from "../../../simetra/test/support"
import { dropRoles, inTarget as loadTarget, query } from "./support/db"
import { leftoverShadows, provisionedShadows } from "./support/shadows"
import { snapshotOf } from "./helpers/catalog"

/**
 * Інструменти `plan` і `apply` над живою базою (план П3-1, задача 10):
 * артефакт пишеться поруч із текою метаданих, `apply` перевіряє хеш, версії
 * й свіжість ще до підключення, а пише лише за підтвердженням. Ціль кожного
 * тесту — окрема база від `withDesiredShadow`; база стеку лише читається.
 */

/**
 * Перемикач обриву: увімкнений, він підміняє порт, що пише (прогін-доказ
 * плану), на такий, що губить з'єднання в кожній транзакції. Вимкнений —
 * справжній порт.
 */
const lose = vi.hoisted(() => ({
  writer: false,
  /** Бажана тінь двигуна не завантажується (`withDesiredShadow`). */
  shadowFails: false,
  /** Скільки транзакцій відкрив порт, що пише, відколи тест його скинув. */
  writes: 0,
  /** Області викликів `withDesiredShadow`, відколи тест скинув перелік. */
  shadowScopes: [] as unknown[],
}))
vi.mock("../schema-engine", async (importOriginal) => {
  const original = await importOriginal<typeof import("../schema-engine")>()
  const { ApplyConnectionLost } = await import("simetra/schema")
  const lost: ApplyDatabase = {
    transaction: () =>
      Promise.reject(new ApplyConnectionLost("connection lost")),
  }
  return {
    ...original,
    createApplyDatabase: (o: { readOnly: boolean }): ApplyDatabase => {
      if (lose.writer && !o.readOnly) return lost
      const real = original.createApplyDatabase(o)
      if (o.readOnly) return real
      return {
        transaction: (target, end, fn) => {
          lose.writes++
          return real.transaction(target, end, fn)
        },
      }
    },
    createPgDeltaEngine: () => {
      const real = original.createPgDeltaEngine()
      return {
        ...real,
        withDesiredShadow: (
          ...args: Parameters<typeof real.withDesiredShadow>
        ) => {
          lose.shadowScopes.push(args[2])
          return lose.shadowFails
            ? Promise.resolve({
                status: "shadow-failed" as const,
                diagnostics: [
                  {
                    code: "engine.shadow-load-failed" as const,
                    severity: "error" as const,
                    message: "the desired shadow did not load",
                    params: {},
                  },
                ],
              })
            : real.withDesiredShadow(...args)
        },
      }
    },
  }
})

const engine = createPgDeltaEngine()
const SIMETRA = resolve(__dirname, "../../../simetra")
const ENV = "SIMETRA_DATABASE_URL"
const scope: EngineScope = { schemas: ["app"], provider: "supabase" }

/** Роль, якій за спиною платформи передають таблицю цілі. */
const OWNER = testRoleName("apply_tools_owner")

beforeAll(() =>
  query(
    testSuperuserUrl(),
    `create role ${OWNER} nologin; grant ${OWNER} to postgres;`
  )
)
afterAll(() => dropRoles(OWNER))

// Клієнти й теки прибираються після файлу, а не після тесту: тести йдуть
// конкурентно, і `afterEach` одного закрив би клієнта чи стер теку сусіда
const disposers: (() => Promise<void>)[] = []
const clients: Client[] = []
beforeEach(() => {
  lose.writer = false
  lose.shadowFails = false
  lose.shadowScopes = []
})
afterAll(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()))
  await Promise.all(disposers.splice(0).map((d) => d()))
})

/**
 * Ціль із `setup`; базу прибирає порт. Спільний `inTarget` через двигун-шпигун
 * цього файлу, з межею цілі файлу.
 */
const inTarget = (
  setup: string,
  fn: (url: string) => Promise<void>
): Promise<void> => loadTarget(setup, scope, fn, engine)

/** Порожня ціль: лише базовий стан провайдера. */
const EMPTY = "select 1;"

const PARTY = "catalogs/Party/Party.meta.json"
const party = (attributes: unknown[] = []) =>
  catalog("Party", { id: uuid(9101), attributes })
const note = () => attribute("note", { id: uuid(9102) })

/** Записує метадані в теку; дослівні одиниці — прийнятий борг. */
async function writeMetadata(
  dir: string,
  entries: Record<string, unknown>
): Promise<void> {
  const files = await acceptDebt(
    metaFiles({
      "project.meta.json": projectFile({ defaultSchema: "app" }),
      ...entries,
    })
  )
  await rm(dir, { recursive: true, force: true })
  for (const [path, content] of files) {
    await mkdir(dirname(join(dir, path)), { recursive: true })
    await writeFile(join(dir, path), content)
  }
}

/** Корінь проєкту з `node_modules/simetra` і текою метаданих. */
async function projectWith(entries: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "simetra-apply-tools-"))
  await mkdir(join(root, "node_modules"))
  await symlink(SIMETRA, join(root, "node_modules", "simetra"), "dir")
  disposers.push(() => rm(root, { recursive: true }))
  const dir = join(root, "metadata")
  await writeMetadata(dir, entries)
  return dir
}

const options = (
  dir: string,
  url: string,
  over: Partial<InvokeOptions> = {}
): InvokeOptions => ({
  dir,
  readOnly: false,
  allowDatabaseWrite: true,
  dryRun: false,
  confirmed: true,
  channel: "cli",
  database: databaseResource({ [ENV]: url }, { url: ENV }),
  ...over,
})

const call = (
  name: "plan" | "apply",
  input: unknown,
  o: InvokeOptions
): Promise<ToolResult> => invoke(toolByName(name)!, input, o)

const codes = (r: ToolResult) => r.diagnostics.map((d) => d.code)
const errors = (r: ToolResult) =>
  r.diagnostics.filter((d) => d.severity === "error").map((d) => d.code)

/** План, що мусить бути `planned`: його дані. */
async function planned(dir: string, url: string): Promise<PlanData> {
  const r = await call("plan", {}, options(dir, url))
  expect(r.refusal).toBeUndefined()
  expect(errors(r), JSON.stringify(r.diagnostics)).toEqual([])
  expect(r.written).toBe(true)
  return r.data as PlanData
}

async function applied(
  dir: string,
  url: string,
  data: PlanData,
  allow: string[] = data.requiredPermissions
): Promise<void> {
  const r = await call(
    "apply",
    { plan: data.file, planHash: data.planHash, allow },
    options(dir, url)
  )
  expect(r.diagnostics, JSON.stringify(r.diagnostics)).toEqual([])
  expect(r.data).toMatchObject({ status: "committed" })
}

/** План і застосування поточних метаданих. */
async function establish(dir: string, url: string): Promise<void> {
  await applied(dir, url, await planned(dir, url))
}

const hashOf = async (dir: string): Promise<string> =>
  (await compile(await readMetadataDir(dir))).model!.hash

const markerExists = async (url: string): Promise<boolean> =>
  (
    await query<{ found: string | null }>(
      url,
      "select to_regclass('simetra.marker')::text as found"
    )
  )[0]?.found != null

/** Ресурс бази, що рахує підключення: відмова до кроку 7 його не чіпає. */
function spyDatabase(): { database: DatabaseResource; connects: () => number } {
  let connects = 0
  return {
    database: {
      describe: "db.example.test:5432/app",
      connect: () => {
        connects++
        return Promise.reject(new Error("must not connect"))
      },
    },
    connects: () => connects,
  }
}

async function connectMcp(
  dir: string,
  url: string,
  allowDatabaseWrite: boolean
): Promise<Client> {
  const server = createMcpServer({
    dir,
    readOnly: false,
    allowDatabaseWrite,
    database: databaseResource({ [ENV]: url }, { url: ENV }),
    databaseEnv: ENV,
  })
  const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: "test", version: "0.0.0" })
  clients.push(client)
  await server.connect(serverEnd)
  await client.connect(clientEnd)
  return client
}

// Конкурентно: ціль і тека кожного тесту — власні, кластера тест не змінює,
// а перемикачів `lose` не чіпає — такі тести в послідовних `describe`
// наприкінці файлу
describe.concurrent("plan", () => {
  it("plan writes the artifact next to metadata", async () => {
    await inTarget(EMPTY, async (url) => {
      const dir = await projectWith({ [PARTY]: party() })
      const before = await snapshotOf(dir)
      const root = dirname(dir)

      // Перегляду в `plan` немає (рішення 10 плану П3-2b-3): `dryRun` —
      // відмова до роботи, а не мовчазний запис
      const dry = await call("plan", {}, options(dir, url, { dryRun: true }))
      expect(dry.refusal?.reason).toBe("dry-run-unsupported")
      expect(dry.written).toBe(false)
      expect(existsSync(join(root, "plans"))).toBe(false)

      const r = await call("plan", {}, options(dir, url))
      const data = r.data as PlanData
      const hash = await hashOf(dir)
      expect(data.file).toBe(`plans/initial-${hash.slice(0, 12)}.plan.json`)
      expect(r.artifacts).toEqual([data.file])
      expect(r.written).toBe(true)
      expect(data.fromHash).toBeNull()
      expect(data.toHash).toBe(hash)
      expect(data.drift).toBeNull()
      expect(codes(r)).toContain("plan.schema-only-proof")
      const parsed = parsePlan(await readFile(join(root, data.file), "utf8"))
      expect(parsed.ok && parsed.artifact.planHash).toBe(data.planHash)
      expect(await snapshotOf(dir)).toEqual(before)
      // План лише читає ціль
      expect(await markerExists(url)).toBe(false)
    })
  })

  it("plan writes a drift-only plan", async () => {
    await inTarget(EMPTY, async (url) => {
      const dir = await projectWith({ [PARTY]: party() })
      await establish(dir, url)
      await query(
        url,
        "update simetra.marker set engine_version = 'other', fingerprint_version = fingerprint_version + 1"
      )
      const data = await planned(dir, url)
      const h12 = (await hashOf(dir)).slice(0, 12)
      expect(data.file).toBe(`plans/${h12}-${h12}.plan.json`)
      expect(existsSync(join(dirname(dir), data.file))).toBe(true)
      expect(data.steps).toEqual([])
      expect(data.drift?.reason).toBe("versions-changed")
      expect(data.requiredPermissions).toEqual(["drift"])

      // Нуль кроків не скасовує дозволу
      const refused = await call(
        "apply",
        { plan: data.file, planHash: data.planHash },
        options(dir, url)
      )
      expect(errors(refused)).toEqual(["apply.permission-required"])
      await applied(dir, url, data, ["drift"])
      const next = await call("plan", {}, options(dir, url))
      expect(next.ok).toBe(true)
      expect(next.data).toBeUndefined()
      expect(next.artifacts).toEqual([])
    })
  })

  it("plan refuses an owner swap", async () => {
    // Прийнята база: таблиця моделі вже є, але належить іншій ролі
    await inTarget(
      `create schema app;
       grant create on schema app to ${OWNER};
       create table app.party (id uuid primary key);
       alter table app.party owner to ${OWNER};`,
      async (url) => {
        const dir = await projectWith({ [PARTY]: party() })
        const r = await call("plan", {}, options(dir, url))
        expect(r.ok).toBe(false)
        expect(errors(r)).toEqual(["plan.owner-mismatch"])
        expect(
          r.diagnostics.find((d) => d.code === "plan.owner-mismatch")?.params
            ?.objects
        ).toBe(`relation app.party (owner ${OWNER}, expected postgres)`)
        expect(r.written).toBe(false)
        expect(existsSync(join(dirname(dir), "plans"))).toBe(false)
      }
    )
  })
})

// Конкурентно з тієї самої причини, що й `plan` вище
describe.concurrent("plan with promotion records", () => {
  const RECORD = `plans/${uuid(9101)}.promotion.json`

  /** Найменший запис, що проходить строгу схему. */
  const recordOf = (objectId: string): PromotionRecord =>
    promotionRecordSchema.parse({
      format: 1,
      base: "a".repeat(64),
      result: "b".repeat(64),
      objectId,
      kind: "Catalog",
      labelDropped: false,
      tables: [],
      columns: [],
      typeChanges: [],
      dataSteps: [],
      retired: [],
      relaxed: [],
      tightened: [],
      rowLevelSecurity: [],
      deleteSemantics: [],
      conversions: [],
      movedUnits: [],
      rewrittenUnits: [],
      contractChanges: [],
    })

  /** Корінь проєкту з файлом запису `content` у `plans/`. */
  async function withRecord(name: string, content: string): Promise<string> {
    const dir = await projectWith({ [PARTY]: party() })
    await mkdir(join(dirname(dir), "plans"))
    await writeFile(join(dirname(dir), "plans", name), content)
    return dir
  }

  it.each([
    ["not JSON", "{", /JSON/],
    ["not a record", JSON.stringify({ format: 1 }), /base: /],
  ])(
    "plan refuses a promotion record that is %s before connecting",
    async (_, content, detail) => {
      const dir = await withRecord(`${uuid(9101)}.promotion.json`, content)
      const spy = spyDatabase()
      const r = await call(
        "plan",
        {},
        options(dir, "postgres://unused", { database: spy.database })
      )
      expect(errors(r)).toEqual(["plan.promotion-record-invalid"])
      const [invalid] = r.diagnostics
      expect(invalid!.params?.file).toBe(RECORD)
      expect(String(invalid!.params?.detail)).toMatch(detail)
      expect(r.written).toBe(false)
      expect(spy.connects()).toBe(0)
    }
  )

  it("plan refuses a record named after another object", async () => {
    const valid = JSON.stringify(
      // Форму тримає схема: лише ім'я файлу не те
      recordOf(uuid(9101))
    )
    const dir = await withRecord(`${uuid(9999)}.promotion.json`, valid)
    const spy = spyDatabase()
    const r = await call(
      "plan",
      {},
      options(dir, "postgres://unused", { database: spy.database })
    )
    expect(errors(r)).toEqual(["plan.promotion-record-invalid"])
    expect(r.diagnostics[0]!.params).toMatchObject({
      file: `plans/${uuid(9999)}.promotion.json`,
      detail: `the record is for object ${uuid(9101)}, so its file is plans/${uuid(9101)}.promotion.json`,
    })
    expect(spy.connects()).toBe(0)
  })

  it("plan refuses a record file it cannot read", async () => {
    // Тека з іменем файлу запису: читання дає EISDIR, а не сирий виняток
    const dir = await projectWith({ [PARTY]: party() })
    await mkdir(join(dirname(dir), RECORD), { recursive: true })
    const spy = spyDatabase()
    const r = await call(
      "plan",
      {},
      options(dir, "postgres://unused", { database: spy.database })
    )
    expect(errors(r)).toEqual(["plan.promotion-record-invalid"])
    expect(r.diagnostics[0]!.params).toMatchObject({
      file: RECORD,
      detail: "the file could not be read (EISDIR)",
    })
    expect(spy.connects()).toBe(0)
  })
})

// Конкурентно з тієї самої причини, що й `plan` вище
describe.concurrent("apply", () => {
  it("apply refuses a foreign planHash", async () => {
    await inTarget(EMPTY, async (url) => {
      const dir = await projectWith({ [PARTY]: party() })
      const data = await planned(dir, url)
      const r = await call(
        "apply",
        { plan: data.file, planHash: "0".repeat(64) },
        options(dir, url)
      )
      expect(r.ok).toBe(false)
      expect(errors(r)).toEqual(["apply.plan-hash"])
      expect(await markerExists(url)).toBe(false)
    })
  })

  it("apply refuses a hand-edited plan", async () => {
    await inTarget(EMPTY, async (url) => {
      const dir = await projectWith({ [PARTY]: party() })
      const data = await planned(dir, url)
      const file = join(dirname(dir), data.file)
      const json = JSON.parse(await readFile(file, "utf8")) as {
        steps: { sql: string }[]
      }
      json.steps[0]!.sql = `${json.steps[0]!.sql} -- edited`
      await writeFile(file, JSON.stringify(json, null, 2))
      const spy = spyDatabase()
      const r = await call(
        "apply",
        { plan: data.file, planHash: data.planHash },
        options(dir, url, { database: spy.database })
      )
      expect(errors(r)).toEqual(["apply.plan-hash"])
      expect(spy.connects()).toBe(0)
      expect(await markerExists(url)).toBe(false)
    })
  })

  it.each(["platformVersion", "engine"] as const)(
    "apply refuses a re-stamped plan with another %s before connecting",
    async (field) => {
      await inTarget(EMPTY, async (url) => {
        const dir = await projectWith({ [PARTY]: party() })
        const data = await planned(dir, url)
        const file = join(dirname(dir), data.file)
        const artifact = parsePlan(await readFile(file, "utf8"))
        if (!artifact.ok) throw new Error("plan must parse")
        const draft: Omit<PlanArtifact, "planHash"> = { ...artifact.artifact }
        Reflect.deleteProperty(draft, "planHash")
        const altered =
          field === "platformVersion"
            ? { ...draft, platformVersion: "0.0.0-other" }
            : { ...draft, engine: { name: "pg-delta", version: "0.0.0-other" } }
        // Хеш чинний: відмову дає саме звірка версій, а не хеш
        const restamped = await stampPlan(altered)
        await writeFile(file, serializePlan(restamped))
        const spy = spyDatabase()
        const r = await call(
          "apply",
          { plan: data.file, planHash: restamped.planHash },
          options(dir, url, { database: spy.database })
        )
        expect(errors(r)).toEqual(["apply.plan-versions"])
        expect(spy.connects()).toBe(0)
        expect(await markerExists(url)).toBe(false)
      })
    }
  )

  it("apply refuses stale metadata", async () => {
    await inTarget(EMPTY, async (url) => {
      const dir = await projectWith({ [PARTY]: party() })
      const data = await planned(dir, url)
      await writeMetadata(dir, { [PARTY]: party([note()]) })
      const r = await call(
        "apply",
        { plan: data.file, planHash: data.planHash },
        options(dir, url)
      )
      expect(errors(r)).toEqual(["apply.plan-stale"])
      expect(await markerExists(url)).toBe(false)
    })
  })

  it("apply refuses a plan file outside plans/", async () => {
    await inTarget(EMPTY, async (url) => {
      const dir = await projectWith({ [PARTY]: party() })
      const r = await call(
        "apply",
        { plan: "metadata/project.meta.json", planHash: "0".repeat(64) },
        options(dir, url)
      )
      expect(r.refusal?.reason).toBe("refused")
      expect(r.refusal?.message).toContain("plans/")
    })
  })

  it("apply refuses a destructive step without allow", async () => {
    await inTarget(EMPTY, async (url) => {
      const dir = await projectWith({ [PARTY]: party([note()]) })
      await establish(dir, url)
      await writeMetadata(dir, { [PARTY]: party() })
      const data = await planned(dir, url)
      const drop = data.steps.find((s) => /DROP COLUMN/i.test(s.sql))
      expect(drop?.class).toBe("destructive")
      expect(data.requiredPermissions).toEqual([drop!.id])

      const refused = await call(
        "apply",
        { plan: data.file, planHash: data.planHash },
        options(dir, url)
      )
      expect(errors(refused)).toEqual(["apply.permission-required"])
      expect(
        (
          await query(
            url,
            "select 1 from information_schema.columns where table_schema = 'app' and table_name = 'party' and column_name = 'note'"
          )
        )[0]
      ).toBeDefined()

      await applied(dir, url, data, [drop!.id])
      expect(
        (
          await query(
            url,
            "select 1 from information_schema.columns where table_schema = 'app' and table_name = 'party' and column_name = 'note'"
          )
        )[0]
      ).toBeUndefined()
    })
  })

  it("apply rehearses without writing", async () => {
    await inTarget(EMPTY, async (url) => {
      const dir = await projectWith({ [PARTY]: party() })
      const data = await planned(dir, url)
      const r = await call(
        "apply",
        { plan: data.file, planHash: data.planHash, rehearse: true },
        options(dir, url)
      )
      expect(r.diagnostics).toEqual([])
      expect((r.data as ApplyData).status).toBe("rolledBack")
      expect(await markerExists(url)).toBe(false)
    })
  })

  it("writes the rehearsal report next to the plan", async () => {
    await inTarget(EMPTY, async (url) => {
      const dir = await projectWith({ [PARTY]: party() })
      const root = dirname(dir)
      const data = await planned(dir, url)
      const file = `plans/initial-${data.toHash.slice(0, 12)}.rehearsal.json`
      expect(file).toBe(data.file.replace(/\.plan\.json$/, ".rehearsal.json"))
      const input = {
        plan: data.file,
        planHash: data.planHash,
        rehearse: true,
      }
      const r = await call("apply", input, options(dir, url))
      expect(errors(r)).toEqual([])
      expect(r.written).toBe(true)
      expect(r.artifacts).toEqual([file])
      expect(r.data).toMatchObject({ status: "rolledBack", report: file })
      const parsed = parseRehearsal(await readFile(join(root, file), "utf8"))
      if (!parsed.ok) throw new Error(parsed.message)
      expect(parsed.report.planHash).toBe(data.planHash)
      expect(await markerExists(url)).toBe(false)

      // Командний рядок: текст називає звіт замість «нічого не записано»,
      // JSON — шлях в `artifacts`
      await rm(join(root, file))
      const argv = {
        _: [data.file, dir],
        "plan-hash": data.planHash,
        rehearse: true,
        yes: true,
      }
      const env = { [ENV]: url }
      const text = await runTool(
        toolByName("apply")!,
        argv,
        () => Promise.resolve(""),
        process.cwd(),
        env
      )
      expect(text.exitCode, text.stderr).toBe(0)
      expect(text.stdout).toContain(`rehearsal report written to ${file}`)
      expect(text.stdout).not.toContain("nothing was written")
      expect(existsSync(join(root, file))).toBe(true)
      const json = await runTool(
        toolByName("apply")!,
        { ...argv, format: "json" },
        () => Promise.resolve(""),
        process.cwd(),
        env
      )
      expect(json.exitCode, json.stderr).toBe(0)
      expect(JSON.parse(json.stdout)).toMatchObject({
        artifacts: [file],
        report: file,
      })

      // MCP: шлях і в `artifacts` структурованого результату
      const client = await connectMcp(dir, url, true)
      const mcp = await client.callTool({
        name: "apply",
        arguments: { ...input, confirm: true },
      })
      expect(mcp.isError).toBeFalsy()
      expect(mcp.structuredContent).toMatchObject({
        status: "rolledBack",
        artifacts: [file],
      })
      expect((mcp.content as { text: string }[])[0]!.text).toContain(
        `rehearsal report written to ${file}`
      )
      expect(await markerExists(url)).toBe(false)
    })
  })
})

// Конкурентно з тієї самої причини, що й `plan` вище
describe.concurrent("over MCP", () => {
  it("plan shows drift first", async () => {
    await inTarget(EMPTY, async (url) => {
      const dir = await projectWith({ [PARTY]: party() })
      await establish(dir, url)
      await query(url, "alter table app.party add column extra int")
      const client = await connectMcp(dir, url, false)
      const r = await client.callTool({ name: "plan", arguments: {} })
      expect(r.isError).toBeFalsy()
      const out = r.structuredContent as unknown as PlanData
      expect(out.drift).not.toBeNull()
      expect(out.requiredPermissions[0]).toBe("drift")
      const text = (r.content as { text: string }[])[0]!.text
      const drift = text.indexOf("drift (drift)")
      const firstStep = text.indexOf(`  ${out.steps[0]!.id} `)
      expect(drift).toBeGreaterThan(-1)
      expect(firstStep).toBeGreaterThan(drift)
      expect(text).toContain(out.planHash)
      // Рядок підключення в тексті не з'являється
      expect(text).not.toContain(url)
    })
  })

  it("apply needs the launch flag over MCP", async () => {
    await inTarget(EMPTY, async (url) => {
      const dir = await projectWith({ [PARTY]: party() })
      const data = await planned(dir, url)
      const args = { plan: data.file, planHash: data.planHash, confirm: true }

      const without = await connectMcp(dir, url, false)
      const refused = await without.callTool({ name: "apply", arguments: args })
      expect(refused.isError).toBe(true)
      expect(await markerExists(url)).toBe(false)

      const client = await connectMcp(dir, url, true)
      const unconfirmed = await client.callTool({
        name: "apply",
        arguments: { plan: data.file, planHash: data.planHash },
      })
      expect(unconfirmed.isError).toBe(true)
      expect(await markerExists(url)).toBe(false)

      const r = await client.callTool({ name: "apply", arguments: args })
      expect(r.isError).toBeFalsy()
      expect(r.structuredContent).toMatchObject({
        status: "committed",
        attempts: 1,
      })
      expect(await markerExists(url)).toBe(true)
    })
  })
})

// Послідовно, після всіх конкурентних груп файлу: перемикачі `lose` діють на
// кожен виклик фабрик файлу, а не лише на свій тест. Ім'я `describe` те
// саме, тож повні імена тестів не змінились
describe("plan", { concurrent: false }, () => {
  it("plan names a lost connection during the proof as a failed copy", async () => {
    await inTarget(EMPTY, async (url) => {
      const dir = await projectWith({ [PARTY]: party() })
      lose.writer = true
      const r = await call("plan", {}, options(dir, url))
      expect(r.written).toBe(false)
      expect(errors(r)).toEqual(["engine.clone-failed"])
      const [failed] = r.diagnostics.filter((d) => d.severity === "error")
      expect(failed!.message).toContain("proof run")
      // Текст раннера про застосування й ledger до того, хто планує, не доходить
      expect(codes(r)).not.toContain("apply.connection-lost")
      expect(await markerExists(url)).toBe(false)
    })
  })
})

// Послідовно з тієї самої причини, а ще шпигун тіней і перевірка
// `leftoverShadows(mark)` бачили б живі тіні сусідніх тестів
describe("apply", { concurrent: false }, () => {
  it("apply --rehearse builds the desired shadow and passes the proof", async () => {
    await inTarget(EMPTY, async (url) => {
      const dir = await projectWith({ [PARTY]: party() })
      const data = await planned(dir, url)
      const artifact = JSON.parse(
        await readFile(join(dirname(dir), data.file), "utf8")
      ) as { scope: unknown }
      const mark = provisionedShadows().length
      // `plan` теж будує тінь: рахуємо лише виклики самого `apply`
      const shadowCallsBefore = lose.shadowScopes.length
      const r = await call(
        "apply",
        { plan: data.file, planHash: data.planHash, rehearse: true },
        options(dir, url)
      )
      expect(errors(r)).toEqual([])
      expect((r.data as ApplyData).status).toBe("rolledBack")
      // Шпигун: без бажаної тіні доказ не мав би з чим порівнювати, і тест
      // мусить упасти, а не пройти на порожньому доказі
      expect(lose.shadowScopes.slice(shadowCallsBefore)).toEqual([
        artifact.scope,
      ])
      // Тінь доказу прибрано
      expect(await leftoverShadows(mark)).toEqual([])
    })
  })

  it("apply --rehearse refuses with the shadow diagnostics and runs nothing", async () => {
    await inTarget(EMPTY, async (url) => {
      const dir = await projectWith({ [PARTY]: party() })
      const data = await planned(dir, url)
      lose.shadowFails = true
      lose.writes = 0
      const r = await call(
        "apply",
        { plan: data.file, planHash: data.planHash, rehearse: true },
        options(dir, url)
      )
      expect(errors(r)).toEqual(["engine.shadow-load-failed"])
      expect(r.data).toBeUndefined()
      // Невдала репетиція звіту не пише
      expect(r.written).toBe(false)
      expect(
        existsSync(
          join(
            dirname(dir),
            `plans/initial-${data.toHash.slice(0, 12)}.rehearsal.json`
          )
        )
      ).toBe(false)
      // `executePlan` не викликано: транзакції цілі не було
      expect(lose.writes).toBe(0)
      expect(await markerExists(url)).toBe(false)
    })
  })
})
