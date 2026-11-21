import fc from "fast-check"
import { channelTopic, type RightsRow } from "simetra/model"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SCOPE_KIND_ID } from "../../../model/runtime/__tests__/entries"
import { createFakeSignalTransport } from "../testing/fake-signal-transport"
import { REJOIN_JITTER_MS, QUIET_MS } from "../receiver"
import type { Key, ViewHandle, ViewSpec } from "../types"
import {
  TASK,
  key,
  org,
  S,
  settle,
  setup,
  task,
  taskValues,
} from "./core-support"

/*
 * Модель приймача над справжнім ядром (план B5b-3, задача 4, раунд 5; спека
 * П4-B §8.4): кроки — правки й створення на фейковому сервері, розриви й
 * приєднання каналів (`fail`/`join`, `refreshTokens`), час, видимість,
 * затримані й невдалі читання. Оракул — правда фейкового сервера: правка, чий
 * сигнал не дійшов, бо канал був між `fail` і `join`, «втрачена»; рядок без
 * `stale` має версію не нижчу за кожну втрачену правку свого ключа, а вигляд без
 * `staleComposition` або показує втрачене створення, або має `hasNewRows`.
 */

const T = "00000000-0000-4000-8000-0000000000b2"
const SCOPES = [S, T] as const
const USER = "00000000-0000-4000-8000-0000000000a1"

const channelOf = (scope: string) =>
  channelTopic({
    kind: "changes",
    scopeKindId: SCOPE_KIND_ID,
    scope,
    object: task.id,
  })
const CHANNELS = SCOPES.map(channelOf)

const read = (scope: string): RightsRow => ({
  level: "scope",
  levelId: null,
  scope,
  container: null,
  object: "task",
  action: "read",
  extent: "any",
  dimensionId: null,
})

// Ключі 1–2 у скоупі S, 3–4 — у T; створені моделлю — з 100.
const START_KEYS: readonly { n: number; scope: number }[] = [
  { n: 1, scope: 0 },
  { n: 2, scope: 0 },
  { n: 3, scope: 1 },
  { n: 4, scope: 1 },
]
const FULL: ViewSpec = { kind: "full", object: TASK }
const SPECS: readonly ViewSpec[] = [
  { kind: "keys", object: TASK, keys: [key(1), key(2)] },
  { kind: "keys", object: TASK, keys: [key(3)] },
  { kind: "card", object: TASK, key: key(4) },
  FULL,
]

type Step =
  | { t: "edit"; k: number }
  | { t: "create"; scope: number }
  | { t: "fail"; ch: number }
  | { t: "join"; ch: number; recovered: boolean }
  | { t: "refreshTokens" }
  | { t: "time"; ms: number }
  | { t: "revalidate" }
  | { t: "visible"; v: number; on: boolean }
  | { t: "hold" }
  | { t: "mount" }
  | { t: "release"; ok: boolean; at: boolean }

const one = <T extends Step["t"]>(t: T) => fc.constant(t)
export const STEP = fc.oneof(
  { weight: 6, arbitrary: fc.record({ t: one("edit"), k: fc.nat(7) }) },
  { weight: 2, arbitrary: fc.record({ t: one("create"), scope: fc.nat(1) }) },
  { weight: 4, arbitrary: fc.record({ t: one("fail"), ch: fc.nat(2) }) },
  {
    weight: 4,
    arbitrary: fc.record({
      t: one("join"),
      ch: fc.nat(1),
      recovered: fc.boolean(),
    }),
  },
  { weight: 1, arbitrary: fc.record({ t: one("refreshTokens") }) },
  {
    weight: 4,
    arbitrary: fc.record({
      t: one("time"),
      ms: fc.constantFrom(0, 1, QUIET_MS, 500, REJOIN_JITTER_MS, 60_000),
    }),
  },
  { weight: 2, arbitrary: fc.record({ t: one("revalidate") }) },
  {
    weight: 2,
    arbitrary: fc.record({
      t: one("visible"),
      v: fc.nat(SPECS.length - 1),
      on: fc.boolean(),
    }),
  },
  { weight: 2, arbitrary: fc.record({ t: one("hold") }) },
  { weight: 2, arbitrary: fc.record({ t: one("mount") }) },
  {
    weight: 2,
    arbitrary: fc.record({
      t: one("release"),
      ok: fc.boolean(),
      at: fc.boolean(),
    }),
  }
) as fc.Arbitrary<Step>

