import { setFlagsFromString } from "node:v8"
import { runInNewContext } from "node:vm"
import { describe, expect, it } from "vitest"
import {
  jsonBytes,
  type CatalogEntry,
  type Filter,
  type OrderBy,
} from "simetra/model"
import {
  catalogEntry,
  catalogEntryAttribute,
} from "../../../model/runtime/__tests__/entries"
import { coreInternals, inspectCore, type CoreSession } from "../core"
import {
  compareRows,
  compileFilter,
  fieldInfoOf,
  filterCollator,
} from "../filter"
import type { ServerRow, Values } from "../types"
import { OBJECTS, S, TASK, key, setup, watch } from "./core-support"

/*
 * Заміри ядра й межа пам'яті (план П4-B3-2, задача 10, крок 4; спека П4-B
 * §14.3). Запуск: `CORE_PERF=1 pnpm --filter simetra test
 * src/data/store/__tests__/perf` — без змінної файл пропускається: час
 * залежить від машини. Метод часу — `performance.now` навколо операції, 30
 * прогрівань, далі N повторів; звіт — медіана, p95 і максимум. Пам'ять —
 * сума `jsonBytes` рядків сховища (звіт спайку ядра §5) і збір сесії GC
 * (звіт спайку 4 §5): `--expose-gc` через `v8.setFlagsFromString` лише в
 * процесі цього файлу, без зміни конфігурації vitest для інших тестів.
 */

const PERF = process.env.CORE_PERF === "1"

function stats(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b)
  const at = (q: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!
  const round = (n: number) => Math.round(n * 1_000) / 1_000
  return {
    median: round(at(0.5)),
    p95: round(at(0.95)),
    max: round(sorted.at(-1)!),
    n: samples.length,
  }
}

function measure(n: number, fn: (i: number) => void) {
  for (let i = 0; i < 30; i++) fn(i)
  const samples: number[] = []
  for (let i = 0; i < n; i++) {
    const t = performance.now()
    fn(i + 30)
    samples.push(performance.now() - t)
  }
  return stats(samples)
}

/** Читання фейка — мікрозадачі; сторінки `full` — довший ланцюжок. */
const drain = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r))
}

const WORDS = ["alpha", "Beta", "gamma", "Delta", "épsilon", "zeta", "Ēta"]

// Задача з числовим реквізитом: сортування `Number` поряд зі `String`.
const rankedTask: CatalogEntry = catalogEntry({
  attributes: [
    ...catalogEntry().attributes,
    catalogEntryAttribute({
      name: "rank",
      column: "rank",
      type: "Integer",
      maxLength: undefined,
    }),
  ],
})

const values = (i: number): Values => ({
  ref: key(i + 1),
  org: S,
  title: `${WORDS[(i * 7) % WORDS.length]} ${(i * 7_919) % 10_000}`,
  rank: (i * 31) % 1_000,
  notes: `body ${i}`,
})

/** Списочна форма без лінивого поля. */
const listValues = (i: number): Values =>
  Object.fromEntries(Object.entries(values(i)).filter(([f]) => f !== "notes"))

const WHERE: Filter = {
  and: [
    { attribute: "rank", op: "gte", value: 100 },
    { attribute: "title", op: "contains", value: "a" },
  ],
}
const ORDER: OrderBy = [
  { attribute: "title", direction: "asc" },
  { attribute: "rank", direction: "desc" },
]

