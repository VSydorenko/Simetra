import { randomUUID } from "node:crypto"
import pg from "pg"
import { describe, expect, it } from "vitest"
import { buildRuntimeCatalog, compile } from "simetra/compiler"
import { PLATFORM_ROLES, type MetadataRef } from "simetra/model"
import { desiredForApply } from "simetra/schema"
import { createCommandRuntime, fromPgPool, readRoleOf } from "simetra/server"
import {
  policyDomain,
  wideBigintLayer,
  wideBigintNames,
} from "../../../simetra/test/support"
import {
  inTarget,
  seedMarker,
  seedRuntimeActor,
  withRuntimeLogin,
} from "./support/db"

/**
 * Ядро команд над об'єктом з понад 50 текстовими колонками. Причина DB-тесту:
 * PL/pgSQL перевіряє виклик `jsonb_build_object` з понад 100 аргументами лише
 * під час виконання — `CREATE FUNCTION` такого ядра проходить, падає перший
 * `create`. Текст ядра звіряє unit-тест `core-text-columns`.
 */

const GAUGE: MetadataRef = { kind: "Catalog", name: "Gauge" }
const REQUEST_ROLE = readRoleOf("supabase")!
const WIDE = wideBigintNames(60)
/** Більше за 2^53: значення доходить текстом без втрат. */
const BIG = 2n ** 53n + 1n

const valuesOf = (shift: bigint) =>
  Object.fromEntries(WIDE.map((name, i) => [name, BIG + shift + BigInt(i)]))

describe("command core with more than 50 text columns", () => {
  it("create and update round-trip 60 BigInt attributes", async () => {
    const result = await compile(policyDomain(wideBigintLayer(60)))
    expect(result.diagnostics).toEqual([])
    const model = result.model!
    const desired = await desiredForApply(model)
    await inTarget(desired.sql, desired.scope, async (url) => {
      const owner = new pg.Client({ connectionString: url })
      await owner.connect()
      try {
        await seedMarker(owner, model.hash)
        const actor = await seedRuntimeActor(owner)
        const session = { sub: actor.user, role: REQUEST_ROLE }
        await withRuntimeLogin(
          url,
          [PLATFORM_ROLES.command, REQUEST_ROLE],
          async (login) => {
            const pool = new pg.Pool({ connectionString: login })
            try {
              const rt = await createCommandRuntime({
                database: fromPgPool(pool),
                catalog: buildRuntimeCatalog(model),
              })
              const id = randomUUID()
              const created = await rt.run(session, {
                action: "create",
                object: GAUGE,
                id,
                values: { org: actor.org, counter: BIG, ...valuesOf(0n) },
              })
              const [row] = created.rows
              expect(row).toMatchObject({ counter: BIG, ...valuesOf(0n) })

              const updated = await rt.run(session, {
                action: "update",
                object: GAUGE,
                id,
                expectedVersion: row!.version as number,
                values: valuesOf(-2n * BIG),
              })
              expect(updated.rows[0]).toMatchObject(valuesOf(-2n * BIG))
              // Значення в базі — незалежним читанням власника, повз ядро.
              const stored = await owner.query(
                `SELECT ${WIDE.map((c) => `${c}::text`).join(", ")} FROM public.gauge WHERE id = $1`,
                [id]
              )
              expect(stored.rows[0]).toEqual(
                Object.fromEntries(
                  Object.entries(valuesOf(-2n * BIG)).map(([k, v]) => [
                    k,
                    String(v),
                  ])
                )
              )
              // Картка тієї самої ширини: будівник читання ріже приведення на
              // ті самі шматки, інакше понад 100 аргументів.
              const card = await rt.read(session, { object: GAUGE, id })
              expect(card.rows[0]).toMatchObject(valuesOf(-2n * BIG))
            } finally {
              await pool.end()
            }
          },
          "runtime_wide"
        )
      } finally {
        await owner.end()
      }
    })
  }, 120_000)
})
