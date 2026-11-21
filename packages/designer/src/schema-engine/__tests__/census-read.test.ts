import { describe, expect, it } from "vitest"
import { PROVIDER_SCHEMAS } from "simetra/model"
import {
  PROVIDER_ASSUMED_SCHEMAS,
  PROVIDER_EVENT_TRIGGERS,
  PROVIDER_UNMANAGED_EXTENSIONS,
  type EngineScope,
} from "simetra/schema"
import { readCensus, readUnpopulatedViews } from "../census-read"

/** Підставний клієнт: запит не виконується, лише запам'ятовуються параметри. */
function recordingDb() {
  const calls: unknown[][] = []
  const db = {
    query: async (_sql: string, params: unknown[]) => {
      calls.push(params)
      return { rows: [] }
    },
  }
  return { db: db as unknown as Parameters<typeof readCensus>[0], calls }
}

describe("census query parameters follow the scope provider", () => {
  it.each(["supabase", "postgres"] as const)("%s", async (provider) => {
    const { db, calls } = recordingDb()
    const scope: EngineScope = { schemas: ["app"], provider }
    await readCensus(db, scope)
    expect(calls).toEqual([
      [
        ["app"],
        PROVIDER_SCHEMAS[provider],
        PROVIDER_UNMANAGED_EXTENSIONS[provider],
        PROVIDER_EVENT_TRIGGERS[provider],
        PROVIDER_ASSUMED_SCHEMAS[provider],
      ],
    ])
  })

  it("the two providers differ, so a hard-coded supabase preset would fail", () => {
    expect(PROVIDER_SCHEMAS.postgres).not.toEqual(PROVIDER_SCHEMAS.supabase)
    expect(PROVIDER_UNMANAGED_EXTENSIONS.postgres).not.toEqual(
      PROVIDER_UNMANAGED_EXTENSIONS.supabase
    )
  })
})

describe("unpopulated views are named in the unit identity language", () => {
  it("quotes the parts that need it, as the unit of the model does", async () => {
    const db = {
      query: async () => ({
        rows: [
          { schema: "app", name: "plain" },
          { schema: "App", name: "Mixed.Case" },
          { schema: "app", name: "a,b" },
        ],
      }),
    }
    const ids = await readUnpopulatedViews(
      db as unknown as Parameters<typeof readUnpopulatedViews>[0],
      { schemas: ["app"], provider: "postgres" }
    )
    expect(ids).toEqual([
      "materializedView:app.plain",
      'materializedView:"App"."Mixed.Case"',
      'materializedView:app."a,b"',
    ])
  })
})
