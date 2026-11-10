import { describe, expect, it } from "vitest"
import { PROVIDER_SCHEMAS } from "simetra/model"
import {
  PROVIDER_EVENT_TRIGGERS,
  PROVIDER_UNMANAGED_EXTENSIONS,
  type EngineScope,
} from "simetra/schema"
import { readCensus } from "../census-read"

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
