import { writeFileSync } from "node:fs"
import { setFlagsFromString } from "node:v8"
import { runInNewContext } from "node:vm"
import { describe, expect, it } from "vitest"
import type { OrderBy } from "simetra/model"
import { createCoreSession, inspectCore } from "../core"
import { reverseOrder } from "../filter"
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
/**
 * Після макрозадачі: ланцюжок мікрозадач закінчився, тож не тримає ні
 * завершених обіцянок, ні цілей `WeakRef` (KeepDuringJob).
 */
const heap = async () => {
  // Кілька макрозадач: завершені ланцюжки обіцянок і таймери встигають
  // відпустити свої посилання до збору.
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 20))
    gc()
  }
  return process.memoryUsage().heapUsed
}

const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

const TOTAL = Number(process.env.WIN_TOTAL ?? 100_000)
const PAGE = 100

const timing = { server: 0, reads: 0 }
let lastCore: WeakRef<object> | undefined
const register = (o: object) => {
  lastCore = new WeakRef(o)
}
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
  server.read({
    object: taskSpec.ref,
    orderBy: reverseOrder(orderBy),
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
  register(core)
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
    sizes: JSON.stringify(inspectCore(core).sizes()),
    atStart: snap.window!.atStart,
    ms,
  }
  const live = await heap()
  v.unsubscribe()
  core.dispose()
  return { ...stats, live }
}

/**
 * Утримане вікном = heapUsed з живою сесією (після GC) мінус базова лінія
 * до її створення. Кеші фейкового сервера прогріто до базової лінії.
 * `residual` — що лишилось після `dispose()` і повернення (має бути ≈0).
 */
async function scroll(server: FakeServer, ghostBytes: number) {
  const base = await heap()
  const r = await session(server, ghostBytes)
  const after = await heap()
  expect(lastCore?.deref(), "сесія зібрана після dispose()").toBeUndefined()
  if (process.env.WIN_REPORT)
    writeFileSync(
      process.env.WIN_REPORT + ".gc",
      `collected=${lastCore?.deref() === undefined}\n`,
      { flag: "a" }
    )
  // Чисте утримане сесією: залишок після її збору — пам'ять поза сесією
  // (фейковий сервер, рантайм), яка росте з кількістю читань.
  return { ...r, retained: r.live - after, residual: after - base }
}

const BUDGET = 4 * 1024 * 1024
/**
 * Межа сховища вікна (без знімків): власні сторінки (видимі ± запас) і
 * службові мапи сталого розміру (`seen`, надгробки — по 10 тис. записів).
 * Від прокрученого не залежить; число — з заміру з `ghostBytes: 0`.
 */
const STORE_MAX = 3 * 1024 * 1024

describe("пам'ять вікна", () => {
  run(
    "100 тис. рядків прокрутки: межі сховища й знімків — інваріанти",
    async () => {
      const server = makeServer()
      // Межа розділена чесно на дві: сховище (рядки у власності + службові
      // мапи) обмежене кількістю сторінок, знімки показу — байтами.
      const store = await scroll(server, 0)
      const bounded = await scroll(server, BUDGET)
      const unbounded = await scroll(server, Number.POSITIVE_INFINITY)
      const ghosts = bounded.retained - store.retained
      const mib = (n: number) => `${(n / 1024 / 1024).toFixed(2)} MiB`
      const report = [
        `сховище (ghostBytes 0): утримано ${mib(store.retained)}, рядків у сховищі ${store.owned}, рядків у списку ${store.rows}`,
        `межа 4 МіБ: утримано ${mib(bounded.retained)} = сховище ${mib(store.retained)} + знімки ${mib(ghosts)} (оцінка ядра ${mib(bounded.ghostEstimate)}), рядків у списку ${bounded.rows}, сторінок ${bounded.pages} (власних ${bounded.resident}), прокрутка ${(bounded.ms / 1000).toFixed(1)} с`,
        `без межі: утримано ${mib(unbounded.retained)}, рядків у списку ${unbounded.rows}, оцінка знімків ${mib(unbounded.ghostEstimate)}; знімок ${((unbounded.retained - store.retained) / (unbounded.rows - store.rows)) | 0} Б/рядок фактично, ${(unbounded.ghostEstimate / (unbounded.rows - store.rows)) | 0} Б/рядок за оцінкою`,
        `мапи: сховище ${store.sizes}; межа ${bounded.sizes}`,
        `залишок після dispose: ${mib(store.residual)} / ${mib(bounded.residual)} / ${mib(unbounded.residual)}`,
        `сервер ${(timing.server / 1000).toFixed(1)} с на ${timing.reads} читань`,
      ].join("\n")
      console.log(report)
      // Зелений тест vitest консолі не показує: звіт — і у файл, якщо задано.
      if (process.env.WIN_REPORT) writeFileSync(process.env.WIN_REPORT, report)
      // Інваріант 1: сховище обмежене сторінками, а не прокрученим.
      expect(store.owned).toBeLessThanOrEqual(5 * PAGE)
      expect(store.retained).toBeLessThanOrEqual(STORE_MAX)
      // Інваріант 2: оцінка знімків не перевищує межі й не занижує фактичне.
      expect(bounded.ghostEstimate).toBeLessThanOrEqual(BUDGET)
      expect(ghosts).toBeLessThanOrEqual(BUDGET)
      expect(unbounded.retained - store.retained).toBeLessThanOrEqual(
        unbounded.ghostEstimate
      )
      // Загальна межа вікна = STORE_MAX + ghostBytes.
      expect(bounded.retained).toBeLessThanOrEqual(STORE_MAX + BUDGET)
    },
    1_800_000
  )
})
