import type {
  ApplyDatabase,
  EngineDiagnostic,
  ExecuteOutcome,
  SchemaEngine,
} from "simetra/schema"
import { describe, expect, it, vi } from "vitest"
import { TOOL_PIPELINE } from "./helpers/budget"
import { toolByName } from "../tools/catalog"
import { invoke } from "../tools/invoke"
import { project, useTmpProjects } from "./helpers/catalog"
import { writePlan } from "./helpers/plan-file"

/**
 * Діагностики бажаної тіні репетиції доходять до результату `apply`, як у
 * плані: невидалена тінь (`engine.shadow-drop-failed`) не губиться між тінню
 * й виконанням. База не потрібна: порт виконання, перевірка платформних ролей,
 * виконання плану й двигун підмінені, а інструмент і `invoke` справжні.
 */
const SHADOW_DROP: EngineDiagnostic = {
  code: "engine.shadow-drop-failed",
  severity: "warning",
  message: "The shadow database pgdelta_shadow_t1 could not be dropped",
  params: { shadow: "pgdelta_shadow_t1", sqlstate: "55006" },
}

vi.mock("../schema-engine", async (importOriginal) => {
  // Транзакція лише для сторожа власника: `undefined` — сторож пропускає
  const database: ApplyDatabase = {
    statement: () => Promise.reject(new Error("no statement expected")),
    transaction: () => Promise.resolve(undefined as never),
  }
  return {
    ...(await importOriginal<typeof import("../schema-engine")>()),
    createApplyDatabase: () => database,
  }
})

vi.mock("simetra/schema", async (importOriginal) => {
  const actual = await importOriginal<typeof import("simetra/schema")>()
  const committed: ExecuteOutcome = {
    status: "committed",
    applyId: "00000000-0000-4000-8000-000000000000",
    attempts: 1,
    diagnostics: [],
  }
  return {
    ...actual,
    checkPlatformRoles: () => Promise.resolve({}),
    executePlan: () => Promise.resolve(committed),
  }
})

vi.mock("../tools/database-tools", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../tools/database-tools")>()
  const { createPgDeltaEngine } = await import("../schema-engine")
  const engine: SchemaEngine = {
    ...createPgDeltaEngine(),
    withDesiredShadow: async (_o, _sql, _scope, fn) => ({
      status: "loaded",
      value: await fn(
        { url: "postgres://u:p@shadow.test:5432/s" },
        {
          actions: [],
          empty: true,
          preamble: [],
          diagnostics: [],
        }
      ),
      diagnostics: [SHADOW_DROP],
    }),
    extract: () => Promise.resolve({ catalog: {} } as never),
  }
  return { ...actual, loadEngine: () => Promise.resolve(engine) }
})

useTmpProjects()

describe("apply rehearsal with a desired shadow", TOOL_PIPELINE, () => {
  it("carries the shadow's diagnostics into the result", async () => {
    const dir = await project()
    const { file, artifact } = await writePlan(dir)
    const url = "postgres://u:p@db.example.test:5432/app"
    const r = await invoke(
      toolByName("apply")!,
      { plan: file, planHash: artifact.planHash, rehearse: true },
      {
        dir,
        readOnly: false,
        allowDatabaseWrite: true,
        dryRun: false,
        confirmed: true,
        channel: "cli" as const,
        database: {
          describe: "db.example.test:5432/app",
          connect: () =>
            Promise.resolve({
              target: { url },
              describe: "db.example.test:5432/app",
            }),
        },
      }
    )
    expect(r.ok).toBe(true)
    expect(r.diagnostics).toMatchObject([
      {
        code: "engine.shadow-drop-failed",
        severity: "warning",
        params: { shadow: "pgdelta_shadow_t1", sqlstate: "55006" },
      },
    ])
  })
})
