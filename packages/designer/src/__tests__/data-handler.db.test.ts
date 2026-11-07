import { randomUUID } from "node:crypto"
import pg from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  buildRuntimeCatalog,
  compile,
  type CompiledModel,
} from "simetra/compiler"
import {
  PLATFORM_ROLES,
  catalogIndex,
  operationToWire,
  type MetadataRef,
  type Operation,
  type RuntimeCatalog,
  type SessionClaims,
} from "simetra/model"
import { desiredForApply } from "simetra/schema"
import {
  createCommandRuntime,
  createDataHandler,
  fromPgPool,
  readRoleOf,
} from "simetra/server"
import { policyDomain, runtimeValuesLayer } from "../../../simetra/test/support"
import {
  heldResource,
  inTarget,
  seedMarker,
  seedRuntimeActor,
  withRuntimeLogin,
} from "./support/db"

/**
 * Обробник конверта (`simetra/server`) над тінню рушія: форма передачі старої
 * вкладки не називає колонки рядка ТЧ, що з'явилась пізніше. Збереження її
 * значення при заміні рядків ТЧ вирішує `sectionLines` ядра в Postgres —
 * порт-фейк unit-тесту цього не доводить. Модель одна (поточна): стара
 * вкладка — це запит без колонки `note`.
 */

const GAUGE: MetadataRef = { kind: "Catalog", name: "Gauge" }
const REQUEST_ROLE = readRoleOf("supabase")!

interface Env {
  catalog: RuntimeCatalog
  owner: pg.Client
  pool: pg.Pool
  org: string
  session: SessionClaims
}

/** Тінь з бажаним станом застосування, засів і роль входу команд і запиту. */
const heldEnv = () =>
  heldResource<Env>(async (use) => {
    const result = await compile(policyDomain(runtimeValuesLayer()))
    expect(result.diagnostics).toEqual([])
    const model: CompiledModel = result.model!
    const desired = await desiredForApply(model)
    await inTarget(desired.sql, desired.scope, async (url) => {
      const owner = new pg.Client({ connectionString: url })
      await owner.connect()
      try {
        await seedMarker(owner, model.hash)
        const actor = await seedRuntimeActor(owner)
        await withRuntimeLogin(
          url,
          [PLATFORM_ROLES.command, REQUEST_ROLE],
          async (login) => {
            const pool = new pg.Pool({ connectionString: login })
            try {
              await use({
                catalog: buildRuntimeCatalog(model),
                owner,
                pool,
                org: actor.org,
                session: { sub: actor.user, role: REQUEST_ROLE },
              })
            } finally {
              await pool.end()
            }
          },
          "runtime_cmd"
        )
      } finally {
        await owner.end()
      }
    })
  })

describe("data handler over the engine target", () => {
  const target = heldEnv()
  let env: Env

  beforeAll(async () => {
    env = await target.open()
  }, 120_000)
  afterAll(() => target.close(), 60_000)

  it("an update with full section lines in wire form keeps the column the request does not name", async () => {
    const runtime = await createCommandRuntime({
      database: fromPgPool(env.pool),
      catalog: env.catalog,
    })
    const id = randomUUID()
    const kept = randomUUID()
    const added = randomUUID()
    const created = await runtime.run(env.session, {
      action: "create",
      object: GAUGE,
      id,
      values: { org: env.org },
      tabularSections: { lines: [{ ref: kept, qty: "1", note: "first" }] },
    })
    const version = created.rows[0]!.version as number

    // Запит старої вкладки: рядки ТЧ без колонки `note`.
    const index = catalogIndex(env.catalog.objects)
    const entry = index.byRef.get(`${GAUGE.kind}.${GAUGE.name}`)!
    const update: Operation = {
      action: "update",
      object: GAUGE,
      id,
      expectedVersion: version,
      values: {},
      tabularSections: {
        lines: [
          { ref: kept, qty: "2" },
          { ref: added, qty: "3" },
        ],
      },
    }
    const wire = operationToWire(index, update)
    if (!wire.ok) throw new Error(`unmapped: ${JSON.stringify(wire)}`)
    const handler = createDataHandler(runtime)
    const response = await handler(
      env.session,
      {
        subject: env.session.sub,
        request: {
          type: "run",
          operation: wire.value,
          kernels: { [entry.id]: entry.kernelHash },
        },
      },
      { secFetchSite: "same-origin", expectedOrigin: "https://app.example" }
    )
    expect(response.ok, JSON.stringify(response)).toBe(true)

    const { rows } = await env.owner.query(
      "SELECT id, qty::text AS qty, note FROM public.gauge_lines WHERE parent_id = $1 ORDER BY line_number",
      [id]
    )
    expect(rows).toEqual([
      { id: kept, qty: "2.0000000000", note: "first" },
      { id: added, qty: "3.0000000000", note: null },
    ])
  })
})
