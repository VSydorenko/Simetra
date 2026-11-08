import fc from "fast-check"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { inspectCore } from "../core"
import type { ActionPolicy, MutationId, ViewHandle, ViewSpec } from "../types"
import { TASK, id, setup } from "./support"

/*
 * Модельний тест ядра (критерій 1). Випадкові переплетення: підписка й
 * відписка виглядів, власні правки обох політик, відповіді й відмови в
 * будь-якому порядку (зокрема пізні — після відписки чи `dispose()`),
 * невідомий результат, чужі правки й видалення, перечитування за сигналом,
 * повтор і скасування, плин часу відкладеного звільнення, `dispose()`.
 *
 * Еталон — проста модель журналу: показаний рядок = підтверджений рядок ⊕
 * живі `predict`-мутації в порядку журналу, з поглинанням полів успішною
 * пізнішою правкою (Р1). Інваріанти перевіряються після кожного кроку.
 */

const KEYS = [id(1), id(2), id(3), id(4)]
const SPECS: ViewSpec[] = [
  { kind: "keys", object: TASK, keys: [KEYS[0] as string, KEYS[1] as string] },
  {
    kind: "keys",
    object: TASK,
    keys: [KEYS[1] as string, KEYS[2] as string, KEYS[3] as string],
  },
  { kind: "card", object: TASK, key: KEYS[0] as string },
  {
    kind: "full",
    object: TASK,
    orderBy: [{ attribute: "title", direction: "asc" }],
  },
]

type Step =
  | { t: "sub"; view: number }
  | { t: "unsub"; view: number }
  | {
      t: "edit"
      key: number
      field: "title" | "rank"
      value: number
      policy: ActionPolicy
    }
  | {
      t: "answer"
      call: number
      how: "ok" | "stale" | "forbidden" | "conflict" | "unknown"
    }
  | { t: "other"; key: number; value: number }
  | { t: "otherRemove"; key: number }
  | { t: "signal"; key: number }
  | { t: "retry"; pick: number }
  | { t: "cancel"; pick: number }
  | { t: "time" }
  | { t: "dispose" }

const step: fc.Arbitrary<Step> = fc.oneof(
  {
    weight: 9,
    arbitrary: fc.record({
      t: fc.constant("sub" as const),
      view: fc.nat(SPECS.length - 1),
    }),
  },
  {
    weight: 6,
    arbitrary: fc.record({
      t: fc.constant("unsub" as const),
      view: fc.nat(SPECS.length - 1),
    }),
  },
  {
    weight: 12,
    arbitrary: fc.record({
      t: fc.constant("edit" as const),
      key: fc.nat(KEYS.length - 1),
      field: fc.constantFrom("title" as const, "rank" as const),
      value: fc.nat(5),
      policy: fc.constantFrom<ActionPolicy>("predict", "await"),
    }),
  },
  {
    weight: 24,
    arbitrary: fc.record({
      t: fc.constant("answer" as const),
      call: fc.nat(5),
      how: fc.constantFrom(
        "ok" as const,
        "ok" as const,
        "ok" as const,
        "stale" as const,
        "forbidden" as const,
        "conflict" as const,
        "unknown" as const
      ),
    }),
  },
  {
    weight: 6,
    arbitrary: fc.record({
      t: fc.constant("other" as const),
      key: fc.nat(KEYS.length - 1),
      value: fc.nat(5),
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      t: fc.constant("otherRemove" as const),
      key: fc.nat(KEYS.length - 1),
    }),
  },
  {
    weight: 6,
    arbitrary: fc.record({
      t: fc.constant("signal" as const),
      key: fc.nat(KEYS.length - 1),
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({ t: fc.constant("retry" as const), pick: fc.nat(5) }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      t: fc.constant("cancel" as const),
      pick: fc.nat(5),
    }),
  },
  { weight: 3, arbitrary: fc.record({ t: fc.constant("time" as const) }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("dispose" as const) }) }
)

/** Еталонний журнал власних мутацій (одна правка — одне поле одного ключа). */
interface RefMutation {
  id: MutationId
  key: string
  values: Record<string, unknown>
  policy: ActionPolicy
  state: "live" | "failed"
  /** Рядок був у сховищі на мить дії: журнал мусить його тримати (Р3). */
  hadRow: boolean
}

class Reference {
  log: RefMutation[] = []

  add(m: RefMutation) {
    this.log.push(m)
  }

