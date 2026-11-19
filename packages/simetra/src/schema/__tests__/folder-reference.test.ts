import { describe, expect, it } from "vitest"
import type { CatalogModel } from "simetra/model"
import {
  folderReference,
  type ApplyDatabase,
  type DbConnection,
  type EngineDiagnostic,
  type EnginePlan,
  type EngineScope,
  type SchemaEngine,
  type ShadowOptions,
  type ShadowOutcome,
} from "simetra/schema"
import { catalog, metaFiles, project } from "../../compiler/__tests__/helpers"

/**
 * Еталон теки поверх порту, без бази: фейковий двигун віддає витяг тіні й
 * діагностики, фейковий читач — порожнє середовище тіні.
 */

const TARGET: DbConnection = { url: "postgres://target" }
const SHADOW: DbConnection = { url: "postgres://shadow" }
const EMPTY_PLAN: EnginePlan = {
  actions: [],
  empty: true,
  preamble: [],
  diagnostics: [],
}
const SHADOW_MODEL: CatalogModel = { tables: [], enumTypes: [], units: [] }

const warning = (
  code: EngineDiagnostic["code"],
  object: string
): EngineDiagnostic => ({
  code,
  severity: "warning",
  message: `${code} on ${object}`,
  params: {},
  object,
})

const DROP_FAILED = warning("engine.shadow-drop-failed", "database:shadow")
const EXTRACT_WARNING = warning("engine.unmodeled-class", "rule:app.r")

function fakeEngine(): SchemaEngine & { shadows: number } {
  const engine = {
    shadows: 0,
    identity: { name: "fake", version: "0" },
    async extract(db: DbConnection) {
      expect(db).toBe(SHADOW)
      return {
        model: SHADOW_MODEL,
        catalog: { engine: "fake" },
        diagnostics: [EXTRACT_WARNING],
        unpopulated: [],
      }
    },
    plan(): EnginePlan {
      throw new Error("the folder reference builds no plan")
    },
    async withDesiredShadow<T>(
      o: ShadowOptions,
      _sql: string,
      _scope: EngineScope,
      fn: (shadow: DbConnection, plan: EnginePlan) => Promise<T>
    ): Promise<ShadowOutcome<T>> {
      expect(o.target).toBe(TARGET)
      engine.shadows++
      return {
        status: "loaded",
        value: await fn(SHADOW, EMPTY_PLAN),
        diagnostics: [DROP_FAILED],
      }
    },
    withTargetClone(): never {
      throw new Error("the folder reference does not clone the target")
    },
  }
  return engine
}

const reader: ApplyDatabase = {
  transaction: (_db, _end, fn) =>
    fn({
      query: async () => [],
      extract: () => {
        throw new Error("the environment read does not extract")
      },
    }),
  statement: () => {
    throw new Error("the folder reference runs no statement")
  },
}

const KEPT = metaFiles({
  "project.meta.json": project({ name: "App", defaultSchema: "app" }),
  "catalogs/Currency/Currency.meta.json": catalog("Currency", {
    schema: "app",
  }),
})

describe("folderReference", () => {
  it("keeps the warnings of the loaded shadow and of its extract", async () => {
    const engine = fakeEngine()
    const reference = await folderReference(
      engine,
      reader,
      { target: TARGET },
      KEPT
    )
    expect(reference.catalog).toBe(SHADOW_MODEL)
    expect(engine.shadows).toBe(1)
    expect(reference.diagnostics).toEqual([DROP_FAILED, EXTRACT_WARNING])
  })

  it("builds no shadow without a kept folder", async () => {
    const engine = fakeEngine()
    const reference = await folderReference(
      engine,
      reader,
      { target: TARGET },
      metaFiles({ "project.meta.json": project({ name: "App" }) })
    )
    expect(reference).toEqual({ catalog: undefined, diagnostics: [] })
    expect(engine.shadows).toBe(0)
  })
})