let signalId = 0

async function run(steps: readonly Step[]): Promise<void> {
  const transport = createFakeSignalTransport()
  const h = setup({
    rightsSnapshot: true,
    signals: transport,
    objects: [task, org],
  })
  h.fake.rightsSnapshot = {
    userId: USER,
    scopeSets: SCOPES.map((scope) => ({ scopeKind: SCOPE_KIND_ID, scope })),
    rights: SCOPES.map(read),
    members: [],
    dimensionValues: [],
  }
  h.fake.rightsVersion = "1".repeat(64)
  const scopeOfKey = new Map<Key, number>()
  for (const { n, scope } of START_KEYS) {
    h.fake.insert(TASK, taskValues(n, { org: SCOPES[scope] }))
    scopeOfKey.set(key(n), scope)
  }
  const specs: ViewSpec[] = [...SPECS]
  const handles: ViewHandle[] = SPECS.map((spec) => {
    const handle = h.core.view(spec)
    handle.subscribe(() => {})
    return handle
  })
  await settle()
  for (const ch of CHANNELS)
    expect(transport.subscribed().has(ch), ch).toBe(true)
  // Справжній транспорт кличе `onSubscribed` після першої підписки: без цього
  // каналу немає в регістрах, і розрив з'єднання до першого приєднання —
  // вікно, яке за дизайном закриває перша хвиля, а не модель.
  for (const ch of CHANNELS) transport.join(ch, false)
  await vi.advanceTimersByTimeAsync(REJOIN_JITTER_MS)
  await settle()

  // Правда сервера про доставку: канал «живий» між `join` і `fail`.
  const live = CHANNELS.map(() => true)
  // Найбільша версія втраченої правки ключа; втрачені створення.
  const lost = new Map<Key, number>()
  const lostCreates = new Set<Key>()
  let created = 100
  const trace: string[] = []

  const signal = (k: Key, op: "create" | "update", version: number) => {
    const scope = scopeOfKey.get(k)!
    if (live[scope]) {
      transport.emit(CHANNELS[scope]!, {
        id: String(++signalId),
        object: task.id,
        op,
        keys: { id: k },
        row_ver: version,
      })
      return
    }
    lost.set(k, Math.max(lost.get(k) ?? 0, version))
    if (op === "create") lostCreates.add(k)
  }

  const check = (at: string) => {
    for (const [v, handle] of handles.entries()) {
      const snapshot = handle.getSnapshot()
      for (const row of snapshot.rows) {
        if (row.state === "removed" || row.hidden === true) continue
        const floor = lost.get(row.key)
        if (
          floor !== undefined &&
          row.stale !== true &&
          row.state === "synced" &&
          row.version < floor
        )
          throw new Error(
            `${at}: view ${v} shows ${row.key} v${row.version} synced, a lost edit has v${floor}\n${trace.join("\n")}`
          )
      }
      if (specs[v] !== FULL || snapshot.staleComposition === true) continue
      if (snapshot.status === "loading" || snapshot.hasNewRows) continue
      const shown = new Set(snapshot.rows.map((r) => r.key))
      for (const k of lostCreates)
        if (!shown.has(k))
          throw new Error(
            `${at}: the full view misses the lost create ${k} with a confirmed composition\n${trace.join("\n")}`
          )
    }
  }

  for (const [i, s] of steps.entries()) {
    trace.push(`${i}: ${JSON.stringify(s)}`)
    switch (s.t) {
      case "edit": {
        const all = [...scopeOfKey.keys()]
        const k = all[s.k % all.length]!
        const version = h.fake.edit(TASK, k, { title: `e${i}` })
        signal(k, "update", version)
        break
      }
      case "create": {
        const n = ++created
        const k = key(n)
        scopeOfKey.set(k, s.scope)
        const version = h.fake.insert(
          TASK,
          taskValues(n, { org: SCOPES[s.scope] })
        )
        signal(k, "create", version)
        break
      }
      case "fail": {
        const channel = CHANNELS[s.ch]
        if (channel === undefined) live.fill(false)
        else live[s.ch] = false
        transport.fail({ kind: "transport", channel })
        break
      }
      case "join":
        live[s.ch] = true
        transport.join(CHANNELS[s.ch]!, s.recovered)
        break
      case "refreshTokens":
        live.fill(true)
        await transport.refreshTokens()
        break
      case "time":
        await vi.advanceTimersByTimeAsync(s.ms)
        break
      case "revalidate":
        h.core.revalidate(TASK, { visibleOnly: true }).catch(() => {})
        break
      case "visible":
        h.core.setVisible(SPECS[s.v]!, s.on)
        break
      case "hold":
        h.fake.mode = "manual"
        break
      case "mount": {
        // Новий вигляд читає в сховище ключі, яких там ще не було (зокрема
        // між розривом і приєднанням): створені моделлю й останній вихідний.
        const keys = [...scopeOfKey.keys()].slice(-3)
        const spec: ViewSpec = { kind: "keys", object: TASK, keys }
        if (specs.some((x) => JSON.stringify(x) === JSON.stringify(spec))) break
        specs.push(spec)
        const handle = h.core.view(spec)
        handle.subscribe(() => {})
        handles.push(handle)
        break
      }
      case "release":
        h.fake.mode = "auto"
        while (h.fake.pending.length > 0) {
          const pending = h.fake.take(0)
          if (!s.ok) pending.fail("command.unavailable")
          // Сервер виконав читання в мить його надходження, а не доставки.
          else pending.answer(s.at ? pending.issuedAt : undefined)
        }
        break
    }
    await settle()
    check(`step ${i}`)
  }

  // Живучість: після приєднання кожного каналу й успішного перечитування
  // видимих виглядів позначок і непідтвердженого складу не лишається.
  h.fake.mode = "auto"
  h.fake.deliverAll()
  for (const [ch, channel] of CHANNELS.entries()) {
    live[ch] = true
    transport.join(channel, false)
  }
  for (const spec of specs) h.core.setVisible(spec, true)
  await vi.advanceTimersByTimeAsync(2 * REJOIN_JITTER_MS)
  await settle()
  await h.core.revalidate(TASK, { visibleOnly: true })
  await settle()
  check("end")
  for (const [v, handle] of handles.entries()) {
    const snapshot = handle.getSnapshot()
    if (snapshot.status === "error") continue
    if (snapshot.staleComposition === true)
      throw new Error(
        `end: view ${v} keeps staleComposition\n${trace.join("\n")}`
      )
    for (const row of snapshot.rows)
      if (row.state !== "removed" && lost.has(row.key) && row.stale === true)
        throw new Error(
          `end: view ${v} keeps the mark of ${row.key}\n${trace.join("\n")}`
        )
  }
}