  settled(mid: MutationId, ok: boolean) {
    const i = this.log.findIndex((m) => m.id === mid)
    const m = this.log[i]
    if (m === undefined) return
    if (!ok) {
      m.state = "failed"
      return
    }
    this.log.splice(i, 1)
    // Р1: успіх пізнішої правки поглинає ті самі поля раніших відмовлених.
    for (const earlier of this.log.slice(0, i)) {
      if (earlier.state !== "failed" || earlier.key !== m.key) continue
      for (const f of Object.keys(m.values)) delete earlier.values[f]
    }
    this.log = this.log.filter((x) => Object.keys(x.values).length > 0)
  }

  cancel(mid: MutationId) {
    this.log = this.log.filter((m) => m.id !== mid)
  }

  retry(mid: MutationId, next: MutationId | undefined) {
    const i = this.log.findIndex((m) => m.id === mid)
    const m = this.log[i]
    if (m === undefined) return
    this.log.splice(i, 1)
    const shadow = new Set(
      this.log
        .slice(i)
        .filter((x) => x.key === m.key)
        .flatMap((x) => Object.keys(x.values))
    )
    const values = Object.fromEntries(
      Object.entries(m.values).filter(([f]) => !shadow.has(f))
    )
    if (next !== undefined && Object.keys(values).length > 0) {
      this.log.push({ ...m, id: next, values, state: "live" })
    }
  }

  expected(key: string, confirmed: Record<string, unknown>) {
    let values = { ...confirmed }
    for (const m of this.log) {
      if (m.key === key && m.policy === "predict")
        values = { ...values, ...m.values }
    }
    return values
  }
}

