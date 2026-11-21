import fc from "fast-check"
import { channelTopic, type RightsRow } from "simetra/model"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SCOPE_KIND_ID } from "../../../model/runtime/__tests__/entries"
import { createFakeSignalTransport } from "../testing/fake-signal-transport"
import { REJOIN_JITTER_MS, QUIET_MS } from "../receiver"
import { coreInternals } from "../core"
import {
  DEFAULT_CORE_LIMITS,
  type Key,
  type RowView,
  type ViewHandle,
  type ViewSpec,
} from "../types"
import {
  ORG,
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
 * П4-B §8.4): кроки — правки, створення й видалення на фейковому сервері,
 * розриви й приєднання каналів (`fail`/`join`, `refreshTokens`), заміна
 * переліку скоупів (відпускання й повторна підписка каналу), час,
 * видимість, затримані й невдалі читання, нові вигляди й цілі `include`
 * об'єкта без власного вигляду.
 *
 * Оракул безпеки — правда фейкового сервера. Правка утримуваного каналу між
 * `fail` і `join` «втрачена». Правка, поки канал не утримується, «без
 * нагляду»: рядок такого каналу свіжий на мить свого читання. На повторній
 * підписці відпущеного каналу з записом (`gapAt` = епоха відпускання, R-c)
 * правки без нагляду стають втраченими; підписка без запису — вікно
 * активації (§8.4, до першої хвилі): лише ці правки без нагляду оракул явно
 * не рахує. Рядок без `stale`, показаний `synced`, має версію не нижчу за
 * кожну втрачену правку свого ключа й не показує втраченого видалення; повний
 * вигляд без `staleComposition` або показує втрачене створення, або має
 * `hasNewRows`.
 *
 * Оракул живучості — після тиші, приєднання кожного утримуваного каналу й
 * успішних читань видимих виглядів жоден рядок (зокрема ціль `include`) і
 * жоден вигляд не лишається `stale` чи `staleComposition`.
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