const RUNS = Number(process.env.CORE_MODEL_RUNS ?? 200)

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(Math, "random").mockReturnValue(0.5)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe("receiver model: the disconnect mark and the composition against the server truth", () => {
  it(
    "holds the oracle over random steps",
    async () => {
      await fc.assert(
        fc.asyncProperty(fc.array(STEP, { maxLength: 40 }), (steps) =>
          run(steps)
        ),
        { numRuns: RUNS }
      )
    },
    RUNS * 150 + 10_000
  )

  // Регресії класу «розрив» (раунди 1–5): кожна — кроки, на яких падала
  // попередня реалізація.
  it.each<[string, Step[]]>([
    [
      "C1: two joins after a gap, recovered first, no wave yet",
      [
        { t: "fail", ch: 0 },
        { t: "edit", k: 0 },
        { t: "join", ch: 0, recovered: true },
        { t: "join", ch: 0, recovered: false },
        { t: "time", ms: QUIET_MS },
      ],
    ],
    [
      "C1: two joins after a gap, recovered last",
      [
        { t: "fail", ch: 0 },
        { t: "edit", k: 1 },
        { t: "join", ch: 0, recovered: false },
        { t: "join", ch: 0, recovered: true },
        { t: "time", ms: QUIET_MS },
      ],
    ],
    [
      "C3: a recovered invalidate while the views are invisible",
      [
        { t: "visible", v: 0, on: false },
        { t: "visible", v: 3, on: false },
        { t: "fail", ch: 0 },
        { t: "edit", k: 0 },
        { t: "join", ch: 0, recovered: true },
        { t: "time", ms: REJOIN_JITTER_MS },
      ],
    ],
    [
      "C2: the wave read fails, a later read succeeds",
      [
        { t: "fail", ch: 0 },
        { t: "edit", k: 0 },
        { t: "join", ch: 0, recovered: false },
        { t: "hold" },
        { t: "time", ms: REJOIN_JITTER_MS },
        { t: "release", ok: false, at: false },
        { t: "revalidate" },
      ],
    ],
    [
      "P1: a new gap before the jitter of the wave",
      [
        { t: "fail", ch: 0 },
        { t: "join", ch: 0, recovered: false },
        { t: "fail", ch: 0 },
        { t: "edit", k: 0 },
        { t: "time", ms: REJOIN_JITTER_MS },
      ],
    ],
    [
      "P2: a connection-wide gap before the jitter of the wave",
      [
        { t: "fail", ch: 0 },
        { t: "join", ch: 0, recovered: false },
        { t: "fail", ch: 2 },
        { t: "edit", k: 1 },
        { t: "time", ms: REJOIN_JITTER_MS },
      ],
    ],
    [
      "r4: an older wave read answers after the newer wave",
      [
        { t: "fail", ch: 0 },
        { t: "join", ch: 0, recovered: false },
        { t: "hold" },
        { t: "time", ms: REJOIN_JITTER_MS },
        { t: "fail", ch: 0 },
        { t: "edit", k: 0 },
        { t: "join", ch: 0, recovered: false },
        { t: "visible", v: 0, on: false },
        { t: "time", ms: 2 * REJOIN_JITTER_MS },
        { t: "release", ok: true, at: true },
      ],
    ],
    [
      "r4: a read started before the gap in the same clock tick",
      [
        { t: "hold" },
        { t: "revalidate" },
        { t: "fail", ch: 0 },
        { t: "edit", k: 0 },
        { t: "create", scope: 0 },
        { t: "join", ch: 0, recovered: false },
        { t: "visible", v: 0, on: false },
        { t: "visible", v: 3, on: false },
        { t: "release", ok: true, at: true },
      ],
    ],
    [
      "Q3: a view mounted between fail and join, an edit in the gap",
      [
        { t: "create", scope: 0 },
        { t: "fail", ch: 0 },
        { t: "mount" },
        { t: "edit", k: 4 },
        { t: "time", ms: 1 },
      ],
    ],
    [
      "Q3: a view read between fail and join, an edit in the gap",
      [
        { t: "fail", ch: 1 },
        { t: "edit", k: 2 },
        { t: "revalidate" },
        { t: "edit", k: 2 },
        { t: "time", ms: 60_000 },
      ],
    ],
    [
      "a create missed in the gap, the wave read started before the gap",
      [
        { t: "hold" },
        { t: "revalidate" },
        { t: "fail", ch: 1 },
        { t: "create", scope: 1 },
        { t: "refreshTokens" },
        { t: "visible", v: 3, on: false },
        { t: "release", ok: true, at: true },
      ],
    ],
  ])("%s", async (_, steps) => {
    await run(steps)
  })
})