async function runModel(
  steps: Step[],
  releaseDelayMs: number,
  preloaded: boolean
) {
  const { server, transport, session } = setup({ releaseDelayMs })
  server.seed(
    TASK,
    KEYS.map((k, i) => ({ id: k, title: `t${i}`, rank: i }))
  )
  const ref = new Reference()
  const handles = SPECS.map((spec) => session.view(spec))
  const subs: ((() => void) | undefined)[] = SPECS.map(() => undefined)
  const frames = SPECS.map(() => 0)
  const maxVersion = new Map<string, number>()
  let stableCheck: (string[] | undefined)[] | undefined
  const layouts = () =>
    handles.map((h, v) =>
      subs[v] === undefined ? undefined : h.getSnapshot().rows.map((r) => r.key)
    )
  let disposedAt: { frames: number[]; sent: number } | undefined

  const check = (label: string) => {
    const insp = inspectCore(session)
    if (disposedAt !== undefined) {
      // Після `dispose()` нічого не змінюється й нічого не шлеться.
      expect(frames, label).toEqual(disposedAt.frames)
      expect(transport.sent, label).toBe(disposedAt.sent)
      expect(insp.rows(TASK).size, label).toBe(0)
      expect(insp.subsetCount(), label).toBe(0)
      return
    }
    // Межа пам'яті: рядок існує, лише поки його тримає підмножина, реєстр
    // створень чи журнал (зокрема failed/conflict/unknown).
    expect(insp.violations(), label).toEqual([])
    for (const [key, row] of insp.rows(TASK)) {
      // Версія не зменшується (сервер монотонний, тож і між появами ключа).
      const max = maxVersion.get(key) ?? 0
      // Ключ, що повернувся старшою версією, ніж бачено, — лише зі `stale`
      // (ядро його перечитує); інакше версія не зменшується.
      if (row.version < max) {
        expect(
          row.stale,
          `${label}: version of ${key} ${max} → ${row.version}`
        ).toBe(true)
      } else maxVersion.set(key, row.version)
    }
    // Р3: рядок живої чи відмовленої мутації не витісняється.
    for (const m of ref.log) {
      if (m.hadRow)
        expect(
          insp.row(TASK, m.key),
          `${label}: held by log ${m.key}`
        ).toBeDefined()
    }
    // Показаний рядок = еталон.
    handles.forEach((h, v) => {
      if (subs[v] === undefined) return
      for (const row of h.getSnapshot().rows) {
        const confirmed = insp.row(TASK, row.key)
        if (confirmed === undefined) continue
        expect(row.values, `${label}: view ${v} row ${row.key}`).toEqual(
          ref.expected(row.key, confirmed.values)
        )
      }
    })
  }

  const subscribe = (v: number, h: ViewHandle) => {
    subs[v] = h.subscribe(() => {
      frames[v] = (frames[v] ?? 0) + 1
    })
  }

  // Старт: частина виглядів уже завантажена, тож правки мають базу.
  if (preloaded) {
    subscribe(0, handles[0] as ViewHandle)
    subscribe(3, handles[3] as ViewHandle)
    await transport.drain()
  }

  for (const [n, s] of steps.entries()) {
    const label = `step ${n} ${JSON.stringify(s)}`
    switch (s.t) {
      case "sub":
        if (subs[s.view] === undefined && !session.closed)
          subscribe(s.view, handles[s.view] as ViewHandle)
        break
      case "unsub":
        subs[s.view]?.()
        subs[s.view] = undefined
        break
      case "edit": {
        if (session.closed) break
        const key = KEYS[s.key] as string
        const shownBefore = handles.map(
          (h) => h.getSnapshot().rows.find((r) => r.key === key)?.values
        )
        const values = {
          [s.field]: s.field === "title" ? `v${s.value}` : s.value,
        }
        const m = session
          .begin({ policy: s.policy })
          .update(TASK, key, values)
          .commit()
        ref.add({
          id: m.id,
          key,
          values: { ...values },
          policy: s.policy,
          state: "live",
          hadRow: inspectCore(session).row(TASK, key) !== undefined,
        })
        void m.settled.then((o) => ref.settled(m.id, o.ok))
        // Дія без змін проти підтвердженого рядка осідає одразу, без `run`
        // (і за Р1 поглинає те саме поле відмовлених): commit уже стався.
        const live = handles.some((h) =>
          h
            .getSnapshot()
            .rows.some((r) => r.status.mutations.some((x) => x.id === m.id))
        )
        if (s.policy === "await" && live) {
          // `await`: між дією й commit відповіді показане значення те саме.
          handles.forEach((h, v) => {
            const after = h
              .getSnapshot()
              .rows.find((r) => r.key === key)?.values
            expect(after, `${label}: await view ${v}`).toBe(shownBefore[v])
          })
        }
        break
      }
      case "answer": {
        if (transport.calls.length === 0) break
        const call = transport.take(s.call % transport.calls.length)
        // Правило стабільності: перечитування одного ключа (сигнал) і
        // відповідь `run` не змінюють складу й порядку жодного вигляду.
        const where =
          call.query !== undefined && "where" in call.query
            ? call.query.where
            : undefined
        const refetch =
          where !== undefined &&
          "op" in where &&
          where.op === "in" &&
          (where.value as unknown[]).length === 1
        if (call.kind === "run" || refetch) stableCheck = layouts()
        if (s.how === "ok") call.answer()
        else if (s.how === "stale") call.answerStale()
        else if (s.how === "unknown")
          call.applyThenFail({ code: "command.unavailable" })
        else
          call.fail({
            code:
              s.how === "forbidden" ? "command.forbidden" : "command.conflict",
            reason: "version",
          })
        break
      }
      case "signal":
      case "other":
        stableCheck = layouts()
        if (s.t === "signal") {
          void session.refetchKeys(TASK, [KEYS[s.key] as string])
          break
        }
        if (server.row(TASK, KEYS[s.key] as string) !== undefined) {
          server.edit(TASK, KEYS[s.key] as string, { title: `o${s.value}` })
        }
        break
      case "otherRemove":
        server.remove(TASK, KEYS[s.key] as string)
        break

      case "retry":
      case "cancel": {
        const dead = ref.log.filter((m) => m.state === "failed")
        const m = dead[s.pick % Math.max(dead.length, 1)]
        if (m === undefined || session.closed) break
        if (s.t === "cancel") {
          session.cancel(m.id)
          ref.cancel(m.id)
        } else {
          const next = session.retry(m.id)
          ref.retry(m.id, next?.id)
          if (next !== undefined)
            void next.settled.then((o) => ref.settled(next.id, o.ok))
        }
        break
      }
      case "time":
        vi.advanceTimersByTime(2_000)
        break
      case "dispose":
        if (session.closed) break
        session.dispose()
        // Знімок стану до пізніх відповідей.
        disposedAt = { frames: [...frames], sent: transport.sent }
        break
    }
    await transport.settle()
    check(label)
    if (stableCheck !== undefined && disposedAt === undefined) {
      expect(layouts(), `${label}: layouts`).toEqual(stableCheck)
    }
    stableCheck = undefined
  }

  // Пізні відповіді на все, що лишилось у польоті.
  while (transport.calls.length > 0) {
    transport.take().answer()
    await transport.settle()
    check("drain")
  }
}

describe("core model", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("holds the invariants over random interleavings (release at once)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(step, { minLength: 1, maxLength: 40 }),
        fc.boolean(),
        (steps, preloaded) => runModel(steps, 0, preloaded)
      ),
      { numRuns: Number(process.env.CORE_MODEL_RUNS ?? 10_000) }
    )
  }, 600_000)

  it("holds the invariants with a delayed release", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(step, { minLength: 1, maxLength: 40 }),
        fc.boolean(),
        (steps, preloaded) => runModel(steps, 1_000, preloaded)
      ),
      { numRuns: Number(process.env.CORE_MODEL_RUNS ?? 10_000) }
    )
  }, 600_000)
})
