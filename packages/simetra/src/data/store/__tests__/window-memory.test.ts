import { writeFileSync } from "node:fs"
import { setFlagsFromString } from "node:v8"
import { runInNewContext } from "node:vm"
import { describe, expect, it } from "vitest"
import type { OrderBy } from "simetra/model"
import { createCoreSession, inspectCore } from "../core"
import { FakeServer } from "../testing/fake-source"
import type { ViewSnapshot } from "../types"
import { TASK, id, taskSpec, watch } from "./support"

/*
 * Критерій 2 спайку 4: пам'ять вікна на 100 тис. рядків прокрутки. Запуск:
 * `CORE_PERF=1 pnpm --filter simetra test window-memory`. Метод: сервер
 * засіяно до заміру (його пам'ять — не вікна); прокрутка сторінка за
 * сторінкою через `setVisibleRange`; примусовий GC (`--expose-gc` через
 * `v8.setFlagsFromString`); утримане вікном = heapUsed з живою сесією
 * мінус heapUsed після `dispose()` і GC. Друге число — та сама прокрутка
 * без межі знімків (усе прокручене лишається знімком показу).
 */

const run = process.env.CORE_PERF === "1" ? it : it.skip

setFlagsFromString("--expose-gc")
const gc = runInNewContext("gc") as () => void
const heap = () => {
  for (let i = 0; i < 3; i++) gc()
  return process.memoryUsage().heapUsed
}

const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

const TOTAL = Number(process.env.WIN_TOTAL ?? 100_000)
const PAGE = 100

const timing = { server: 0, reads: 0 }
const orderBy: OrderBy = [{ attribute: "rank", direction: "asc" }]

function makeServer() {
  const server = new FakeServer([taskSpec])
  server.seed(
    TASK,
    Array.from({ length: TOTAL }, (_, i) => ({
      id: id(i + 1),
      title: `Item ${i + 1} with a typical list title`,
      rank: i,
      done: i % 3 === 0,
    }))
  )
  // Прогрів кешів сортування фейкового сервера — до базової лінії.
  server.read({ object: taskSpec.ref, orderBy, limit: 1 })
  server.read({
    object: taskSpec.ref,
    where: { attribute: "id", op: "in", value: [id(1)] },
    limit: 1,
  })
  return server
}

/** Прокрутка всієї множини; повертає heapUsed з живою сесією й заміри. */
async function session(server: FakeServer, ghostBytes: number) {
  // Відповідь проходить дріт: структурна копія, як після JSON. Без неї рядки
  // ділили б рядкові значення з сервером, і замір занизив би пам'ять.
  const core = createCoreSession({
    subject: "user-1",
    objects: [taskSpec],
    releaseDelayMs: 0,
    window: { unloadDelayMs: 0, marginPages: 2, ghostBytes },
    source: {
      read: async (query) => {
        const t = performance.now()
        const res = structuredClone(server.read(query))
        timing.server += performance.now() - t
        timing.reads++
        return res
      },
      run: async () => {
        throw new Error("read-only")
      },
    },
  })
  const t0 = performance.now()
  const h = core.view({ kind: "window", object: TASK, orderBy, pageSize: PAGE })
  const v = watch(h)
  await settle()
  for (let i = 0; i < TOTAL; i += PAGE) {
    h.setVisibleRange(id(i + 1), id(Math.min(TOTAL, i + 20)))
    await settle()
  }
  const ms = performance.now() - t0
  const snap: ViewSnapshot = v.last
  // Журнал кадрів — пам'ять тесту, не вікна; останній знімок — пам'ять UI.
  v.frames.length = 0
  const stats = {
    rows: snap.rows.length,
    pages: snap.window!.pages.length,
    resident: snap.window!.pages.filter((p) => p.tier === "resident").length,
    ghostEstimate: snap.window!.ghostBytes,
    owned: inspectCore(core).rows(TASK).size,
    atStart: snap.window!.atStart,
    ms,
  }
  const live = heap()
  v.unsubscribe()
  core.dispose()
  return { ...stats, live }
}

/** Утримане сесією = heapUsed з нею мінус heapUsed, коли посилань немає. */
async function scroll(server: FakeServer, ghostBytes: number) {
  const base = heap()
  const r = await session(server, ghostBytes)
  const after = heap()
  return { ...r, retained: r.live - after, residual: after - base }
}

describe("пам'ять вікна", () => {
  run(
    "100 тис. рядків прокрутки: межа знімків тримає пам'ять сталою",
    async () => {
      const server = makeServer()
      const bounded = await scroll(server, 4 * 1024 * 1024)
      const unbounded = await scroll(server, Number.POSITIVE_INFINITY)
      const mib = (n: number) => `${(n / 1024 / 1024).toFixed(2)} MiB`
      const report = [
        `межа 4 МіБ: утримано ${mib(bounded.retained)}, рядків у списку ${bounded.rows}, сторінок ${bounded.pages} (власних ${bounded.resident}), рядків у сховищі ${bounded.owned}, оцінка знімків ${mib(bounded.ghostEstimate)}, atStart=${bounded.atStart}, сервер ${(timing.server / 1000).toFixed(1)} с на ${timing.reads} читань, прокрутка ${(bounded.ms / 1000).toFixed(1)} с`,
        `без межі: утримано ${mib(unbounded.retained)}, рядків у списку ${unbounded.rows}, оцінка знімків ${mib(unbounded.ghostEstimate)}; ${(unbounded.retained / unbounded.rows) | 0} Б/рядок; залишок після звільнення ${mib(bounded.residual)} / ${mib(unbounded.residual)}`,
      ].join("\n")
      console.log(report)
      // Зелений тест vitest консолі не показує: звіт — і у файл, якщо задано.
      if (process.env.WIN_REPORT) writeFileSync(process.env.WIN_REPORT, report)
      expect(bounded.owned).toBeLessThanOrEqual(5 * PAGE)
      expect(bounded.ghostEstimate).toBeLessThanOrEqual(4 * 1024 * 1024)
      // Межа тримає утримане сталим: на 100 тис. — частка від «без межі».
      if (TOTAL >= 100_000)
        expect(bounded.retained).toBeLessThan(unbounded.retained / 3)
    },
    900_000
  )
})
