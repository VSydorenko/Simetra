import { describe, expect, it } from "vitest"
import { jsonBytes } from "simetra/model"
import { inspectCore } from "../core"
import { matches, rowComparator } from "../filter"
import type { ServerRow } from "../types"
import { TASK, id, setup, taskSpec, watch } from "./support"

/*
 * Заміри критерію 5 і межі пам'яті. Запуск: `CORE_PERF=1 pnpm --filter
 * simetra test perf` — без змінної тест пропускається (час залежить від
 * машини, тож у звичайному прогоні він лише шум). Метод: `performance.now`
 * навколо операції, 30 прогрівань, потім N повторів; звіт — медіана, p95 і
 * максимум. Пороги — критерії брифу.
 */

const run = process.env.CORE_PERF === "1" ? it : it.skip

function stats(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b)
  const at = (q: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] as number
  return {
    median: at(0.5),
    p95: at(0.95),
    max: sorted[sorted.length - 1] as number,
    n: samples.length,
  }
}

function measure(n: number, fn: (i: number) => void) {
  for (let i = 0; i < 30; i++) fn(i)
  const samples: number[] = []
  for (let i = 0; i < n; i++) {
    const t = performance.now()
    fn(i)
    samples.push(performance.now() - t)
  }
  return stats(samples)
}

const WORDS = [
  "alpha",
  "Beta",
  "gamma",
  "Delta",
  "épsilon",
  "zeta",
  "Ēta",
  "theta",
]

function rows(n: number, from = 0) {
  return Array.from({ length: n }, (_, i) => ({
    id: id(from + i + 1),
    title: `${WORDS[(i * 7) % WORDS.length]} ${(i * 7919) % 10_000}`,
    rank: (i * 31) % 1000,
    done: i % 3 === 0,
  }))
}

