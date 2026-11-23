import fc from "fast-check"
import { channelTopic, type RightsRow } from "simetra/model"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SCOPE_KIND_ID } from "../../../model/runtime/__tests__/entries"
import { createFakeSignalTransport } from "../testing/fake-signal-transport"
import type { FakeRead } from "../testing/fake-source"
import { coreInternals } from "../core"
import { REJOIN_JITTER_MS, QUIET_MS } from "../receiver"
import {
  DEFAULT_CORE_LIMITS,
  type Key,
  type RowView,
  type ViewHandle,
  type ViewSnapshot,
  type ViewSpec,
} from "../types"
import {
  ORG,
  TASK,
  key,
  org,
  S,
  interruptWithin,
  modelRun,
  settle,
  settleRuns,
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
 * нагляду»: рядок такого каналу свіжий на мить свого читання. Повторна
 * підписка каналу з записом (R-c; запис модель визначає зі своєї правди —
 * у мить відпускання підписаний вигляд показував рядок скоупу, а відписок
 * відтоді не було) робить усі правки без нагляду втраченими одразу. Без
 * запису — вікно активації (§8.4): створення, правки й видалення без нагляду
 * не судяться, доки не осяде перша хвиля підписки (межа — час моделі й
 * події фейків, без стану ядра); після нього старе значення без `stale`
 * дозволене, лише коли кожен вигляд, що його показує, має `staleComposition`,
 * а пропущене створення — лише вигляду з `staleComposition`.
 * Рядок без `stale`, показаний `synced`, має версію не нижчу за
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
// Канали моделі: спершу задач (за SCOPES), далі організацій — цілі `include`,
// яку приймач тримає через її власний вигляд.
const ORG_FROM = CHANNELS.length
const ALL_CHANNELS = [
  ...CHANNELS,
  ...SCOPES.map((scope) =>
    channelTopic({
      kind: "changes",
      scopeKindId: SCOPE_KIND_ID,
      scope,
      object: org.id,
    })
  ),
]

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
// Власний вигляд цілі `include` без рядків: приймач тримає канали
// організацій, а рядки організацій у сховищі — лише від `include`.
const ORG_OWN: ViewSpec = { kind: "keys", object: ORG, keys: [key(77)] }
const SPECS: readonly ViewSpec[] = [
  { kind: "keys", object: TASK, keys: [key(1), key(2)] },
  { kind: "keys", object: TASK, keys: [key(3)] },
  { kind: "card", object: TASK, key: key(4) },
  FULL,
  // Ціль `include` — організація; її канали тримає власний вигляд `ORG_OWN`.
  { kind: "full", object: TASK, include: ["org"] },
  // Порожній вигляд: вікно з фільтром сервера бере лише створені моделлю
  // рядки (`fresh`), тож спершу рядків у ньому й у сховищі від нього немає
  // (Codex: забування запису відпущеного каналу).
  FRESH,
  ORG_OWN,
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
  | { t: "rejoinFresh"; v: number; create: boolean }
  | { t: "releaseInFlight"; v: number; org: boolean; at: boolean }
  | { t: "mount" }
  // `broken` — збій читання (відповідь джерела відхилено), а не відмова сервера.
  | { t: "release"; ok: boolean; at: boolean; broken?: boolean }

const one = <T extends Step["t"]>(t: T) => fc.constant(t)
export const STEP = fc.oneof(
  { weight: 6, arbitrary: fc.record({ t: one("edit"), k: fc.nat(7) }) },
  { weight: 1, arbitrary: fc.record({ t: one("editOrg"), scope: fc.nat(1) }) },
  { weight: 3, arbitrary: fc.record({ t: one("create"), scope: fc.nat(1) }) },
  { weight: 1, arbitrary: fc.record({ t: one("delete"), k: fc.nat(7) }) },
  // 0–1 — канал задач, 2 — з'єднання, 3–4 — канал організацій.
  { weight: 4, arbitrary: fc.record({ t: one("fail"), ch: fc.nat(4) }) },
  {
    weight: 4,
    arbitrary: fc.record({
      t: one("join"),
      ch: fc.nat(ALL_CHANNELS.length - 1),
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
    weight: 3,
    arbitrary: fc.record({ t: one("sub"), v: fc.nat(SPECS.length - 1) }),
  },
  // Повторна підписка каналу без запису: зняти всі вигляди, відпустити
  // канал, повернути вигляд, правка без нагляду, підписати знову — одним
  // кроком, бо випадкова послідовність п'яти кроків трапляється рідко.
  {
    weight: 2,
    arbitrary: fc.record({
      t: one("rejoinFresh"),
      v: fc.constantFrom(0, 3, 4),
      create: fc.boolean(),
    }),
  },
  // Відпустити канал, поки летить читання вигляду, що запише його рядки
  // (зокрема як ціль `include`), правка без нагляду, підписати знову — одним
  // кроком, як `rejoinFresh`.
  {
    weight: 2,
    arbitrary: fc.record({
      t: one("releaseInFlight"),
      v: fc.constantFrom(0, 3, 4),
      org: fc.boolean(),
      at: fc.boolean(),
    }),
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
      broken: fc.boolean(),
    }),
  }
) as fc.Arbitrary<Step>

let signalId = 0
let rightsVersion = 1

const failWith = (at: string, what: string, trace: readonly string[]) => {
  throw new Error(`${at}: ${what}\n${trace.join("\n")}`)
}

// Прогін закриває ядро й таймери в будь-якому разі: інакше кожен прогін
// лишав би живе ядро з таймером, і тисячі прогонів одного `it` вичерпували б
// пам'ять процесу.
async function run(steps: readonly Step[]): Promise<void> {
  const transport = createFakeSignalTransport()
  const broken = { on: false }
  const h = setup({
    rightsSnapshot: true,
    signals: transport,
    objects: [task, org],
    // Збій читання (крок `release` з `broken`): відповідь джерела відхилено.
    adapter: (fake) => ({
      capabilities: fake.adapter.capabilities,
      read: async (items) => {
        const result = await fake.adapter.read(items)
        if (broken.on) throw new Error("network")
        return result
      },
    }),
  })
  try {
    await runOn(steps, transport, h, broken)
    // О1 над прогоном: кожен запит журналу фейка має подію з кодом і ціллю.
    const unpaired = h.reads.finish()
    if (unpaired.length > 0) throw new Error(`O1: ${unpaired.join("; ")}`)
  } finally {
    // Прогін, що впав раніше, не лишає збирача на перевірку тесту.
    h.reads.stop()
    h.core.close("disposed")
    vi.clearAllTimers()
  }
}

async function runOn(
  steps: readonly Step[],
  transport: ReturnType<typeof createFakeSignalTransport>,
  h: ReturnType<typeof setup>,
  broken: { on: boolean }
): Promise<void> {
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
  // Видимість кожного вигляду за моделлю; підписаний знову вигляд її бере.
  const visible: boolean[] = handles.map(() => true)
  // Запис відпущеного каналу (R-c) — за правдою моделі: у мить відпускання
  // підписаний вигляд показує рядок цього скоупу, тож сховище тримає рядок
  // каналу, а без відписок він там і лишається. Будь-яка відписка скидає
  // впевненість (обережно: тоді — вікно активації).
  const entrySure = ALL_CHANNELS.map(() => false)
  // Читання, затримані в мить відпускання каналу, чий план пише рядки його
  // об'єкта (об'єкт частини чи ціль `include`) — події фейкового сервера.
  // Рядок, що його показало таке читання, осівши без відписок, — теж запис
  // (§8.4, правило 2): сховище тримає рядок каналу від мити відпускання.
  const flyingAtRelease = ALL_CHANNELS.map(() => new Set<FakeRead>())
  const covers = (read: FakeRead, ch: number) => {
    const query = read.query
    if (query === undefined) return false
    const object = `${query.object.kind}.${query.object.name}`
    if (ch < ORG_FROM) return object === TASK
    return (
      object === ORG ||
      (object === TASK && "include" in query && query.include !== undefined)
    )
  }
  // Ключ організації — її скоуп; ключ задачі — за моделлю.
  const channelOfKey = (k: Key) =>
    scopeOfKey.get(k) ?? ORG_FROM + SCOPES.indexOf(k as (typeof SCOPES)[number])
  // Підписаний вигляд показує рядок каналу (сам чи як ціль `include`).
  const showsChannel = (ch: number) =>
    handles.some(
      (handle, v) =>
        offs[v] !== undefined &&
        handle
          .getSnapshot()
          .rows.some(
            (r) =>
              r.state !== "removed" &&
              (channelOfKey(r.key) === ch ||
                Object.values(r.refs ?? {}).some(
                  (ref) =>
                    ref !== null &&
                    ref.state !== "removed" &&
                    channelOfKey(ref.key) === ch
                ))
          )
    )
  const sub = (v: number) => {
    if (offs[v] !== undefined) return
    offs[v] = handles[v]!.subscribe(() => {})
    h.core.setVisible(specs[v]!, visible[v]!)
  }
  const unsub = (v: number) => {
    if (offs[v] !== undefined) {
      entrySure.fill(false)
      for (const flying of flyingAtRelease) flying.clear()
    }
    offs[v]?.()
    offs[v] = undefined
  }
  await settle()
  for (const ch of ALL_CHANNELS)
    expect(transport.subscribed().has(ch), ch).toBe(true)
  // Справжній транспорт кличе `onSubscribed` після першої підписки; перша
  // хвиля закриває вікно активації до кроків моделі.
  for (const ch of ALL_CHANNELS) transport.join(ch, false)
  await vi.advanceTimersByTimeAsync(REJOIN_JITTER_MS)
  await settle()

  // Правда сервера про доставку: канал утримується (підписаний) і «живий»
  // між `join` і `fail`.
  const held = ALL_CHANNELS.map(() => true)
  const live = ALL_CHANNELS.map(() => true)
  // Найбільша версія втраченої правки ключа; втрачені створення й видалення.
  const lost = new Map<Key, number>()
  const lostCreates = new Set<Key>()
  const lostDeletes = new Set<Key>()
  // Правки без нагляду (канал не утримується): ключ → найбільша версія.
  const unwatched = ALL_CHANNELS.map(
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
  const signal = (k: Key, op: Op, version: number, ch = channelOfKey(k)) => {
    if (!held[ch]) {
      const prior = unwatched[ch]!.get(k)
      unwatched[ch]!.set(k, {
        version: Math.max(prior?.version ?? 0, version),
        op: prior?.op === "create" && op === "update" ? "create" : op,
      })
      return
    }
    if (live[ch]) {
      transport.emit(ALL_CHANNELS[ch]!, {
        id: String(++signalId),
        object: ch < ORG_FROM ? task.id : org.id,
        op,
        keys: { id: k },
        row_ver: version,
      })
      return
    }
    loseInto(k, version, op)
  }

  // Вікно активації (§8.4, правило 4; вердикт архітекторки, умови 1–3): після
  // повторної підписки правда сервера для правок без нагляду — створень,
  // правок і видалень — не діє, доки не осяде перша хвиля підписки. Межу
  // вікна модель бере з подій фейкового транспорту й сервера та свого
  // годинника, не зі стану ядра: дві ширини джитера після `onSubscribed` без
  // затриманих читань. Після вікна старе значення без `stale` дозволене лише
  // невидимому вигляду з `needsRefresh` — видимий судиться повністю.
  // Затримані читання, на які сервер відповів рядками (крок `release` з `ok`).
  const landed = new Set<FakeRead>()
  let clock = 0
  const pending: { k: Key; version: number; op: Op; at: number }[] = []
  const actLost = new Map<Key, number>()
  const actCreates = new Set<Key>()
  const actDeletes = new Set<Key>()
  const closeWindows = () => {
    if (h.fake.mode !== "auto" || h.fake.pending.length > 0) return
    for (const p of [...pending]) {
      if (clock - p.at < 2 * REJOIN_JITTER_MS) continue
      pending.splice(pending.indexOf(p), 1)
      actLost.set(p.k, Math.max(actLost.get(p.k) ?? 0, p.version))
      if (p.op === "create") actCreates.add(p.k)
      if (p.op === "delete") actDeletes.add(p.k)
    }
  }

  // Канали, що підписка справді тримає після кроку: відпущений чи
  // підписаний знову.
  const syncHeld = () => {
    for (const [ch, channel] of ALL_CHANNELS.entries()) {
      const now = transport.subscribed().has(channel)
      // Затримане читання з мити відпускання осіло, і рядок каналу видно.
      const flying = flyingAtRelease[ch]!
      if (
        !held[ch] &&
        flying.size > 0 &&
        [...flying].every((read) => !h.fake.pending.includes(read))
      ) {
        if (landed.size > 0 && [...flying].every((r) => landed.has(r)))
          entrySure[ch] ||= showsChannel(ch)
        flying.clear()
      }
      if (held[ch] === now) continue
      held[ch] = now
      if (!now) {
        entrySure[ch] = showsChannel(ch)
        for (const read of h.fake.pending)
          if (covers(read, ch)) flying.add(read)
        continue
      }
      flying.clear()
      // З записом — приєднання після розриву (R-c): правки без нагляду
      // втрачені одразу; без запису — вікно активації до першої хвилі.
      for (const [k, u] of unwatched[ch]!)
        if (entrySure[ch]) loseInto(k, u.version, u.op)
        else pending.push({ k, version: u.version, op: u.op, at: clock })
      unwatched[ch]!.clear()
      // Справжній транспорт дає `onSubscribed` після підписки.
      live[ch] = true
      transport.join(channel, false)
    }
  }

  // Рядок вигляду й ціль його `include` судяться однаково.
  const shownOf = (snap: ViewSnapshot) =>
    snap.rows.flatMap((row) =>
      row.state === "removed"
        ? [row]
        : [
            row,
            ...Object.values(row.refs ?? {}).filter(
              (ref): ref is RowView => ref !== null
            ),
          ]
    )
  const check = (at: string) => {
    // Старе значення без `stale` після вікна активації дозволене, лише коли
    // кожен вигляд, що його показує, має `staleComposition` (§8.4, п. 7).
    const confirmedBy = new Map<Key, boolean>()
    for (const [v, handle] of handles.entries()) {
      if (offs[v] === undefined) continue
      const snap = handle.getSnapshot()
      for (const row of shownOf(snap)) {
        if (row.state === "removed" || row.hidden === true) continue
        if (snap.staleComposition !== true) confirmedBy.set(row.key, true)
      }
    }
    const excused = (k: Key) => confirmedBy.get(k) !== true
    for (const [v, handle] of handles.entries()) {
      if (offs[v] === undefined) continue
      const snap = handle.getSnapshot()
      for (const row of shownOf(snap)) {
        if (row.state === "removed" || row.hidden === true) continue
        if (row.stale === true || row.state !== "synced") continue
        const act = actLost.get(row.key)
        if (!excused(row.key) && act !== undefined && row.version < act)
          failWith(
            at,
            `view ${v} shows ${row.key} v${row.version} synced after the activation window, an unwatched edit has v${act}`,
            trace
          )
        if (!excused(row.key) && actDeletes.has(row.key))
          failWith(
            at,
            `view ${v} shows ${row.key} synced after the activation window, it was deleted unwatched`,
            trace
          )
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
      const keys = new Set(snap.rows.map((r) => r.key))
      for (const k of [...lostCreates, ...actCreates]) {
        if (keys.has(k) || deleted.has(k)) continue
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

  // Заміна знімка прав з іншим переліком скоупів: канал відпускається чи
  // підписується знову. Знімок читається поза затриманими читаннями.
  const toggleScope = async (ch: number) => {
    scopeSet[ch] = !scopeSet[ch]
    const mode = h.fake.mode
    h.fake.mode = "auto"
    h.fake.rightsSnapshot = snapshot()
    h.fake.rightsVersion = String(rightsVersion++ % 10).repeat(64)
    h.core.requestRights()
    await vi.advanceTimersByTimeAsync(0)
    await settle()
    h.fake.mode = mode
  }
  // Зняти всі вигляди, крім порожнього; вони звільняються після затримки,
  // тож сховище лишається без їхніх рядків у тому самому кроці.
  const unsubAll = async () => {
    for (const v of handles.keys())
      if (specs[v] !== FRESH && specs[v] !== ORG_OWN) unsub(v)
    await vi.advanceTimersByTimeAsync(DEFAULT_CORE_LIMITS.releaseDelayMs)
    clock += DEFAULT_CORE_LIMITS.releaseDelayMs
  }
  const createIn = (scope: number) => {
    const n = ++created
    const k = key(n)
    scopeOfKey.set(k, scope)
    const version = h.fake.insert(
      TASK,
      taskValues(n, { org: SCOPES[scope], title: "fresh" })
    )
    signal(k, "create", version)
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
      case "editOrg": {
        const version = h.fake.edit(ORG, SCOPES[s.scope]!, {})
        signal(SCOPES[s.scope]! as Key, "update", version, ORG_FROM + s.scope)
        break
      }
      case "create":
        createIn(s.scope)
        break
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
        // Крок 2 — розрив з'єднання; канали організацій — після нього.
        const ch =
          s.ch < ORG_FROM ? s.ch : s.ch === ORG_FROM ? undefined : s.ch - 1
        if (ch === undefined) live.fill(false)
        else live[ch] = false
        transport.fail({
          kind: "transport",
          channel: ch === undefined ? undefined : ALL_CHANNELS[ch],
        })
        break
      }
      case "join":
        if (held[s.ch]) live[s.ch] = true
        transport.join(ALL_CHANNELS[s.ch]!, s.recovered)
        break
      case "refreshTokens":
        for (const [ch, on] of held.entries()) if (on) live[ch] = true
        await transport.refreshTokens()
        break
      case "scopes":
        await toggleScope(s.ch)
        break
      case "rejoinFresh": {
        const mode = h.fake.mode
        h.fake.mode = "auto"
        await unsubAll()
        if (scopeSet[0]) await toggleScope(0)
        await settle()
        syncHeld()
        sub(s.v)
        await settle()
        if (s.create) createIn(0)
        else if (!deleted.has(key(1))) {
          const version = h.fake.edit(TASK, key(1), { title: `e${i}` })
          signal(key(1), "update", version)
        }
        await toggleScope(0)
        h.fake.mode = mode
        break
      }
      case "releaseInFlight": {
        const mode = h.fake.mode
        h.fake.mode = "auto"
        await unsubAll()
        if (!scopeSet[0]) await toggleScope(0)
        await settle()
        syncHeld()
        // Читання вигляду затримано; відпускання — поки воно летить.
        h.fake.mode = "manual"
        sub(s.v)
        await settle()
        await toggleScope(0)
        await settle()
        syncHeld()
        h.fake.mode = "auto"
        while (h.fake.pending.length > 0) {
          const pending = h.fake.take(0)
          pending.answer(s.at ? pending.issuedAt : undefined)
          landed.add(pending)
        }
        await settle()
        syncHeld()
        if (s.org) {
          const version = h.fake.edit(ORG, SCOPES[0], {})
          signal(SCOPES[0] as Key, "update", version, ORG_FROM)
        } else if (!deleted.has(key(1))) {
          const version = h.fake.edit(TASK, key(1), { title: `e${i}` })
          signal(key(1), "update", version)
        }
        await toggleScope(0)
        h.fake.mode = mode
        break
      }
      case "time":
        await vi.advanceTimersByTimeAsync(s.ms)
        clock += s.ms
        break
      case "revalidate":
        h.core.revalidate(TASK, { visibleOnly: true }).catch(() => {})
        break
      case "visible":
        if (offs[s.v] === undefined) break
        visible[s.v] = s.on
        h.core.setVisible(specs[s.v]!, s.on)
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
        await unsubAll()
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
        visible.push(true)
        offs.push(handle.subscribe(() => {}))
        break
      }
      case "release":
        h.fake.mode = "auto"
        broken.on = !s.ok && s.broken === true
        while (h.fake.pending.length > 0) {
          const pending = h.fake.take(0)
          if (!s.ok && !broken.on) pending.fail("command.unavailable")
          // Сервер виконав читання в мить його надходження, а не доставки.
          else pending.answer(s.at ? pending.issuedAt : undefined)
          if (s.ok) landed.add(pending)
        }
        await settle()
        broken.on = false
        break
    }
    await settle()
    syncHeld()
    await settle()
    closeWindows()
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
  for (const [ch, channel] of ALL_CHANNELS.entries()) {
    if (!held[ch]) continue
    live[ch] = true
    transport.join(channel, false)
  }
  await settle()
  for (const [v, spec] of specs.entries()) {
    visible[v] = true
    h.core.setVisible(spec, true)
  }
  await vi.advanceTimersByTimeAsync(2 * REJOIN_JITTER_MS)
  clock += 2 * REJOIN_JITTER_MS
  await settle()
  // Безпека — до перечитування живучості: вікно, яке хвиля не закрила, тут
  // видно, а не затулено читанням.
  closeWindows()
  check("before the liveness reads")
  // Межа живучості (§8.4, п. 7): видимий вигляд без читання в польоті й без
  // збою читання не тримає `staleComposition` — вимогу знімає той самий політ,
  // а не наступний інтервал. До перечитувань живучості, що її затулили б.
  if (h.fake.pending.length === 0)
    for (const [v, handle] of handles.entries()) {
      if (offs[v] === undefined || !visible[v]) continue
      const snap = handle.getSnapshot()
      // Лише вимога «склад не підтверджено з e»: склад після розриву
      // відпущеного каналу чекає читання, яке тут ніхто не обіцяє.
      const required =
        coreInternals(h.core).registry.find(specs[v]!)?.unconfirmedSince !==
        undefined
      if (required && snap.status === "ready" && snap.staleComposition === true)
        failWith(
          "before the liveness reads",
          `view ${v} keeps staleComposition with no read in flight and no failure`,
          trace
        )
    }
  await h.core.revalidate(TASK, { visibleOnly: true })
  await h.core.revalidate(ORG, { visibleOnly: true })
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
  // Після тиші жодне читання не лишається в обліку (§8.4, правило 2):
  // застряглий облік тримав би запис відпущеного каналу назавжди.
  for (const object of [TASK, ORG] as const) {
    const flying = coreInternals(h.core).pendingWrites(object)
    if (flying !== 0)
      failWith("end", `${object} keeps ${flying} reads in flight`, trace)
  }
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
// Прогін, перерваний межею часу, закриває ядро й таймери ще в своєму тесті.
afterEach(async () => {
  await settleRuns()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

// Бюджет властивості: таймаут vitest і межа fast-check — з нього одного.
const PROPERTY_BUDGET_MS = RUNS * 400 + 10_000

describe("receiver model: the disconnect mark and the composition against the server truth", () => {
  it(
    "holds the oracle over random steps",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(STEP, { maxLength: 40, size: "medium" }),
          (steps) => modelRun(run(steps))
        ),
        { numRuns: RUNS, ...interruptWithin(PROPERTY_BUDGET_MS) }
      )
    },
    PROPERTY_BUDGET_MS
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
      "D1: a read started in a gap of a held channel lands after its release (entry kept)",
      [
        { t: "hold" },
        { t: "unsubAll" },
        { t: "fail", ch: 0 },
        { t: "sub", v: 0 },
        { t: "edit", k: 0 },
        { t: "scopes", ch: 0 },
        { t: "release", ok: true, at: true },
      ],
    ],
    [
      "D2: an invisible view marked needsRefresh by the wave reads once on becoming visible",
      [
        { t: "scopes", ch: 1 },
        { t: "visible", v: 5, on: false },
        { t: "rejoinFresh", v: 0, create: true },
        { t: "scopes", ch: 0 },
        { t: "time", ms: 2000 },
      ],
    ],
    [
      "W1: a view visible at the wave with a read in flight becomes invisible before its tail",
      [
        { t: "hold" },
        { t: "revalidate" },
        { t: "rejoinFresh", v: 0, create: true },
        { t: "unsubAll" },
        { t: "time", ms: 2000 },
        { t: "visible", v: 5, on: false },
        { t: "rejoinFresh", v: 0, create: false },
        { t: "release", ok: true, at: true },
      ],
    ],
    [
      "F1: a released channel keeps its entry while a view read that will write its row is in flight",
      [
        { t: "unsub", v: 5 },
        { t: "rejoinFresh", v: 0, create: true },
        { t: "hold" },
        { t: "revalidate" },
        { t: "unsubAll" },
        { t: "mount" },
        { t: "edit", k: 0 },
        { t: "sub", v: 0 },
        { t: "unsubAll" },
        { t: "scopes", ch: 0 },
        { t: "sub", v: 5 },
        { t: "release", ok: false, at: false },
        { t: "rejoinFresh", v: 0, create: false },
      ],
    ],
    [
      "X1: a visible view whose reads fail in the activation window shows staleComposition (seed 2048969700)",
      [
        { t: "hold" },
        { t: "rejoinFresh", v: 0, create: false },
        { t: "time", ms: 60_000 },
        { t: "release", ok: false, at: false, broken: true },
      ],
    ],
    [
      "G1: a release while the answer of a read in flight is not yet written",
      [
        { t: "hold" },
        { t: "refreshTokens" },
        { t: "unsubAll" },
        { t: "releaseInFlight", v: 0, org: false, at: false },
      ],
    ],
    [
      "I1: a released channel keeps its entry while a view read that writes it as an include target is in flight",
      [
        { t: "unsubAll" },
        { t: "hold" },
        { t: "sub", v: 4 },
        { t: "scopes", ch: 0 },
        { t: "release", ok: true, at: false },
        { t: "editOrg", scope: 0 },
        { t: "scopes", ch: 0 },
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
      "an entry-less resubscribe: a row read while released, an edit unwatched",
      [
        { t: "unsubAll" },
        { t: "scopes", ch: 0 },
        { t: "sub", v: 0 },
        { t: "edit", k: 0 },
        { t: "scopes", ch: 0 },
      ],
    ],
    [
      "an entry-less resubscribe: the first wave must close the window",
      [
        { t: "unsubAll" },
        { t: "scopes", ch: 0 },
        { t: "sub", v: 0 },
        { t: "edit", k: 0 },
        { t: "scopes", ch: 0 },
        { t: "time", ms: 2 * REJOIN_JITTER_MS },
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
