import pg from "pg"
import { describe, expect, it } from "vitest"
import type { EngineScope } from "simetra/schema"
import { createPgDeltaEngine } from ".."
import { inTarget } from "../../__tests__/support/db"
import { readCensus } from "../census-read"

/**
 * Перепис на стеку Supabase: членство таблиці застосунку в публікації
 * `supabase_realtime` — частина пресета провайдера, якої на чистому Postgres
 * немає, тож решта корпусу переписів іде в `engine-census.db.test.ts` з
 * власною публікацією.
 */

const engine = createPgDeltaEngine()
const scope: EngineScope = { schemas: ["app"], provider: "supabase" }

describe("class census on the Supabase stack", () => {
  it("a table in the realtime publication is counted and not diagnosed", async () => {
    await inTarget(
      `create schema app;
       create table app.doc (id int primary key);
       alter publication supabase_realtime add table app.doc;`,
      scope,
      async (url) => {
        const pool = new pg.Pool({ connectionString: url })
        try {
          const census = await readCensus(pool, scope)
          expect(census).toEqual(
            expect.arrayContaining([{ class: "publicationRel", count: 1 }])
          )
        } finally {
          await pool.end()
        }
        const extracted = await engine.extract({ url }, scope)
        expect(
          extracted.diagnostics.filter((d) =>
            ["engine.unmodeled-class", "engine.census-mismatch"].includes(
              d.code
            )
          )
        ).toEqual([])
      }
    )
  })
})