describe("core perf", () => {
  run(
    "criterion 5a: full recompute of 5000 rows (T0 filter + typed sort) < 16 ms",
    () => {
      const data = rows(5000).map(({ id: key, ...values }) => ({ key, values }))
      const where = {
        and: [
          { attribute: "rank", op: "gte" as const, value: 100 },
          { attribute: "title", op: "contains" as const, value: "a" },
        ],
      }
      const cmp = rowComparator(taskSpec.fields, [
        { attribute: "title", direction: "asc" },
        { attribute: "rank", direction: "desc" },
      ])
      const s = measure(200, () => {
        const kept = data.filter((r) =>
          matches(taskSpec.fields, r.values, where)
        )
        kept.sort(cmp)
      })
      console.log("full recompute 5000:", s)
      expect(s.p95).toBeLessThan(16)
    }
  )

  run(
    "criterion 5b: commit of 200 rows < 2 ms (with a subscribed view)",
    async () => {
      const { server, transport, session } = setup()
      const seed = rows(200)
      server.seed(TASK, seed)
      const keys = seed.map((r) => r.id)
      watch(session.view({ kind: "keys", object: TASK, keys }))
      await transport.drain()
      let version = 1
      const s = measure(500, () => {
        version++
        const batch: ServerRow[] = seed.map(({ id: key, ...values }) => ({
          key,
          version,
          values: { ...values, rank: version },
        }))
        session.commit((w) => w.patch(TASK, batch), session.token())
      })
      console.log("commit 200 rows:", s)
      expect(s.p95).toBeLessThan(2)
    }
  )

  run(
    "p95 snapshot build + notify: one edit with a 5000-row full view and a 200-row view",
    async () => {
      const { server, transport, session } = setup()
      const seed = rows(5000)
      server.seed(TASK, seed)
      const full = watch(
        session.view({
          kind: "full",
          object: TASK,
          orderBy: [{ attribute: "title", direction: "asc" }],
        })
      )
      watch(
        session.view({
          kind: "keys",
          object: TASK,
          keys: seed.slice(0, 200).map((r) => r.id),
        })
      )
      transport.setAuto(true)
      await transport.drain()
      // 26 сторінок keyset-ом — глибше за `settle` мікрозадач.
      while (full.last.status !== "ready")
        await new Promise((r) => setTimeout(r, 0))
      expect(full.last.rows).toHaveLength(5000)
      // Сервер відповідає одразу; міряється синхронна частина дії: commit
      // журналу, перерахунок двох знімків і сповіщення. Осідання (другий
      // commit з write-back) міряється окремо.
      const act: number[] = []
      const settle: number[] = []
      for (let i = 0; i < 1030; i++) {
        const key = seed[i % 200]?.id as string
        let t = performance.now()
        session
          .begin({ policy: "predict" })
          .update(TASK, key, { title: `edit ${i}` })
          .commit()
        const a = performance.now() - t
        const before = full.frames.length
        t = performance.now()
        await transport.settle()
        const b = performance.now() - t
        if (i >= 30) {
          act.push(a)
          if (full.frames.length > before) settle.push(b)
        }
      }
      const s = stats(act)
      console.log(
        "edit → snapshots + notify:",
        s,
        "settle round (incl. microtasks):",
        stats(settle)
      )
      expect(s.p95).toBeLessThan(16)
    }
  )

  run(
    "long journal: 300 unanswered edits, then one more",
    async () => {
      const { server, transport, session } = setup()
      const seed = rows(5000)
      server.seed(TASK, seed)
      const full = watch(session.view({ kind: "full", object: TASK }))
      transport.setAuto(true)
      await transport.drain()
      while (full.last.status !== "ready")
        await new Promise((r) => setTimeout(r, 0))
      transport.setAuto(false)
      const s = measure(300, (i) => {
        session
          .begin({ policy: "predict" })
          .update(TASK, seed[i]?.id as string, { title: `j${i}` })
          .commit()
      })
      console.log("long journal edit:", s)
    },
    60_000
  )

  run(
    "memory: bytes with sections and concurrent subsets; unresolved changes are not evicted",
    async () => {
      const { server, transport, session } = setup()
      const seed = rows(1000)
      server.seed(TASK, seed)
      for (const r of seed.slice(0, 50)) {
        server.seedLines(
          TASK,
          r.id,
          "items",
          Array.from({ length: 20 }, (_, j) => ({
            id: id(100_000 + Number.parseInt(r.id.slice(-6), 16) * 100 + j),
            qty: j,
            note: "x".repeat(40),
          }))
        )
      }
      transport.setAuto(true)
      const bytes = () => {
        const insp = inspectCore(session)
        let total = 0
        for (const key of insp.rows(TASK).keys())
          total += jsonBytes(insp.row(TASK, key))
        return {
          rows: insp.rows(TASK).size,
          sections: insp.sectionCount(),
          bytes: total,
        }
      }
      const subs = [
        watch(session.view({ kind: "full", object: TASK })),
        watch(
          session.view({
            kind: "keys",
            object: TASK,
            keys: seed.slice(0, 200).map((r) => r.id),
          })
        ),
        ...seed
          .slice(0, 50)
          .map((r) =>
            watch(
              session.view({
                kind: "section",
                object: TASK,
                owner: r.id,
                section: "items",
              })
            )
          ),
      ]
      await transport.drain()
      while (subs[0]?.last.status !== "ready")
        await new Promise((r) => setTimeout(r, 0))
      const open = bytes()
      // Невирішені зміни: failed, conflict, unknown і власне створення.
      transport.setAuto(false)
      const keyOf = (i: number) => seed[i]?.id as string
      session
        .begin({ policy: "predict" })
        .update(TASK, keyOf(1), { title: "f" })
        .commit()
      // `await`: конфлікт версії без автоповтору.
      session
        .begin({ policy: "await" })
        .update(TASK, keyOf(2), { title: "c" })
        .commit()
      session
        .begin({ policy: "predict" })
        .update(TASK, keyOf(3), { title: "u" })
        .commit()
      session
        .begin({ policy: "predict" })
        .create(TASK, id(9_999_999), { title: "new", rank: 1 })
        .commit()
      await transport.settle()
      transport.take().fail({ code: "command.forbidden" })
      transport.take().fail({ code: "command.conflict", reason: "version" })
      transport.take().fail({ code: "command.timeout" })
      transport.take().fail({ code: "command.forbidden" })
      await transport.settle()
      for (const s of subs) s.unsubscribe()
      // Перечитування після відмов: тепер ключі тримає лише журнал.
      await transport.drain()
      const closed = bytes()
      console.log("memory open:", open, "after release:", closed)
      expect(closed.sections).toBe(0)
      expect(new Set(inspectCore(session).rows(TASK).keys())).toEqual(
        new Set([keyOf(1), keyOf(2), keyOf(3)])
      )
      expect(inspectCore(session).violations()).toEqual([])
    }
  )
})