const read = (scope: string, object = "task"): RightsRow => ({
  level: "scope",
  levelId: null,
  scope,
  container: null,
  object,
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
const FRESH: ViewSpec = {
  kind: "window",
  object: TASK,
  where: { attribute: "title", op: "eq", value: "fresh" },
}
const SPECS: readonly ViewSpec[] = [
  { kind: "keys", object: TASK, keys: [key(1), key(2)] },
  { kind: "keys", object: TASK, keys: [key(3)] },
  { kind: "card", object: TASK, key: key(4) },
  FULL,
  // Ціль `include` — організація, об'єкт без власного вигляду: її канал
  // приймач не тримає ніколи.
  { kind: "full", object: TASK, include: ["org"] },
  // Порожній вигляд: вікно з фільтром сервера бере лише створені моделлю
  // рядки (`fresh`), тож спершу рядків у ньому й у сховищі від нього немає
  // (Codex: забування запису відпущеного каналу).
  FRESH,
]

type Step =
  | { t: "edit"; k: number }
  | { t: "editOrg"; scope: number }
  | { t: "create"; scope: number }
  | { t: "delete"; k: number }
  | { t: "fail"; ch: number }
  | { t: "join"; ch: number; recovered: boolean }
  | { t: "refreshTokens" }
  | { t: "scopes"; ch: number }
  | { t: "time"; ms: number }
  | { t: "revalidate" }
  | { t: "visible"; v: number; on: boolean }
  | { t: "hold" }
  | { t: "unsub"; v: number }
  | { t: "sub"; v: number }
  | { t: "unsubAll" }
  | { t: "mount" }
  | { t: "release"; ok: boolean; at: boolean }

const one = <T extends Step["t"]>(t: T) => fc.constant(t)
export const STEP = fc.oneof(
  { weight: 6, arbitrary: fc.record({ t: one("edit"), k: fc.nat(7) }) },
  { weight: 1, arbitrary: fc.record({ t: one("editOrg"), scope: fc.nat(1) }) },
  { weight: 3, arbitrary: fc.record({ t: one("create"), scope: fc.nat(1) }) },
  { weight: 1, arbitrary: fc.record({ t: one("delete"), k: fc.nat(7) }) },
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
  { weight: 3, arbitrary: fc.record({ t: one("scopes"), ch: fc.nat(1) }) },
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
  {
    weight: 1,
    arbitrary: fc.record({ t: one("unsub"), v: fc.nat(SPECS.length - 1) }),
  },
  {
    weight: 1,
    arbitrary: fc.record({ t: one("sub"), v: fc.nat(SPECS.length - 1) }),
  },
  // Зняти всі вигляди, крім порожнього: у сховищі не лишається рядків.
  { weight: 3, arbitrary: fc.record({ t: one("unsubAll") }) },
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
let rightsVersion = 1

const failWith = (at: string, what: string, trace: readonly string[]) => {
  throw new Error(`${at}: ${what}\n${trace.join("\n")}`)
}

async function run(steps: readonly Step[]): Promise<void> {
  const transport = createFakeSignalTransport()
  const h = setup({
    rightsSnapshot: true,
    signals: transport,
    objects: [task, org],
  })
  const internals = coreInternals(h.core)
  // Перелік скоупів задає підписки; права читання лишаються — заміна
  // переліку відпускає канал, не прибираючи рядків.
  const scopeSet = SCOPES.map(() => true)
  const snapshot = () => ({
    userId: USER,
    scopeSets: SCOPES.filter((_, n) => scopeSet[n]).map((scope) => ({
      scopeKind: SCOPE_KIND_ID,
      scope,
    })),
    rights: [
      ...SCOPES.map((scope) => read(scope)),
      ...SCOPES.map((scope) => read(scope, "organization")),
    ],
    members: [],
    dimensionValues: [],
  })
  h.fake.rightsSnapshot = snapshot()
  h.fake.rightsVersion = String(rightsVersion++ % 10).repeat(64)
  for (const scope of SCOPES) h.fake.insert(ORG, { ref: scope })
  const scopeOfKey = new Map<Key, number>()
  for (const { n, scope } of START_KEYS) {
    h.fake.insert(TASK, taskValues(n, { org: SCOPES[scope] }))
    scopeOfKey.set(key(n), scope)
  }
  const specs: ViewSpec[] = [...SPECS]
  const handles: ViewHandle[] = SPECS.map((spec) => h.core.view(spec))
  // Відписка слухача: вигляд звільняється після затримки звільнення.
  const offs: ((() => void) | undefined)[] = handles.map((handle) =>
    handle.subscribe(() => {})
  )
  const sub = (v: number) => {
    if (offs[v] === undefined) offs[v] = handles[v]!.subscribe(() => {})
  }
  const unsub = (v: number) => {
    offs[v]?.()
    offs[v] = undefined
  }
  await settle()
  for (const ch of CHANNELS)
    expect(transport.subscribed().has(ch), ch).toBe(true)
  // Справжній транспорт кличе `onSubscribed` після першої підписки; перша
  // хвиля закриває вікно активації до кроків моделі.
  for (const ch of CHANNELS) transport.join(ch, false)
  await vi.advanceTimersByTimeAsync(REJOIN_JITTER_MS)
  await settle()

  // Правда сервера про доставку: канал утримується (підписаний) і «живий»
  // між `join` і `fail`.
  const held = CHANNELS.map(() => true)
  const live = CHANNELS.map(() => true)
  // Найбільша версія втраченої правки ключа; втрачені створення й видалення.
  const lost = new Map<Key, number>()
  const lostCreates = new Set<Key>()
  const lostDeletes = new Set<Key>()
  // Правки без нагляду (канал не утримується): ключ → найбільша версія.
  const unwatched = CHANNELS.map(
    () => new Map<Key, { version: number; op: Op }>()
  )
  const deleted = new Set<Key>()
  let created = 100
  const trace: string[] = []

  type Op = "create" | "update" | "delete"
  const loseInto = (k: Key, version: number, op: Op) => {
    lost.set(k, Math.max(lost.get(k) ?? 0, version))
    if (op === "create") lostCreates.add(k)
    if (op === "delete") lostDeletes.add(k)
  }
  const signal = (k: Key, op: Op, version: number) => {
    const ch = scopeOfKey.get(k)!
    if (!held[ch]) {
      const prior = unwatched[ch]!.get(k)
      unwatched[ch]!.set(k, {
        version: Math.max(prior?.version ?? 0, version),
        op: prior?.op === "create" && op === "update" ? "create" : op,
      })
      return
    }
    if (live[ch]) {
      transport.emit(CHANNELS[ch]!, {
        id: String(++signalId),
        object: task.id,
        op,
        keys: { id: k },
        row_ver: version,
      })
      return
    }
    loseInto(k, version, op)
  }

  // Канали, що підписка справді тримає після кроку: відпущений чи
  // підписаний знову.
  const syncHeld = () => {
    for (const [ch, channel] of CHANNELS.entries()) {
      const now = transport.subscribed().has(channel)
      if (held[ch] === now) continue
      held[ch] = now
      if (!now) continue
      // R-c: відпущений канал з записом приєднується після розриву, і правки
      // без нагляду стають втраченими; без запису — вікно активації.
      if (internals.epochs.gapAt(channel) > 0)
        for (const [k, u] of unwatched[ch]!) loseInto(k, u.version, u.op)
      unwatched[ch]!.clear()
      // Справжній транспорт дає `onSubscribed` після підписки.
      live[ch] = true
      transport.join(channel, false)
    }
  }

  const check = (at: string) => {
    for (const [v, handle] of handles.entries()) {
      if (offs[v] === undefined) continue
      const snap = handle.getSnapshot()
      for (const row of snap.rows) {
        if (row.state === "removed" || row.hidden === true) continue
        if (row.stale === true || row.state !== "synced") continue
        const floor = lost.get(row.key)
        if (floor !== undefined && row.version < floor)
          failWith(
            at,
            `view ${v} shows ${row.key} v${row.version} synced, a lost edit has v${floor}`,
            trace
          )
        if (lostDeletes.has(row.key))
          failWith(
            at,
            `view ${v} shows ${row.key} synced after a lost delete`,
            trace
          )
      }
      const spec = specs[v]
      if (spec !== FULL && spec !== FRESH) continue
      if (snap.staleComposition === true) continue
      if (snap.status !== "ready" || snap.hasNewRows) continue
      const shown = new Set(snap.rows.map((r) => r.key))
      for (const k of lostCreates) {
        if (shown.has(k) || deleted.has(k)) continue
        // Порожній вигляд мусить показати лише рядок, що досі йому підходить.
        if (spec === FRESH && h.fake.row(TASK, k)?.values.title !== "fresh")
          continue
        failWith(
          at,
          `view ${v} misses the lost create ${k} with a confirmed composition`,
          trace
        )
      }
    }
  }

  for (const [i, s] of steps.entries()) {
    trace.push(`${i}: ${JSON.stringify(s)}`)
    switch (s.t) {
      case "edit": {
        const all = [...scopeOfKey.keys()].filter((k) => !deleted.has(k))
        if (all.length === 0) break
        const k = all[s.k % all.length]!
        const version = h.fake.edit(TASK, k, { title: `e${i}` })
        signal(k, "update", version)
        break
      }
      case "editOrg":
        // Канал організації ніхто не тримає: правка без сигналу, ціль
        // свіжа на мить свого читання.
        h.fake.edit(ORG, SCOPES[s.scope]!, {})
        break
      case "create": {
        const n = ++created
        const k = key(n)
        scopeOfKey.set(k, s.scope)
        const version = h.fake.insert(
          TASK,
          taskValues(n, { org: SCOPES[s.scope], title: "fresh" })
        )
        signal(k, "create", version)
        break
      }
      case "delete": {
        const all = [...scopeOfKey.keys()].filter((k) => !deleted.has(k))
        if (all.length === 0) break
        const k = all[s.k % all.length]!
        const version = h.fake.row(TASK, k)!.version + 1
        h.fake.remove(TASK, k)
        deleted.add(k)
        signal(k, "delete", version)
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
        if (held[s.ch]) live[s.ch] = true
        transport.join(CHANNELS[s.ch]!, s.recovered)
        break
      case "refreshTokens":
        for (const [ch, on] of held.entries()) if (on) live[ch] = true
        await transport.refreshTokens()
        break
      case "scopes": {
        // Заміна знімка прав з іншим переліком скоупів: канал відпускається
        // чи підписується знову. Знімок читається поза затриманими читаннями.
        scopeSet[s.ch] = !scopeSet[s.ch]
        const mode = h.fake.mode
        h.fake.mode = "auto"
        h.fake.rightsSnapshot = snapshot()
        h.fake.rightsVersion = String(rightsVersion++ % 10).repeat(64)
        h.core.requestRights()
        await vi.advanceTimersByTimeAsync(0)
        await settle()
        h.fake.mode = mode
        break
      }
      case "time":
        await vi.advanceTimersByTimeAsync(s.ms)
        break
      case "revalidate":
        h.core.revalidate(TASK, { visibleOnly: true }).catch(() => {})
        break
      case "visible":
        if (offs[s.v] !== undefined) h.core.setVisible(specs[s.v]!, s.on)
        break
      case "hold":
        h.fake.mode = "manual"
        break
      case "unsub":
        unsub(s.v)
        break
      case "sub":
        sub(s.v)
        break
      case "unsubAll":
        for (const v of handles.keys()) if (specs[v] !== FRESH) unsub(v)
        // Вигляди звільняються після затримки: сховище лишається без їхніх
        // рядків у тому самому кроці.
        await vi.advanceTimersByTimeAsync(DEFAULT_CORE_LIMITS.releaseDelayMs)
        break
      case "mount": {
        // Новий вигляд читає в сховище ключі, яких там ще не було (зокрема
        // між розривом і приєднанням): створені моделлю й останній вихідний.
        const keys = [...scopeOfKey.keys()].slice(-3)
        const spec: ViewSpec = { kind: "keys", object: TASK, keys }
        if (specs.some((x) => JSON.stringify(x) === JSON.stringify(spec))) break
        specs.push(spec)
        const handle = h.core.view(spec)
        handles.push(handle)
        offs.push(handle.subscribe(() => {}))
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
    syncHeld()
    await settle()
    check(`step ${i}`)
  }

  // Живучість: тиша, приєднання кожного утримуваного каналу, усі вигляди
  // видимі й успішно перечитані — ні `stale`, ні `staleComposition`.
  h.fake.mode = "auto"
  h.fake.deliverAll()
  await settle()
  // Вигляди повертаються першими: приймач підписує їхні канали знову, а
  // модель приєднує кожен утримуваний (і щойно підписаний) канал.
  for (const v of handles.keys()) sub(v)
  await settle()
  syncHeld()
  for (const [ch, channel] of CHANNELS.entries()) {
    if (!held[ch]) continue
    live[ch] = true
    transport.join(channel, false)
  }
  await settle()
  for (const spec of specs) h.core.setVisible(spec, true)
  await vi.advanceTimersByTimeAsync(2 * REJOIN_JITTER_MS)
  await settle()
  await h.core.revalidate(TASK, { visibleOnly: true })
  await settle()
  // Вигляд, чиє перше завантаження збоїло, системне перечитування не бере:
  // успішне читання йому дає лише `refresh()`.
  for (const handle of handles)
    if (handle.getSnapshot().status === "error") handle.refresh()
  await settle()
  check("end")
  const staleRow = (row: RowView): boolean =>
    row.state !== "removed" &&
    (row.stale === true ||
      Object.values(row.refs ?? {}).some((r) => r !== null && staleRow(r)))
  for (const [v, handle] of handles.entries()) {
    const snap = handle.getSnapshot()
    if (snap.status === "error")
      failWith("end", `view ${v} is in error after successful reads`, trace)
    if (snap.staleComposition === true)
      failWith("end", `view ${v} keeps staleComposition`, trace)
    for (const row of snap.rows)
      if (staleRow(row))
        failWith("end", `view ${v} keeps a stale row ${row.key}`, trace)
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
        fc.asyncProperty(
          fc.array(STEP, { maxLength: 40, size: "medium" }),
          (steps) => run(steps)
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
      "Codex: an empty view, a create lost in a gap, a release with no rows",
      [
        { t: "unsubAll" },
        { t: "time", ms: REJOIN_JITTER_MS },
        { t: "fail", ch: 0 },
        { t: "create", scope: 0 },
        { t: "scopes", ch: 0 },
      ],
    ],
    [
      "r5: a create lost in a gap, then the channel released",
      [
        { t: "fail", ch: 0 },
        { t: "create", scope: 0 },
        { t: "scopes", ch: 0 },
      ],
    ],
    [
      "r5 A: a released channel and a connection gap",
      [
        { t: "scopes", ch: 1 },
        { t: "fail", ch: 2 },
        { t: "join", ch: 0, recovered: false },
        { t: "time", ms: REJOIN_JITTER_MS },
      ],
    ],
    [
      "r5 A2: a gap of a channel, then its release",
      [{ t: "fail", ch: 1 }, { t: "scopes", ch: 1 }, { t: "revalidate" }],
    ],
    [
      "r5 B: a connection gap with an include target nobody holds",
      [
        { t: "fail", ch: 2 },
        { t: "editOrg", scope: 0 },
        { t: "join", ch: 0, recovered: false },
        { t: "join", ch: 1, recovered: false },
        { t: "time", ms: REJOIN_JITTER_MS },
      ],
    ],
    [
      "r5 D: release, an edit, resubscribe with an invisible view",
      [
        { t: "visible", v: 0, on: false },
        { t: "scopes", ch: 0 },
        { t: "edit", k: 0 },
        { t: "scopes", ch: 0 },
        { t: "time", ms: REJOIN_JITTER_MS },
      ],
    ],
    [
      "a lost delete",
      [
        { t: "fail", ch: 0 },
        { t: "delete", k: 0 },
        { t: "time", ms: 60_000 },
        { t: "join", ch: 0, recovered: true },
        { t: "time", ms: REJOIN_JITTER_MS },
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