describe.runIf(PERF)("core perf", () => {
  it("recomputes a full of 5 000 rows (gte + contains, String and Number order) with p95 < 16 ms", async () => {
    const info = fieldInfoOf(rankedTask)
    const test = compileFilter(WHERE, info, filterCollator())
    const compare = compareRows(ORDER, info, "ref", new Intl.Collator())
    const rows = Array.from({ length: 5_000 }, (_, i) => values(i))
    const recompute = measure(200, () => {
      rows.filter(test).sort(compare)
    })

    // Те саме через ядро: `full` 5 000 рядків підписаний, правка одного
    // рядка — `commit`, перебудова знімка й сповіщення.
    const { core, fake } = setup({ objects: [rankedTask, OBJECTS[1]!] })
    for (let i = 0; i < 5_000; i++) fake.insert(TASK, values(i))
    const full = core.view({
      kind: "full",
      object: TASK,
      where: WHERE,
      orderBy: ORDER,
    })
    watch(full)
    while (full.getSnapshot().status !== "ready") await drain()
    const shown = full.getSnapshot().rows.length
    const epoch = () => core.readEpoch()
    // Правка показаного рядка: склад той самий, знімок — новий.
    const target = full.getSnapshot().rows[0]!.key
    const index = Number(target.slice(-12)) - 1
    const edit = measure(200, (i) => {
      const version = 10_000 + i
      const row: ServerRow = {
        key: target,
        version,
        values: { ...listValues(index), version, rank: 500 + i },
      }
      core.commit(
        (w) => w.apply(TASK, { rows: [row], absent: [] }, epoch(), null),
        core.token()
      )
      full.getSnapshot()
    })
    console.log(
      "full 5000 recompute:",
      recompute,
      "| one-row edit:",
      edit,
      "| shown",
      shown
    )
    expect(recompute.p95).toBeLessThan(16)
    expect(edit.p95).toBeLessThan(16)
  })

  it("commits 200 rows with p95 < 2 ms", async () => {
    const { core, fake } = setup()
    for (let i = 0; i < 200; i++) fake.insert(TASK, values(i))
    const ns = Array.from({ length: 200 }, (_, i) => key(i + 1))
    watch(core.view({ kind: "keys", object: TASK, keys: ns }))
    await drain()
    const result = measure(500, (i) => {
      const version = 1_000 + i
      const rows: ServerRow[] = ns.map((k, n) => ({
        key: k,
        version,
        values: { ...listValues(n), version, title: `v${version}` },
      }))
      core.commit(
        (w) => w.apply(TASK, { rows, absent: [] }, core.readEpoch(), null),
        core.token()
      )
    })
    console.log("commit 200 rows:", result)
    expect(result.p95).toBeLessThan(2)
  })

  it("holds full 1 000 + keys 200 + 50 sections of 20 in bounded bytes, frees them all and is collected after close", async () => {
    setFlagsFromString("--expose-gc")
    const gc = runInNewContext("gc") as () => void
    // Кілька макрозадач: завершені ланцюжки обіцянок відпускають посилання.
    const heap = async () => {
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setTimeout(r, 20))
        gc()
      }
      return process.memoryUsage().heapUsed
    }
    const bytes = (core: CoreSession) => {
      const o = coreInternals(core).objects.get(TASK)!
      let rows = 0
      let header = 0
      let lines = 0
      let sections = 0
      for (const k of o.rows.keys()) {
        rows++
        header += jsonBytes(o.rows.get(k)!.row?.values ?? null)
        const section = o.sections.get(k, "lines")
        if (section !== undefined) {
          sections++
          lines += jsonBytes(section.lines)
        }
      }
      return { rows, sections, header, lines }
    }

    const base = await heap()
    let ref: WeakRef<CoreSession> | undefined
    const report = await (async () => {
      const { core, fake } = setup({ limits: { releaseDelayMs: 1 } })
      ref = new WeakRef(core)
      for (let i = 0; i < 1_000; i++) fake.insert(TASK, values(i))
      for (let i = 0; i < 50; i++) {
        fake.setLines(
          TASK,
          key(i + 1),
          "lines",
          Array.from({ length: 20 }, (_, j) => ({
            ref: key(100_000 + i * 100 + j),
            qty: j,
            comment: "x".repeat(40),
            lineNumber: j + 1,
          }))
        )
      }
      const subs = [
        watch(core.view({ kind: "full", object: TASK })),
        watch(
          core.view({
            kind: "keys",
            object: TASK,
            keys: Array.from({ length: 200 }, (_, i) => key(i + 1)),
          })
        ),
        ...Array.from({ length: 50 }, (_, i) =>
          watch(
            core.view({
              kind: "section",
              object: TASK,
              owner: key(i + 1),
              section: "lines",
            })
          )
        ),
      ]
      while (subs[0]!.seen.at(-1)?.status !== "ready") await drain()
      await drain()
      const open = bytes(core)
      const live = await heap()
      for (const sub of subs) sub.unsubscribe()
      await new Promise((r) => setTimeout(r, 20))
      await drain()
      const released = bytes(core)
      const violations = inspectCore(core).violations()
      core.close("disposed")
      return { open, released, violations, live }
    })()
    const after = await heap()
    const mib = (n: number) => `${(n / 1024 / 1024).toFixed(2)} MiB`
    console.log(
      "memory open:",
      report.open,
      "after release:",
      report.released,
      `heap with session ${mib(report.live - base)}, after close ${mib(after - base)}`
    )
    expect(report.open).toMatchObject({ rows: 1_000, sections: 50 })
    expect(report.released).toEqual({
      rows: 0,
      sections: 0,
      header: 0,
      lines: 0,
    })
    expect(report.violations).toEqual([])
    expect(
      ref?.deref(),
      "the session is collected after close()"
    ).toBeUndefined()
  }, 60_000)
})
