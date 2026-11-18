import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import pg from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { BATCH_MAX, PLATFORM_ROLES, type Operation } from "simetra/model"
import { createCommandRuntime, fromPgPool } from "simetra/server"
import { TICKET_WRITER_ID } from "../../../simetra/test/support"
import { withRuntimeLogin } from "../../src/__tests__/support/db"
import {
  REQUEST_ROLE,
  TICKET,
  type Env,
  heldEnv,
  seedOrg,
} from "../../src/__tests__/rights-admin-commands.support"

/**
 * Бенчмарк порогу злиття сигналів (спека П4-B §8.2, Рд28): ціна сигналу
 * `c` — рядка outbox — і фази `f` на пакеті з `BATCH_MAX` фаз через
 * `runtime.run` на стеку postgres. Пакет з outbox — поріг понад пакет
 * (сигнал на кожну фазу); без outbox — поріг 1 (сигнал першої фази й один
 * `invalidate` пари: два рядки на пакет). Поріг `T` — найбільше кратне 10,
 * для якого `T·c ≤ 0,1·BATCH_MAX·f`, але не більше `history_size` простору
 * `simetra` − 1 (спека профілю postgres §6.1, Р23 плану B2). Поза
 * `test:db` і CI: це заміри однієї машини, а не поріг перевірки.
 */

const PHASES = BATCH_MAX
/** Прогони після прогріву; медіана відсіює випадкові піки стеку. */
const RUNS = 5
/** Частка ціни пакета без outbox, яку можуть з'їсти сигнали до порогу. */
const SHARE = 0.1

/** `history_size` простору `simetra` у конфігу Centrifugo стека postgres. */
function historySize(): number {
  const config = JSON.parse(
    readFileSync(
      new URL(
        "../../../../docker/postgres-stack/centrifugo.json",
        import.meta.url
      ),
      "utf8"
    )
  ) as {
    channel: { namespaces: { name: string; history_size: number }[] }
  }
  const size = config.channel.namespaces.find(
    (n) => n.name === "simetra"
  )?.history_size
  if (size === undefined) throw new Error("namespace simetra has no history")
  return size
}

const median = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!
const ms = (value: number) => `${value.toFixed(2)} ms`

describe("signal merge threshold", () => {
  const target = heldEnv()
  let env: Env

  beforeAll(async () => {
    env = await target.open()
  }, 30 * 60_000)
  afterAll(() => target.close(), 30 * 60_000)

  it("measures the cost of a signal and of a phase", async () => {
    const org = await seedOrg(env.owner, { writer: [TICKET_WRITER_ID] })
    const session = org.people.writer!.session
    const batch = (): Operation[] =>
      Array.from({ length: PHASES }, () => ({
        action: "create",
        object: TICKET,
        id: randomUUID(),
        values: { org: org.id },
      }))
    const outboxRows = async () =>
      Number(
        (
          await env.owner.query<{ n: string }>(
            "SELECT count(*)::text AS n FROM simetra.signal_outbox"
          )
        ).rows[0]!.n
      )

    const times = await withRuntimeLogin(
      env.url,
      [PLATFORM_ROLES.command, REQUEST_ROLE],
      async (login) => {
        const pool = new pg.Pool({ connectionString: login, max: 2 })
        try {
          const runtimeOf = (signalMergeThreshold: number) =>
            createCommandRuntime({
              database: fromPgPool(pool),
              catalog: env.catalog,
              signalMergeThreshold,
            })
          const runtimes = {
            outbox: await runtimeOf(PHASES + 1),
            merged: await runtimeOf(1),
          }
          const rows = { outbox: 0, merged: 0 }
          const timed = async (mode: keyof typeof runtimes) => {
            const before = await outboxRows()
            const started = performance.now()
            await runtimes[mode].run(session, batch())
            const elapsed = performance.now() - started
            rows[mode] = (await outboxRows()) - before
            return elapsed
          }
          // Прогрів обох режимів, далі — почергово: дрейф стеку ділиться
          // між режимами порівну
          await timed("outbox")
          await timed("merged")
          const result = { outbox: [] as number[], merged: [] as number[] }
          for (let n = 0; n < RUNS; n++) {
            result.outbox.push(await timed("outbox"))
            result.merged.push(await timed("merged"))
          }
          // Передумова виміру: режими справді пишуть різну кількість рядків
          expect(rows).toEqual({ outbox: PHASES, merged: 2 })
          return result
        } finally {
          await pool.end()
        }
      },
      "sig_bench"
    )

    const withOutbox = median(times.outbox)
    const merged = median(times.merged)
    const signal = (withOutbox - merged) / (PHASES - 2)
    const phase = merged / PHASES
    const history = historySize()
    const byCost =
      signal <= 0
        ? Infinity
        : Math.floor((SHARE * PHASES * phase) / signal / 10) * 10
    const cap = Math.floor((history - 1) / 10) * 10
    const threshold = Math.min(byCost, cap)
    process.stderr.write(
      `\nsignal bench (${PHASES} phases, median of ${RUNS})\n` +
        `batch with outbox ${ms(withOutbox)} runs=[${times.outbox.map((t) => t.toFixed(0)).join(", ")}]\n` +
        `batch merged      ${ms(merged)} runs=[${times.merged.map((t) => t.toFixed(0)).join(", ")}]\n` +
        `c = ${ms(signal)} per signal, f = ${ms(phase)} per phase\n` +
        `T by cost ${byCost}, history_size ${history} caps at ${cap}: T = ${threshold}\n`
    )
  })
})
