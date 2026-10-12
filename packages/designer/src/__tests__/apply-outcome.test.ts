import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { Client } from "@modelcontextprotocol/client"
import { InMemoryTransport } from "@modelcontextprotocol/server"
import { compile } from "simetra/compiler"
import {
  FINGERPRINT_SECTIONS,
  FINGERPRINT_VERSION,
  PLAN_FORMAT,
  PLATFORM_VERSION,
  planFileName,
  serializePlan,
  stampPlan,
  type ApplyDatabase,
  type CatalogFingerprint,
  type FingerprintSection,
  type PlanArtifact,
} from "simetra/schema"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { runTool } from "../cli/command"
import { databaseResource } from "../io/database"
import { readMetadataDir } from "../io/metadata-dir"
import { createMcpServer } from "../mcp/server"
import { createPgDeltaEngine } from "../schema-engine"
import { toolByName } from "../tools/catalog"
import { invoke } from "../tools/invoke"
import { project, useTmpProjects } from "./helpers/catalog"

/**
 * Обрив з'єднання, після якого й пошук у ledger не вдався: результат
 * `apply` невідомий. Порт виконання підмінено (лише він — інструмент,
 * раннер і обидва адаптери справжні), тож база не потрібна: кожна
 * транзакція губить з'єднання, як обрив на `COMMIT` і знову на пошуку.
 */
const lost = vi.hoisted(() => ({ transactions: 0 }))
vi.mock("../schema-engine", async (importOriginal) => {
  const { ApplyConnectionLost } = await import("simetra/schema")
  const database: ApplyDatabase = {
    transaction() {
      lost.transactions++
      return Promise.reject(new ApplyConnectionLost("connection lost"))
    },
  }
  return {
    ...(await importOriginal<typeof import("../schema-engine")>()),
    createApplyDatabase: () => database,
  }
})

useTmpProjects()

const ENV = "SIMETRA_DATABASE_URL"
const env = { [ENV]: "postgres://u:p@db.example.test:5432/app" }
const clients: Client[] = []
beforeEach(() => {
  lost.transactions = 0
})
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()))
})

const fingerprint = (): CatalogFingerprint => ({
  version: FINGERPRINT_VERSION,
  sections: Object.fromEntries(
    FINGERPRINT_SECTIONS.map((s) => [s, "a".repeat(64)])
  ) as Record<FingerprintSection, string>,
})

/** Чинний план без кроків для еталонних метаданих у `plans/` кореня. */
async function writePlan(
  dir: string
): Promise<{ file: string; artifact: PlanArtifact }> {
  const model = (await compile(await readMetadataDir(dir))).model
  if (model === undefined) throw new Error("reference metadata must compile")
  const artifact = await stampPlan({
    format: PLAN_FORMAT,
    platformVersion: PLATFORM_VERSION,
    engine: createPgDeltaEngine().identity,
    fingerprintVersion: FINGERPRINT_VERSION,
    fromHash: null,
    toHash: model.hash,
    scope: { schemas: ["app"], provider: "supabase" },
    targetFingerprint: fingerprint(),
    desiredFingerprint: fingerprint(),
    steps: [],
    requiredPermissions: [],
    drift: null,
    locks: [],
    preamble: [],
    resultCatalog: { tables: [], enumTypes: [], units: [] },
  })
  const file = `plans/${planFileName(null, model.hash)}`
  const path = join(dirname(dir), file)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, serializePlan(artifact))
  return { file, artifact }
}

const HEAD =
  /^apply: outcome unknown — check simetra\.ledger for apply id ([0-9a-f-]{36})$/m

describe("apply with an unknown outcome", () => {
  it("reports the outcome as unknown, never as nothing written", async () => {
    const dir = await project()
    const { file, artifact } = await writePlan(dir)
    const r = await invoke(
      toolByName("apply")!,
      { plan: file, planHash: artifact.planHash },
      {
        dir,
        readOnly: false,
        allowDatabaseWrite: true,
        dryRun: false,
        confirmed: true,
        channel: "cli",
        database: databaseResource(env, { url: ENV }),
      }
    )
    expect(r.ok).toBe(false)
    expect(r.data).toBeUndefined()
    expect(r.diagnostics.map((d) => [d.code, d.params?.outcome])).toEqual([
      ["apply.connection-lost", "unknown"],
    ])
    // Спроба й пошук у ledger; повтору на невідомому результаті немає
    expect(lost.transactions).toBe(2)
    const applyId = r.diagnostics[0]!.params?.applyId

    const cli = await runTool(
      toolByName("apply")!,
      { _: [file, dir], "plan-hash": artifact.planHash, yes: true },
      undefined,
      process.cwd(),
      env
    )
    expect(cli.exitCode).toBe(1)
    expect(cli.stdout).toMatch(HEAD)
    expect(cli.stdout).not.toContain("nothing was written")

    const server = createMcpServer({
      dir,
      readOnly: false,
      allowDatabaseWrite: true,
      database: databaseResource(env, { url: ENV }),
    })
    const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: "test", version: "0.0.0" })
    clients.push(client)
    await server.connect(serverEnd)
    await client.connect(clientEnd)
    const mcp = await client.callTool({
      name: "apply",
      arguments: { plan: file, planHash: artifact.planHash, confirm: true },
    })
    expect(mcp.isError).toBe(true)
    const text = (mcp.content as { text: string }[])[0]!.text
    expect(text).toMatch(HEAD)
    expect(text).not.toContain("nothing was written")
    // Кожен виклик — нове застосування зі своїм id
    expect(HEAD.exec(text)?.[1]).not.toBe(applyId)
  })

  it("refuses a plan of another format with a rebuild hint, before connecting", async () => {
    const dir = await project()
    const { file, artifact } = await writePlan(dir)
    // Форма першого формату: інший `format` і без полів другого
    const old: Record<string, unknown> = { ...artifact, format: 1 }
    delete old.locks
    delete old.preamble
    await writeFile(join(dirname(dir), file), JSON.stringify(old))
    const r = await invoke(
      toolByName("apply")!,
      { plan: file, planHash: artifact.planHash },
      {
        dir,
        readOnly: false,
        allowDatabaseWrite: true,
        dryRun: false,
        confirmed: true,
        channel: "cli",
        database: databaseResource(env, { url: ENV }),
      }
    )
    expect(r.ok).toBe(false)
    expect(r.diagnostics.map((d) => [d.code, d.params?.found])).toEqual([
      ["apply.plan-format", 1],
    ])
    expect(r.diagnostics[0]!.message).toMatch(/rebuild the plan/)
    expect(lost.transactions).toBe(0)
  })
})
