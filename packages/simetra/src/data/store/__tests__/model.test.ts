import fc from "fast-check"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  ORGANIZATION_ID,
  OBJECT_ID,
  SCOPE_KIND_ID,
} from "../../../model/runtime/__tests__/entries"
import {
  CommandFailure,
  channelTopic,
  readResultFromWire,
  type CommandError,
  type ReadRows,
} from "simetra/model"
import { DataError } from "../../errors"
import {
  coreInternals,
  createCore,
  inspectCore,
  type CoreSession,
  type DefectFlag,
} from "../core"
import { compareRows, fieldInfoOf, filterCollator } from "../filter"
import { visibleRow } from "../object-store"
import { createCoreSource, createReadLimiter, type ServerPort } from "../source"
import type { Subset } from "../subsets"
import type { FakeRead, FakeReadLog } from "../testing/fake-source"
import {
  DEFAULT_CORE_LIMITS,
  type CloseReason,
  type CoreSnapshot,
  type Key,
  type MutationResult,
  type MutationState,
  type ObjectName,
  type RowView,
  type ViewHandle,
  type ViewSnapshot,
  type ViewSpec,
} from "../types"
import { ORG, S, TASK, key, keysOf, setup } from "./core-support"

/*
 * Модельний тест ядра — гейт блоку (спека П4-B §11,
 * §12). Випадкові переплетення над фейковим сервером з історією: утримання
 * виглядів, відповіді на будь-який запит у польоті в будь-якому порядку
 * (зокрема пізні — після звільнення, `purge` чи `close`), чужі правки,
 * видалення й переїзди між скоупами, зміна видимості (RLS), `purge`,
 * `revalidate`, позначки, плин часу й `close`. Після кожного кроку модель
 * перевіряє інваріанти ядра; самотест вмикає навмисні дефекти
 * (`inspectCore().defects`) і чекає червоного.
 *
 * Еталон — не друга реалізація ядра, а сервер з історією і журнал
 * доставлених відповідей: кожне показане значення мусить прийти з
 * відповіді, яку модель доставила, і дорівнювати стану сервера на мить того
 * читання; значення після `removed` чи `purge` — лише з читання, яке
 * почалось після позначки.
 */

const T = "00000000-0000-4000-8000-0000000000b2"
const SCOPES = [S, T] as const
const KEYS = [key(1), key(2), key(3), key(4), key(5)]
const [K1, K2, K3, K4, K5] = KEYS as [Key, Key, Key, Key, Key]
const ORG_KEYS = [S, T]
const TITLES = ["a", "m", "t", "z"]

// Розкид перечитування після перемикання епохи — у межах кроків `time`.
const REVALIDATE_MS = 2_000

// П7: межі моделі малі, щоб витіснення пам'яті версій і надгробків і
// межа виглядів траплялись у кожному прогоні, а не раз на тисячу.
const LIMITS = {
  seenMax: 3,
  tombstonesMax: 3,
  horizonBuckets: 16,
  viewsMax: 8,
  fullPageSize: 3,
  // Сторінка вікна у два рядки: п'ять задач дають кілька сторінок.
  windowPage: 2,
  revalidateIntervalMs: REVALIDATE_MS,
}
const RELEASE_MS = 1_000

// Епохи версій бази: `null` — репліка чи база без епохи.
const EA = "a".repeat(64)
const EB = "b".repeat(64)
const EPOCHS = [null, EA, EB] as const

const SPECS: readonly ViewSpec[] = [
  { kind: "keys", object: TASK, keys: [K1, K2] },
  { kind: "keys", object: TASK, keys: [K2, K3, K5] },
  { kind: "card", object: TASK, key: K1 },
  { kind: "card", object: TASK, key: K3 },
  { kind: "section", object: TASK, owner: K1, section: "lines" },
  {
    kind: "full",
    object: TASK,
    orderBy: [{ attribute: "title", direction: "asc" }],
    include: ["org"],
  },
  {
    kind: "full",
    object: TASK,
    where: { attribute: "title", op: "gte", value: "m" },
    orderBy: [{ attribute: "title", direction: "desc" }],
  },
  { kind: "keys", object: TASK, keys: [K4] },
  { kind: "keys", object: TASK, keys: [K1] },
  { kind: "keys", object: ORG, keys: [S, T] },
  { kind: "keys", object: ORG, keys: [S] },
  // Вікна (план B3-3, a2-Л): у порядку заголовка, що змінюють чужі правки, і
  // у порядку ключа з ціллю `include`.
  {
    kind: "window",
    object: TASK,
    orderBy: [{ attribute: "title", direction: "asc" }],
  },
  { kind: "window", object: TASK, include: ["org"] },
]
/** Вигляди прокрутки: списки й картки без `full` (він тримає все). */
const SCROLL = SPECS.flatMap((spec, v) => (spec.kind === "full" ? [] : [v]))
const WINDOWS = SPECS.flatMap((spec, v) => (spec.kind === "window" ? [v] : []))
const isList = (spec: ViewSpec) =>
  spec.kind === "keys" || spec.kind === "full" || spec.kind === "window"

const channel = (object: ObjectName, scope: string) =>
  channelTopic({
    kind: "changes",
    scopeKindId: SCOPE_KIND_ID,
    scope,
    object: object === TASK ? OBJECT_ID : ORGANIZATION_ID,
  })
const CHANNELS = [
  channel(TASK, S),
  channel(TASK, T),
  channel(ORG, S),
  channel(ORG, T),
]

type How = "ok" | "stale" | "forbidden" | "missing" | "unavailable"

/** How the model answers a held `run` (план B3-4-Л, задача 4). */
type RunHow = "ok" | "conflict" | "forbidden" | "unavailable"

type Step =
  | { t: "sub"; v: number }
  | { t: "unsub"; v: number; release: boolean }
  | { t: "churn"; v: number; scroll: boolean }
  | { t: "preload"; v: number; short: boolean }
  | { t: "slow"; v: number }
  | { t: "refresh"; v: number; showNew: boolean }
  | { t: "page"; w: number; dir: "after" | "before" }
  | { t: "visible"; v: number; on: boolean }
  | { t: "answer"; pick: number; how: How; at: number }
  | { t: "edit"; k: number; title: number }
  | { t: "delete"; k: number }
  | { t: "move"; k: number }
  | { t: "lines"; qty: number }
  | { t: "create"; scope: number }
  | { t: "access"; which: number }
  | { t: "purgeKey"; org: boolean; k: number }
  | { t: "purgeScope"; org: boolean; scope: number }
  | { t: "hide"; org: boolean; k: number }
  | {
      t: "hideSection"
      state: "mounted" | "held" | "flight"
      then: "none" | "sub" | "preload"
      evict: boolean
    }
  | { t: "revalidate"; org: boolean; visibleOnly: boolean }
  | { t: "markStale"; k: number; plus: number }
  | { t: "disconnect"; channel: number; clear: boolean }
  | { t: "markViews"; v: number; one: boolean; needs: boolean; news: boolean }
  | { t: "time"; ms: number }
  | { t: "epoch"; which: number }
  | { t: "close"; reason: CloseReason }
  | { t: "update"; k: number; lazy: boolean; base: number }
  | { t: "run"; pick: number; how: RunHow; at: number }
  | { t: "act"; k: number; act: "retry" | "cancel" | "dismiss" }
  | {
      t: "onMutation"
      pick: number
      what: "edit" | "purge" | "hide" | "remove"
    }
  | { t: "removeMut"; k: number; cancel: boolean }
  | { t: "closeInFlight" }
  | { t: "rehydrate" }

const view = fc.nat(SPECS.length - 1)
const k = fc.nat(KEYS.length - 1)
const one = <T extends Step["t"]>(t: T) => fc.constant(t)

/**
 * Ваги (бриф, крок 1): сума 299 (перегідратація — 6; перемикання епохи — 6; `hide` над
 * ТЧ-підмножиною — 6; сторінка вікна — 8; запис — 50: `update` 14, відповідь
 * `run` 20, дії мутації 8, чужа правка, `purge` чи `hide` ключа з мутацією 6,
 * `dispose()` з мутацією в дорозі 2); `purge` (16 + 14), відсутній рядок і
 * застаріла репліка — по 30, тобто по ~11 % кроків (частина кроків
 * `answer` порожня, бо в польоті нічого нема, тож серед дійових кроків
 * частка вища, близько 15 %). Самотест тримає насіння, яке знаходить
 * дефекти за кількістю прогонів: зміна генератора (ваги, профілі, масиви
 * кроків) зсуває ці числа, тож після неї самотест перевіряють заново.
 */
const STEP: fc.Arbitrary<Step> = fc.oneof(
  { weight: 24, arbitrary: fc.record({ t: one("sub"), v: view }) },
  // `release` — відписка й плин часу до звільнення одним кроком: звільнення
  // ключів (пам'ять версій, надгробки слотів `removed`) трапляється частіше.
  {
    weight: 12,
    arbitrary: fc.record({ t: one("unsub"), v: view, release: fc.boolean() }),
  },
  // Вигляд відкрили, він завантажився й закрився (прокрутка, перехід):
  // ключі проходять крізь сховище, пам'ять версій і надгробки витісняються.
  // `scroll` — те саме для всіх списків і карток підряд, як прокрутка: пам'ять
  // версій переповнюється, поки давнє читання іншого вигляду ще в польоті.
  {
    weight: 10,
    arbitrary: fc.record({ t: one("churn"), v: view, scroll: fc.boolean() }),
  },
  {
    weight: 4,
    arbitrary: fc.record({ t: one("preload"), v: view, short: fc.boolean() }),
  },
  // Повільна мережа: читання підписки доходять лише в кінці прогону.
  { weight: 4, arbitrary: fc.record({ t: one("slow"), v: view }) },
  {
    weight: 10,
    arbitrary: fc.record({ t: one("refresh"), v: view, showNew: fc.boolean() }),
  },
  // Сторінка вікна від краю: читання в польоті доходить пізніше, зокрема
  // після нового ланцюжка, `purge` чи `close`.
  {
    weight: 8,
    arbitrary: fc.record({
      t: one("page"),
      w: fc.nat(WINDOWS.length - 1),
      dir: fc.constantFrom<"after" | "before">("after", "after", "before"),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({ t: one("visible"), v: view, on: fc.boolean() }),
  },
  ...(
    [
      ["ok", 10],
      ["stale", 30],
      ["missing", 30],
      ["forbidden", 4],
      ["unavailable", 4],
    ] as const
  ).map(([how, weight]) => ({
    weight,
    arbitrary: fc.record({
      t: one("answer"),
      pick: fc.nat(7),
      how: fc.constant<How>(how),
      at: fc.nat(6),
    }),
  })),
  {
    weight: 8,
    arbitrary: fc.record({
      t: one("edit"),
      k,
      title: fc.nat(TITLES.length - 1),
    }),
  },
  { weight: 4, arbitrary: fc.record({ t: one("delete"), k }) },
  { weight: 6, arbitrary: fc.record({ t: one("move"), k }) },
  { weight: 2, arbitrary: fc.record({ t: one("lines"), qty: fc.nat(9) }) },
  { weight: 2, arbitrary: fc.record({ t: one("create"), scope: fc.nat(1) }) },
  { weight: 4, arbitrary: fc.record({ t: one("access"), which: fc.nat(2) }) },
  {
    weight: 16,
    arbitrary: fc.record({ t: one("purgeKey"), org: fc.boolean(), k }),
  },
  {
    weight: 14,
    arbitrary: fc.record({
      t: one("purgeScope"),
      org: fc.boolean(),
      scope: fc.nat(1),
    }),
  },
  // `hide` (права, план B3-3, Р11): значення ключа ховаються до читання,
  // що почалось після нього; перечитування видів-власників іде саме.
  {
    weight: 10,
    arbitrary: fc.record({ t: one("hide"), org: fc.boolean(), k }),
  },
  // `hide` власника ТЧ (K1) над ТЧ-підмножиною в заданому стані: змонтована,
  // утримувана без слухачів (`preload`, відписка до звільнення) чи з першим
  // завантаженням у польоті; далі — спостереження (монтування, `preload`) чи
  // нічого. `evict` — позначку `hide` K1 витісняють позначки інших ключів
  // (`tombstonesMax`). Випадкові кроки рідко складають ці стани самі.
  {
    weight: 6,
    arbitrary: fc.record({
      t: one("hideSection"),
      state: fc.constantFrom("mounted", "held", "flight"),
      then: fc.constantFrom("none", "sub", "preload"),
      evict: fc.boolean(),
    }),
  },
  {
    weight: 10,
    arbitrary: fc.record({
      t: one("revalidate"),
      org: fc.boolean(),
      visibleOnly: fc.boolean(),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({ t: one("markStale"), k, plus: fc.nat(1) }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      t: one("disconnect"),
      channel: fc.nat(CHANNELS.length),
      clear: fc.boolean(),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      t: one("markViews"),
      v: view,
      one: fc.boolean(),
      needs: fc.boolean(),
      news: fc.boolean(),
    }),
  },
  {
    weight: 6,
    arbitrary: fc.record({
      t: one("time"),
      ms: fc.constantFrom(500, RELEASE_MS, 5_000),
    }),
  },
  // База відповідає з іншою епохою версій: рестарт primary, PITR, репліка
  // (`null`); послідовність A, B, A — повернення покинутої.
  {
    weight: 6,
    arbitrary: fc.record({ t: one("epoch"), which: fc.nat(EPOCHS.length - 1) }),
  },
  // Запис (план B3-4-Л, задача 4): `update` з базою — підтвердженою версією,
  // серверною чи застарілою; ліниве поле перечитує картка.
  {
    weight: 14,
    arbitrary: fc.record({
      t: one("update"),
      k,
      lazy: fc.boolean(),
      base: fc.nat(2),
    }),
  },
  // Відповідь на будь-який `run` у польоті в будь-якому порядку.
  ...(
    [
      ["ok", 10],
      ["conflict", 3],
      ["forbidden", 3],
      ["unavailable", 4],
    ] as const
  ).map(([how, weight]) => ({
    weight,
    arbitrary: fc.record({
      t: one("run"),
      pick: fc.nat(3),
      how: fc.constant<RunHow>(how),
      at: fc.nat(1),
    }),
  })),
  {
    weight: 8,
    arbitrary: fc.record({
      t: one("act"),
      k,
      act: fc.constantFrom<"retry" | "cancel" | "dismiss">(
        "retry",
        "cancel",
        "dismiss"
      ),
    }),
  },
  // Чужа правка, `purge` чи `hide` саме ключа з мутацією: випадкові кроки
  // рідко влучають у нього.
  {
    weight: 6,
    arbitrary: fc.record({
      t: one("onMutation"),
      pick: fc.nat(3),
      what: fc.constantFrom<"edit" | "purge" | "hide" | "remove">(
        "edit",
        "purge",
        "hide",
        "remove"
      ),
    }),
  },
  { weight: 2, arbitrary: fc.record({ t: one("closeInFlight") }) },
  // Перегідратація (план B3-6a, задача 1): знімок ядра, нове ядро над тим
  // самим сервером, `hydrate`, `endHydration`, звірка.
  { weight: 6, arbitrary: fc.record({ t: one("rehydrate") }) },
  {
    weight: 1,
    arbitrary: fc.record({
      t: one("close"),
      reason: fc.constantFrom<CloseReason>(
        "disposed",
        "session-changed",
        "signed-out",
        "subject-changed"
      ),
    }),
  }
)

/** One read the model delivered: what it carried, by its arrival index. */
interface Delivery {
  readonly index: number
  readonly object: ObjectName
  readonly rows: ReadonlyMap<Key, number>
  /** A section read: its owner and owner version. */
  readonly owner?: { readonly key: Key; readonly version: number }
}

class ModelFailure extends Error {}

/** One attempt of a mutation as the model tracks it. */
interface ModelAttempt {
  id: string
  readonly key: Key
  /** The stored scope of the key at the start; `undefined` — no row. */
  readonly scope: string | null | undefined
  /** The core sent its `run` (a closed runtime sends nothing). */
  sent: boolean
  /** Cancelled or dismissed by the model while unsettled. */
  cancelled: boolean
  /** Unsettled at `close` or started after it: never `ok: true`. */
  mustFail: boolean
  /** The key (or its pair) was purged after the start: no row in `settled`. */
  purged: boolean
  /** What the model's server answered: `ok` or the refusal code. */
  answer?: "ok" | CommandError["code"]
  /** The version the server wrote for an `ok` answer of a live attempt. */
  runVersion?: number
  result?: MutationResult
}

/** A mutation in the journal as the model tracks it. */
interface ModelEntry {
  readonly key: Key
  attempt: ModelAttempt
  /** A purge or `removed` erased its fields (Р11): no `retry`. */
  erased: boolean
  /** The number of checks before the entry was created. */
  readonly created: number
}

/** A `run` the model's server holds. */
interface HeldRun {
  readonly request: Parameters<ServerPort["run"]>[0]
  readonly resolve: (value: unknown) => void
  readonly reject: (error: unknown) => void
  readonly attempt: ModelAttempt | undefined
}

/** The state of a mutation the refusal leaves (§7.3). */
const refusedState = (code: CommandError["code"]): MutationState =>
  code === "command.conflict"
    ? "conflict"
    : code === "command.unavailable"
      ? "unknown"
      : "failed"

/**
 * Профіль прогону. `full` — кроки як згенеровано. Інші не тримають `full`
 * (він тримає кожен рядок об'єкта, і ключі не звільняються) і роблять
 * `purge` лише одного об'єкта: `purge` робить недійсними всі завантаження
 * свого об'єкта в польоті (П12), а давнє читання іншого має дійти пізно,
 * після витіснень. `scroll` — `purge` організацій і прокрутка задач:
 * витісняється переважно пам'ять версій; `burial` — `purge` задач (кожен
 * ховає кілька ключів), прокрутку замінено звичайною підпискою, давнє
 * читання — організацій: витісняються переважно надгробки. Так горизонт
 * однієї мапи не затуляє дефекту іншої.
 */
type Profile = "full" | "scroll" | "burial"

function leanStep(s: Step, profile: Profile): Step {
  if (s.t === "churn" && profile === "burial") return { t: "sub", v: s.v }
  // У `burial` завантаження задач у польоті скасовує їхній `purge`: давнє
  // читання — організацій.
  if (s.t === "slow" && profile === "burial") return { ...s, v: 9 + (s.v % 2) }
  if (s.t === "revalidate" && profile === "burial") return { ...s, org: true }
  if (
    (s.t === "sub" || s.t === "churn" || s.t === "preload") &&
    SPECS[s.v]!.kind === "full"
  )
    return { ...s, v: s.v === 5 ? 7 : 8 }
  if (s.t === "purgeKey" || s.t === "purgeScope")
    return { ...s, org: profile === "scroll" }
  return s
}

const fail = (label: string, message: string): never => {
  throw new ModelFailure(`${label}: ${message}`)
}

/** Дає дійти всім мікрозадачам: ядро не ставить макрозадач, крім таймерів. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

const id = (object: ObjectName, k: Key) => `${object}\u0000${k}`

async function runModel(
  steps: readonly Step[],
  preloaded: boolean,
  profile: Profile,
  defects: readonly DefectFlag[] = []
) {
  // Порт запису моделі: кожен `run` тримається, доки крок `run` не відповість
  // на нього (будь-який у будь-якому порядку); сервер пише лише тоді.
  const runs: HeldRun[] = []
  let sending: ModelAttempt | undefined
  // Порушення, які модель бачить поза кроком: у слухачі чи в `settled`.
  const asyncViolations: string[] = []
  const { fake, core, log, inspect } = setup({
    limits: LIMITS,
    mode: "manual",
    server: (f) => ({
      run(request) {
        const attempt = sending
        sending = undefined
        // Кожен `run` — від `update` чи `retry` моделі: автоповтору немає.
        if (attempt === undefined)
          asyncViolations.push("a run nobody asked for")
        else attempt.sent = true
        return new Promise((resolve, reject) =>
          runs.push({ request, resolve, reject, attempt })
        )
      },
      version: () => f.server.version(),
    }),
  })
  for (const flag of defects) inspect.defects.add(flag)
  const internals = coreInternals(core)

  // Сервер: дві організації (скоупи), чотири задачі в двох скоупах, ТЧ K1.
  for (const org of ORG_KEYS) fake.insert(ORG, { ref: org })
  KEYS.slice(0, 4).forEach((k, i) =>
    fake.insert(TASK, {
      ref: k,
      org: i < 2 ? S : T,
      title: `t${i + 1}`,
      notes: `n${i + 1}`,
    })
  )
  let created = false
  const late: FakeRead[] = []
  let visibility: readonly string[] | undefined
  const deleted = new Set<string>()
  // Історія рядків ТЧ K1 у моделі: версія власника → кількості.
  const linesHistory: { at: number; qty: number[] }[] = []
  const setLines = (qty: number) => {
    const at = fake.setLines(TASK, K1, "lines", [
      { ref: key(900 + qty), qty, lineNumber: 1 },
    ])
    linesHistory.push({ at, qty: [qty] })
  }
  setLines(0)

  const handles: ViewHandle[] = SPECS.map((spec) => core.view(spec))
  const subs: ((() => void) | undefined)[] = SPECS.map(() => undefined)
  let frames = 0
  const errors: unknown[] = []

  // Журнал доставлених відповідей і бар'єри позначок.
  const deliveries = new Map<string, Delivery[]>()
  const sectionDeliveries: Delivery[] = []
  // Ключ, якого торкнувся `purge`: будь-який запис у сховищі — лише з
  // читання, що надійшло на сервер після нього (П12).
  const purgeBarrier = new Map<string, number>()
  // Власник, чиї рядки ТЧ прибрав `purge`: рядки ТЧ — лише з читання ТЧ
  // після нього (П12).
  const sectionBarrier = new Map<Key, number>()
  const barrierSections = (stepStart: number) => {
    if (objectOf(TASK).sections.get(K1, "lines") === undefined)
      sectionBarrier.set(K1, stepStart)
  }
  // Ключ, який сховав `hide`: значення — лише з читання, що почалось після
  // нього (план B3-3, Р11), а рядки ТЧ власника — лише з читання ТЧ.
  const hideBarrier = new Map<string, number>()
  // Вигляд ТЧ (SPECS[4]) утримано `preload` цього кроку: спостереження, як
  // і слухач, вимагає перечитування після `hide` власника.
  let preloadedSection = false
  // ТЧ утримується `preload` без слухачів, а `hide` власника був у польоті
  // її першого завантаження: перечитати її має кінець того польоту, тож
  // прапорець живе, доки перевірка не побачить завершеного польоту.
  let heldInFlight = false
  // Ключ, що став `removed`: значення — лише з читання після позначки (П15).
  const removedBarrier = new Map<string, number>()
  // Мить (довжина журналу запитів), коли свіжа відповідь «рядка немає»
  // позначила вже `removed` слот наново: значення — лише з читання, що
  // почалось після неї (П15). Відповідь, яку ядро відкинуло (покоління,
  // надгробок), позначки не дає, а пачка `revalidate` пише відповіді лише
  // після всіх читань, тож момент знає лише ядро.
  const remarkedAt = new Map<string, number>()
  inspect.watchRemarks((object, k) => {
    remarkedAt.set(id(object, k), fake.log.length)
  })
  // Цілі, які `purge` справді прибрав: `purged` картки чи ТЧ допустимий лише
  // для них (інакше `purge` хибно позначив би чужі вигляди; П12).
  const purgedTargets = new Set<string>()
  // `slot` — запис сховища: слот, що зник і з'явився знову між двома
  // перевірками, — вже інший слот, і його не порівнюємо з тим, що був.
  const wasRemoved = new Map<string, { divergent: boolean; slot: object }>()
  const maxVersion = new Map<string, number>()
  const storeVersion = new Map<string, number>()
  // Версії порівнюються в межах однієї епохи: до першого перемикання
  // `null` і перша епоха — одна історія, після нього — кожна епоха окремо.
  const versionKey = (object: ObjectName, k: Key) => {
    const e = objectOf(object).rows.get(k)
    return inspect.versionEpochs().previous === null || e === undefined
      ? id(object, k)
      : `${id(object, k)}\u0000${String(e.versionEpoch)}`
  }
  let closed:
    { frames: number; sent: number; snapshot: ViewSnapshot } | undefined

  const record = (read: FakeRead) => {
    const response = read.log.response
    if (response === undefined || read.query === undefined) return
    const index = fake.log.indexOf(read.log)
    const result = readResultFromWire(
      fake.index,
      read.query,
      response
    ) as ReadRows
    const object = read.object!
    if ("tabularSection" in read.query) {
      if (result.ownerVersion === undefined || !("owner" in read.query)) return
      sectionDeliveries.push({
        index,
        object,
        rows: new Map(),
        owner: { key: read.query.owner, version: result.ownerVersion },
      })
      return
    }
    const rows = new Map<Key, number>()
    for (const row of result.rows)
      rows.set(row.ref as Key, row.version as number)
    for (const [k, version] of rows) {
      const list = deliveries.get(id(object, k)) ?? []
      list.push({ index, object, rows: new Map([[k, version]]) })
      deliveries.set(id(object, k), list)
    }
  }

  const deliveredSince = (object: ObjectName, k: Key, index: number) =>
    (deliveries.get(id(object, k)) ?? []).some((d) => d.index >= index)
  const deliveredVersion = (object: ObjectName, k: Key, version: number) =>
    (deliveries.get(id(object, k)) ?? []).some((d) => d.rows.get(k) === version)

  const subscribe = (v: number, label: string) => {
    if (subs[v] !== undefined) return
    const held = [...internals.registry.subsets()]
    const spare = held.some((s) => s.listeners.size === 0)
    try {
      subs[v] = handles[v]!.subscribe(() => {
        frames++
        checkFrame(v)
      })
    } catch (error) {
      if (!(error instanceof DataError) || error.code !== "data.views-limit")
        throw error
      // Межа виглядів (П16): відмова лише тоді, коли звільнити нічого.
      const known = held.some((s) => s.form.spec === SPECS[v])
      if (known || held.length < LIMITS.viewsMax || spare)
        fail(label, `views-limit with ${held.length} held, spare ${spare}`)
    }
  }

  /** `preload` вигляду; відмова — лише за межею без вільного утримання (П16). */
  const preload = (v: number, short: boolean, label: string) => {
    let promise: Promise<void> | undefined
    try {
      promise = core.preload(SPECS[v]!, short ? { ttlMs: 500 } : undefined)
    } catch (error) {
      if (!(error instanceof DataError) || error.code !== "data.views-limit")
        throw error
      const held = [...internals.registry.subsets()]
      if (
        held.length < LIMITS.viewsMax ||
        held.some((x) => x.listeners.size === 0)
      )
        fail(label, "preload refused with a spare hold")
    }
    promise?.catch((error: unknown) => errors.push(error))
    if (promise !== undefined && v === 4) preloadedSection = true
  }

  /** Склад видимих списків і покоління їхніх завантажень. */
  const lists = () =>
    SPECS.map((spec, v) => {
      if (subs[v] === undefined || !isList(spec) || closed !== undefined)
        return undefined
      const s = internals.registry.find(spec)
      return {
        keys: handles[v]!.getSnapshot().rows.map((r) => r.key),
        flight: s?.flight,
        gen: s?.gen,
        subset: s,
        // Сторінки вікна в польоті: вони виправдовують ріст складу.
        paging: s === undefined ? 0 : s.paging.size,
      }
    })

  const objectOf = (name: ObjectName) => internals.objects.get(name)!

  /** Показаний рядок (зі значеннями чи схований) проти сервера й позначок. */
  const checkRow = (
    label: string,
    object: ObjectName,
    row: RowView,
    where: string
  ) => {
    const at = `${where} ${object}/${row.key}`
    if (row.state === "removed") return
    const max = maxVersion.get(versionKey(object, row.key)) ?? 0
    const fields = Object.keys(row.values)
    // Старі значення ніколи не показано мовчки — два інваріанти (рішення
    // архітекторки, розвилка оракула 2): (1) рядок, що показує значення
    // версії, нижчої за відому, несе факт `stale` за будь-якого стану (стан
    // мутації затуляє показ `stale`, §6.5, але не факт); (2) схований рядок
    // значень не показує зовсім — горизонт ховає й рядок, нижчу версію якого
    // витіснена пам'ять уже не знає.
    if (row.version < max && fields.length > 0 && row.stale !== true)
      fail(label, `${at}: version ${max} → ${row.version} as ${row.state}`)
    maxVersion.set(versionKey(object, row.key), Math.max(max, row.version))
    // Факт `stale` покриває кожну позначку застарілості збереженого рядка —
    // нижчу версію, зміну епохи, розрив сигналів — за будь-якого стану
    // мутації (§6.5); `hide` — окремий факт `hidden`.
    const marks = objectOf(object).rows.get(row.key)?.stale
    if (
      marks !== undefined &&
      (marks.minVersion !== undefined ||
        marks.epoch !== undefined ||
        marks.disconnect !== undefined) &&
      row.stale !== true
    )
      fail(label, `${at}: a stale mark not shown as stale (${row.state})`)
    if (row.hidden === true && fields.length > 0)
      fail(label, `${at}: hidden with values`)
    if (fields.length === 0) return
    const hidden = hideBarrier.get(id(object, row.key))
    if (hidden !== undefined && !deliveredSince(object, row.key, hidden))
      fail(label, `${at}: shown after hide without a later read`)
    // Показаний рядок (і ціль `refs`) прибраного `purge` ключа — лише з
    // читання, що почалось після нього (П12).
    const purged = purgeBarrier.get(id(object, row.key))
    if (purged !== undefined && !deliveredSince(object, row.key, purged))
      fail(label, `${at}: shown after purge without a later read`)
    // Версія — з доставленого читання або з відповіді `run` живої спроби;
    // бар'єри (`hide`, `purge`, `removed`) знімає лише читання: write-back
    // позначок не знімає й прибраного не воскрешає (Р3, Р7, Р11).
    if (
      !deliveredVersion(object, row.key, row.version) &&
      !runDelivered.has(`${id(object, row.key)}\u0000${row.version}`)
    )
      fail(label, `${at}: version ${row.version} never delivered`)
    const server = fake.row(object, row.key, row.version)
    if (server === undefined || server.version !== row.version)
      fail(label, `${at}: no server row of version ${row.version}`)
    for (const field of fields) {
      if (field === "notes" && row.staleFields.includes(field)) continue
      if (!Object.is(row.values[field], server!.values[field]))
        fail(
          label,
          `${at}.${field} = ${String(row.values[field])}, server at ${row.version}: ${String(server!.values[field])}`
        )
    }
    const barrier = removedBarrier.get(id(object, row.key))
    if (barrier !== undefined && !deliveredSince(object, row.key, barrier))
      fail(label, `${at}: shown after removed without a later read`)
  }

  const checkSnapshot = (label: string, v: number, snap: ViewSnapshot) => {
    const spec = SPECS[v]!
    const where = `view ${v}`
    for (const row of snap.rows) {
      checkRow(label, spec.object, row, where)
      if (row.state === "removed" || row.refs === undefined) continue
      for (const ref of Object.values(row.refs)) {
        if (ref !== null) checkRow(label, ORG, ref, `${where} ref`)
      }
    }
    if (snap.status === "purged") {
      // `purged` вигляду (після `purge`, не `close`) — лише для картки чи ТЧ
      // ключа, який `purge` справді прибрав.
      const target =
        spec.kind === "card"
          ? spec.key
          : spec.kind === "section"
            ? spec.owner
            : undefined
      if (target === undefined || !purgedTargets.has(id(spec.object, target)))
        fail(label, `${where}: purged without a purge of its key`)
    }
    if (spec.kind === "card") {
      // Картка ключа зі сховища не дає знімка без рядка.
      const stored = objectOf(TASK).rows.get(spec.key) !== undefined
      if (stored && snap.status !== "purged" && snap.rows.length !== 1)
        fail(label, `${where}: card of a stored key without its row`)
    }
    if (spec.kind === "section" && snap.section !== undefined) {
      const owner = spec.owner
      const { ownerVersion, ownerState, lines } = snap.section
      // Без версії власника рядків ТЧ нема; власник `removed` чи схований —
      // без версії й рядків (§6.2, правило 5).
      if (ownerVersion === undefined && lines.length > 0)
        fail(label, `${where}: lines without an owner version`)
      const stored = objectOf(TASK).rows.get(owner)
      if (stored?.removed !== undefined && ownerState !== "removed")
        fail(label, `${where}: owner state ${ownerState}, slot removed`)
      if (
        ownerState === "removed" &&
        (ownerVersion !== undefined || lines.length > 0)
      )
        fail(label, `${where}: a removed owner shows ${lines.length} lines`)
    }
    if (spec.kind === "section" && snap.section?.ownerVersion !== undefined) {
      const version = snap.section.ownerVersion
      const owner = spec.owner
      const ok = sectionDeliveries.some(
        (d) => d.owner!.key === owner && d.owner!.version === version
      )
      if (!ok) fail(label, `${where}: owner version ${version} never read`)
      const header = objectOf(TASK).rows.get(owner)
      // Схований власник не показує й рядків ТЧ (інваріант (2)).
      if (header?.stale.hidden !== undefined && snap.section.lines.length > 0)
        fail(label, `${where}: lines of a hidden owner`)
      // ТЧ власника `removed` показує причину без рядків (§6.2, правило 5).
      if (header?.removed !== undefined)
        fail(label, `${where}: lines of a removed owner`)
      const readSince = (index: number) =>
        sectionDeliveries.some(
          (d) => d.owner!.key === owner && d.index >= index
        )
      const purged = sectionBarrier.get(owner)
      if (purged !== undefined && !readSince(purged))
        fail(label, `${where}: lines shown after purge`)
      // `hide` прибирає рядки ТЧ власника: їх повертає лише читання ТЧ після нього.
      const hidden = hideBarrier.get(id(TASK, owner))
      if (
        hidden !== undefined &&
        !readSince(hidden) &&
        snap.section.lines.length > 0
      )
        fail(label, `${where}: lines shown after hide without a later read`)
      // Після `removed` рядки повертає читання після позначки — ТЧ чи шапки,
      // що зняла `removed`.
      const removed = removedBarrier.get(id(TASK, owner))
      if (
        removed !== undefined &&
        !readSince(removed) &&
        !deliveredSince(TASK, owner, removed)
      )
        fail(label, `${where}: lines shown after removed`)
      const expected = linesHistory.filter((h) => h.at <= version).at(-1)!.qty
      const shown = snap.section.lines.map((l) => l.values.qty)
      if (JSON.stringify(shown) !== JSON.stringify(expected))
        fail(label, `${where}: lines ${String(shown)} ≠ ${String(expected)}`)
    }
  }

  const check = (label: string, stepStart: number) => {
    if (errors.length > 0)
      fail(label, `unexpected rejection ${String(errors[0])}`)
    if (closed !== undefined) {
      // Після `close` — жодного сповіщення, запиту й рядка; кожен хендл
      // (і новий) — та сама посилка `purged`.
      if (frames !== closed.frames) fail(label, "notified after close")
      if (fake.log.length !== closed.sent) fail(label, "requested after close")
      if (inspect.rowCount() !== 0) fail(label, "rows after close")
      for (const spec of SPECS) {
        if (core.view(spec).getSnapshot() !== closed.snapshot)
          fail(label, "a handle after close is not the purged snapshot")
      }
      for (const handle of handles) {
        if (handle.getSnapshot() !== closed.snapshot)
          fail(label, "a handle after close is not the purged snapshot")
      }
      // `close()` чистить усі службові мапи, таймери й контролери.
      for (const [name, size] of Object.entries(inspect.serviceSizes())) {
        if (size !== 0) fail(label, `${name} = ${size} after close`)
      }
      // Після `dispose()` кожна мутація осіла, і жодна — успіхом.
      if (asyncViolations.length > 0) fail(label, asyncViolations[0]!)
      if (attempts.some((a) => a.result === undefined))
        fail(label, "a mutation unsettled after close")
      return
    }
    if (asyncViolations.length > 0) fail(label, asyncViolations[0]!)
    const violations = inspect.violations()
    if (violations.length > 0) fail(label, violations.join("; "))
    // Межі §6.2: читання, пам'ять версій, надгробки й горизонт.
    if (fake.inFlight > 4) fail(label, `${fake.inFlight} reads in flight`)
    const sizes = inspect.serviceSizes()
    if (sizes.seen > LIMITS.seenMax)
      fail(label, `seen ${sizes.seen} > ${LIMITS.seenMax}`)
    if (sizes.tombstones > LIMITS.tombstonesMax)
      fail(label, `tombstones ${sizes.tombstones} > ${LIMITS.tombstonesMax}`)
    if (sizes.hidden > LIMITS.tombstonesMax)
      fail(label, `hidden marks ${sizes.hidden} > ${LIMITS.tombstonesMax}`)
    // Останнє поховання пари — по одному на об'єкт.
    if (sizes.pairBurials > 2)
      fail(label, `pair burials ${sizes.pairBurials} > 2 objects`)

    for (const name of [TASK, ORG]) {
      const o = objectOf(name)
      for (const k of o.rows.keys()) {
        const e = o.rows.get(k)!
        const at = `${name}/${k}`
        // Версія не зменшується на жодному шляху запису: старший рядок —
        // лише з позначкою мінімальної версії чи схований горизонтом.
        const top = storeVersion.get(versionKey(name, k)) ?? 0
        // Рядок не поточної епохи з позначкою перемикання — `null`-відповідь
        // після перемикання: її версії не впорядковані ні з якою епохою,
        // і рядок не показано підтвердженим.
        const unordered =
          e.stale.epoch !== undefined &&
          e.versionEpoch !== inspect.versionEpochs().current
        if (
          e.version < top &&
          (e.stale.minVersion?.v ?? -1) < top &&
          e.stale.hidden === undefined &&
          !unordered
        )
          fail(label, `${at}: stored version ${top} → ${e.version}`)
        storeVersion.set(versionKey(name, k), Math.max(top, e.version))
        const purge = purgeBarrier.get(id(name, k))
        if (purge !== undefined && !deliveredSince(name, k, purge))
          fail(label, `${at}: in the store after purge without a later read`)
        const before = wasRemoved.get(id(name, k))
        // Власник `removed` не лишає рядків ТЧ у сховищі (§6.2, правило 5).
        if (
          name === TASK &&
          e.removed !== undefined &&
          objectOf(TASK).sections.get(k, "lines") !== undefined
        )
          fail(label, `${at}: section lines stored for a removed owner`)
        if (e.removed !== undefined) {
          if (before === undefined) {
            removedBarrier.set(id(name, k), stepStart)
            // Перехід у `removed` стирає поля мутації ключа (Р11), що вже
            // була в журналі до кроку.
            const entry = name === TASK ? journal.get(k) : undefined
            if (entry !== undefined && entry.created < checks)
              entry.erased = true
          }
          wasRemoved.set(id(name, k), {
            divergent: e.removed.divergent,
            slot: e,
          })
          continue
        }
        if (before !== undefined && visibleRow(e) !== undefined) {
          // Єдиний перехід «сховано → показано» без читання користувача —
          // розбіжний слот, і він пише `removed-restored` (П15).
          if (before.divergent && before.slot === e) {
            const n = (restoredInStep.get(name) ?? 0) + 1
            restoredInStep.set(name, n)
            const logged = log
              .slice(logAt)
              .reduce(
                (sum, x) =>
                  x.kind === "removed-restored" && x.object === name
                    ? sum + x.count
                    : sum,
                0
              )
            // Журнал рахує перехід на кожен ключ: розбіжних слотів, що
            // ожили за крок, не більше, ніж записів у журналі.
            if (logged < n)
              fail(
                label,
                `${at}: divergent slot restored, log counts ${logged}`
              )
          }
        }
        wasRemoved.delete(id(name, k))
        const values = visibleRow(e)
        if (values !== undefined) {
          const hidden = hideBarrier.get(id(name, k))
          if (hidden !== undefined && !deliveredSince(name, k, hidden))
            fail(label, `${at}: values after hide without a later read`)
          const barrier = removedBarrier.get(id(name, k))
          if (barrier !== undefined && !deliveredSince(name, k, barrier))
            fail(label, `${at}: values after removed without a later read`)
        }
      }
      // Слот, що зник зі сховища, лишає бар'єр; позначку стану — ні.
      for (const key of [...wasRemoved.keys()]) {
        const [object, k] = key.split("\u0000") as [ObjectName, Key]
        if (object === name && o.rows.get(k) === undefined)
          wasRemoved.delete(key)
      }
    }

    for (const [key, at] of remarkedAt) {
      const barrier = removedBarrier.get(key)
      if (barrier !== undefined) removedBarrier.set(key, Math.max(barrier, at))
    }
    remarkedAt.clear()

    handles.forEach((handle, v) => {
      checkSnapshot(label, v, handle.getSnapshot())
    })
    checkMutations(label)
    checkSectionReread(label)
    checkWindows(label)
  }

  /**
   * Вікно (план B3-3, Р8, Р9): знімок несе ланцюжок вікна, а ланцюжок не
   * спадає — він змінюється лише разом із новим складом; склад і сторінки
   * (ключі без значень) тримає `violations`.
   */
  const chains = new WeakMap<Subset, number>()
  const checkWindows = (label: string) => {
    for (const v of WINDOWS) {
      if (subs[v] === undefined) continue
      const s = internals.registry.find(SPECS[v]!)
      if (s?.window === undefined) continue
      const snap = handles[v]!.getSnapshot()
      if (snap.chain !== s.window.chain)
        fail(label, `view ${v}: snapshot chain ${String(snap.chain)}`)
      const last = chains.get(s) ?? 0
      if (s.window.chain < last)
        fail(label, `view ${v}: chain ${last} → ${s.window.chain}`)
      chains.set(s, s.window.chain)
    }
  }

  /**
   * ТЧ-підмножина, яку спостерігають (слухач чи `preload` кроку) після
   * `hide` власника, перечитана (план B3-3, Р11, рішення архітекторки до
   * задачі 0): є читання ТЧ власника, надіслане після `hide`, або
   * завантаження вигляду в польоті — після нього перевірка повториться.
   * Стан підмножини на мить `hide` будь-який: змонтована, утримувана без
   * слухачів, перше завантаження в польоті, шапка в сховищі чи ні.
   */
  const checkSectionReread = (label: string) => {
    const spec = SPECS[4]!
    if (spec.kind !== "section") return
    if (subs[4] === undefined && !preloadedSection && !heldInFlight) return
    const barrier = hideBarrier.get(id(TASK, spec.owner))
    if (barrier === undefined) return
    const s = internals.registry.find(spec)
    if (s === undefined || s.purged) {
      heldInFlight = false
      return
    }
    if (s.flight !== undefined) return
    heldInFlight = false
    // Сесія після межі відкинутих відповідей не читає (Р12); власник
    // `removed` рядків не показує, і читання ТЧ їх не поверне.
    if (inspect.versionEpochs().unavailable) return
    const header = objectOf(TASK).rows.get(spec.owner)
    if (header?.removed !== undefined) return
    // Шапку сховано горизонтом, а не `hide` (`hiddenAt` немає): позначку
    // `hide` ключа витіснило до вставки шапки, і ядро не відрізнить її від
    // горизонту — ТЧ іде за перечитуванням шапки хвостом (Р36). Безпеку
    // (рядки ТЧ лише з читання після `hide`) перевіряє `checkSnapshot`.
    if (header?.stale.hidden !== undefined && header.hiddenAt === undefined)
      return
    const reread = fake.log
      .slice(barrier)
      .some(
        (r) =>
          r.query !== undefined &&
          "tabularSection" in r.query &&
          "owner" in r.query &&
          r.query.owner === spec.owner
      )
    if (!reread) fail(label, `section of ${spec.owner} not re-read after hide`)
  }

  /** `purge` прибирає ключі зі складу списків, а картка й ТЧ ключа — `purged`. */
  const checkPurged = (
    label: string,
    purged: { object: ObjectName; keys: Key[] }
  ) => {
    if (closed !== undefined) return
    const gone = new Set<Key>(purged.keys)
    SPECS.forEach((spec, v) => {
      if (subs[v] === undefined) return
      const snap = handles[v]!.getSnapshot()
      const where = `view ${v} after purge`
      if (spec.object === purged.object && isList(spec)) {
        for (const row of snap.rows) {
          if (gone.has(row.key))
            fail(label, `${where}: purged ${row.key} still in the composition`)
        }
      }
      for (const row of snap.rows) {
        if (row.state === "removed" || row.refs === undefined) continue
        for (const ref of Object.values(row.refs)) {
          if (ref !== null && purged.object === ORG && gone.has(ref.key))
            fail(label, `${where}: ref to purged ${ref.key}`)
        }
      }
      const target =
        spec.kind === "card"
          ? spec.key
          : spec.kind === "section"
            ? spec.owner
            : undefined
      if (
        target !== undefined &&
        spec.object === purged.object &&
        gone.has(target) &&
        snap.status !== "purged"
      )
        fail(
          label,
          `${where}: ${spec.kind} of purged ${target} is ${snap.status}`
        )
    })
  }

  let logAt = 0
  const restoredInStep = new Map<ObjectName, number>()

  // ── Запис (план B3-4-Л, задача 4) ──
  // Журнал моделі: мутація ключа, доки її не прибрав успіх, дія чи `close`.
  const journal = new Map<Key, ModelEntry>()
  const attempts: ModelAttempt[] = []
  const attemptById = new Map<string, ModelAttempt>()
  // Версії, які принесла відповідь `run` живої спроби: джерело показаного
  // рядка поряд із читаннями, але не зняття бар'єрів.
  const runDelivered = new Set<string>()
  let checks = 0
  // Епоха primary, на який іде `run`.
  let primaryEpoch = EA

  /** Starts tracking an attempt; `sending` links it to the `run` it sends. */
  const begin = (key: Key) => {
    const attempt: ModelAttempt = {
      id: "",
      key,
      scope: objectOf(TASK).rows.get(key)?.scope,
      sent: false,
      cancelled: false,
      mustFail: closed !== undefined,
      purged: false,
    }
    sending = attempt
    return attempt
  }

  /** Records the mutation a call returned and watches its `settled`. */
  const track = (
    attempt: ModelAttempt,
    mutation: { id: string; settled: Promise<MutationResult> }
  ) => {
    sending = undefined
    attempt.id = mutation.id
    attempts.push(attempt)
    attemptById.set(mutation.id, attempt)
    if (closed !== undefined && attempt.sent)
      asyncViolations.push(`${mutation.id}: sent after close`)
    void mutation.settled.then((result) => settled(attempt, result))
  }

  const settled = (attempt: ModelAttempt, result: MutationResult) => {
    attempt.result = result
    const at = `${attempt.key} ${attempt.id}`
    if (result.ok && attempt.mustFail)
      asyncViolations.push(`${at}: settled ok after close`)
    // Скасована спроба нічого не пише й рядків не віддає (Р9).
    if (
      result.ok &&
      attempt.cancelled &&
      result.rows.some((r) => r !== undefined)
    )
      asyncViolations.push(`${at}: a cancelled attempt settled with a row`)
    if (result.ok && attempt.purged && result.rows[0] !== undefined)
      asyncViolations.push(
        `${at}: settled with a row of a key purged in flight`
      )
    if (!attempt.mustFail && !attempt.cancelled) {
      // Результат — той, що дав сервер моделі, без автоповтору й підміни.
      const answer = result.ok ? "ok" : result.error.code
      if (attempt.answer !== answer)
        asyncViolations.push(
          `${at}: settled ${answer}, the server answered ${String(attempt.answer)}`
        )
    }
    if (result.ok && result.rows[0] !== undefined) {
      const row = result.rows[0]
      const server = fake.row(TASK, attempt.key, row.version)
      for (const [field, value] of Object.entries(row.values)) {
        if (!Object.is(server?.values[field], value))
          asyncViolations.push(
            `${at}: settled ${field} ≠ server at ${row.version}`
          )
      }
    }
    // Успіх прибирає мутацію з журналу; відмова лишає її (§6.5).
    const entry = journal.get(attempt.key)
    if (result.ok && entry?.attempt === attempt) journal.delete(attempt.key)
  }

  /** The row views of a task key in the subscribed views. */
  const rowsOf = (k: Key) =>
    SPECS.flatMap((spec, v) => {
      if (subs[v] === undefined || spec.object !== TASK) return []
      return handles[v]!.getSnapshot().rows.filter((r) => r.key === k)
    })

  /**
   * Кадр слухача (§7.2, крок 3): рядок, версію якого приніс лише `run` його
   * мутації, показаний без стану `pending` — запис і зняття мутації одним
   * `commit`.
   */
  const checkFrame = (v: number) => {
    if (closed !== undefined || SPECS[v]!.object !== TASK) return
    for (const row of handles[v]!.getSnapshot().rows) {
      if (row.state === "removed" || row.mutation?.state !== "pending") continue
      const attempt = attemptById.get(row.mutation.id)
      if (
        // Версія саме цієї спроби: рядок, підтверджений попередньою, з
        // новою мутацією `pending` — звичайний стан.
        attempt?.runVersion === row.version &&
        !deliveredVersion(TASK, row.key, row.version)
      )
        asyncViolations.push(
          `view ${v} ${row.key}: the run row shown with its mutation pending`
        )
    }
  }

  /**
   * Журнал ядра проти моделі: відмова не прибирає мутації мовчки, межа
   * журналу (мутації плюс неосілі спроби — ні більше, ні менше), стан і дії в
   * рядку, стерті поля після `purge` чи `removed` (Р5, Р7, Р11).
   */
  const checkMutations = (label: string) => {
    const unsettled = attempts.filter((a) => a.result === undefined).length
    const size = inspect.serviceSizes().journal
    if (size !== journal.size + unsettled)
      fail(
        label,
        `journal ${size}, model ${journal.size} + ${unsettled} unsettled`
      )
    const inCore = new Map(inspect.mutations().map((m) => [m.key, m]))
    for (const m of inCore.values()) {
      if (!journal.has(m.key))
        fail(label, `${m.key}: mutation ${m.id} not in the model`)
    }
    for (const [k, entry] of journal) {
      const m = inCore.get(k)
      const { attempt } = entry
      if (m === undefined || m.id !== attempt.id)
        fail(label, `${k}: mutation ${attempt.id} left the journal silently`)
      const state =
        attempt.result === undefined
          ? "pending"
          : attempt.result.ok
            ? undefined
            : refusedState(attempt.result.error.code)
      if (m!.state !== state)
        fail(label, `${k}: mutation ${m!.state}, model ${String(state)}`)
      if (entry.erased && !m!.erased)
        fail(label, `${k}: the journal keeps values after purge or removed`)
      for (const row of rowsOf(k)) {
        const shown = row.mutation
        if (shown?.id !== m!.id || shown.state !== m!.state)
          fail(
            label,
            `${k}: row shows mutation ${String(shown?.id)} ${String(shown?.state)}`
          )
        // `hidden` і `removed` мають пріоритет показу над станом мутації (Р7);
        // інакше рядок показує стан мутації — за `await` з підтвердженими
        // значеннями (`checkRow`).
        if (
          row.state !== "removed" &&
          row.hidden !== true &&
          row.state !== m!.state
        )
          fail(label, `${k}: row ${row.state}, mutation ${m!.state}`)
        if (entry.erased && shown!.retry !== undefined)
          fail(label, `${k}: retry offered after the fields were erased`)
        // Дії за станом (Р5): `retry` — лише `failed`, `dismiss` — лише
        // `unknown`, `pending` без `removed` дій не має.
        if (shown!.retry !== undefined && m!.state !== "failed")
          fail(label, `${k}: retry offered on ${m!.state}`)
        if ((shown!.dismiss !== undefined) !== (m!.state === "unknown"))
          fail(label, `${k}: dismiss on ${m!.state}`)
        if (
          m!.state === "pending" &&
          row.state !== "removed" &&
          shown!.cancel !== undefined
        )
          fail(label, `${k}: cancel offered on a pending row`)
        if (m!.state === "conflict" && shown!.cancel === undefined)
          fail(label, `${k}: conflict without cancel`)
      }
    }
    checks++
  }

  /** Answers a held `run`: the server writes only for `ok` (and committed `unavailable`). */
  const answerRun = (held: HeldRun, how: RunHow, at: number) => {
    const { attempt } = held
    const k = attempt?.key
    const refuse = (error: CommandError) => {
      if (attempt !== undefined) attempt.answer = error.code
      held.reject(new CommandFailure(error))
    }
    if (k === undefined || !live(TASK, k)) {
      refuse({ code: "command.forbidden" })
      return
    }
    if (how === "conflict") {
      refuse({
        code: "command.conflict",
        reason: "version",
        currentVersion: fake.row(TASK, k)!.version,
      })
      return
    }
    if (how === "forbidden") {
      refuse({ code: "command.forbidden" })
      return
    }
    // `unavailable` — обрив після `COMMIT` (через раз) чи до нього.
    if (how === "unavailable" && at === 0) {
      refuse({ code: "command.unavailable" })
      return
    }
    fake.server.run(held.request).then(
      (value) => {
        if (how === "unavailable") {
          refuse({ code: "command.unavailable" })
          return
        }
        attempt!.answer = "ok"
        // `run` іде на primary, і його епоха не `null` (§7.2 п. 3): `null`
        // моделі — репліка читання чи база до першого перемикання.
        const raw = value as Record<string, unknown>
        if (raw.epoch === null) value = { ...raw, epoch: primaryEpoch }
        // Відповідь скасованої спроби чи після `close` показати не можна.
        if (!attempt!.cancelled && closed === undefined) {
          attempt!.runVersion = fake.row(TASK, k)!.version
          runDelivered.add(`${id(TASK, k)}\u0000${attempt!.runVersion}`)
        }
        held.resolve(value)
      },
      (error: unknown) => {
        // Звірка версії сервера: `conflict` з поточною версією.
        if (error instanceof CommandFailure) attempt!.answer = error.error.code
        held.reject(error)
      }
    )
  }

  /** Drops the model entry by a user action; an unsettled attempt is cancelled. */
  const dropEntry = (entry: ModelEntry) => {
    journal.delete(entry.key)
    if (entry.attempt.result === undefined) entry.attempt.cancelled = true
  }

  /**
   * Кроки над ключем з мутацією — чужа правка, `purge` чи `hide` того ключа,
   * `dispose()` з `run` у дорозі; без мутації — над випадковим ключем.
   */
  const onMutation = (step: Step): Step => {
    if (step.t === "closeInFlight")
      return runs.length > 0
        ? { t: "close", reason: "disposed" }
        : { t: "time", ms: 500 }
    if (step.t !== "onMutation") return step
    const keys = [...journal.keys()]
    const at =
      keys.length === 0
        ? step.pick % KEYS.length
        : KEYS.indexOf(keys[step.pick % keys.length]!)
    if (step.what === "edit")
      return { t: "edit", k: at, title: step.pick % TITLES.length }
    if (step.what === "purge") return { t: "purgeKey", org: false, k: at }
    if (step.what === "remove")
      return { t: "removeMut", k: at, cancel: step.pick % 2 === 0 }
    return { t: "hide", org: false, k: at }
  }

  const lean = profile !== "full"
  const plan = lean ? steps.map((s) => leanStep(s, profile)) : steps

  if (preloaded) {
    // Половина прогонів стартує з даними: список і `full` (чи другий список)
    // завантажені.
    const second = lean ? 9 : 5
    subs[0] = handles[0]!.subscribe(() => {
      frames++
      checkFrame(0)
    })
    subs[second] = handles[second]!.subscribe(() => {
      frames++
      checkFrame(second)
    })
    for (let i = 0; i < 50 && fake.pending.length > 0; i++) {
      await flush()
      while (fake.pending.length > 0) {
        const read = fake.take()
        read.answer()
        record(read)
      }
      await flush()
    }
    check("preload", 0)
  }

  // Покоління завантажень, які почала дія користувача (підписка, прокрутка,
  // `refresh`, `showNew`, `preload`, початкове завантаження), і чи належить
  // користувачу наступне завантаження з черги «trailing». Правило
  // стабільності виправдовує зміну складу лише завантаженням користувача.
  const userGens = new Map<Subset, Set<number>>()
  const lastGen = new Map<Subset, number>()
  const userNext = new Set<Subset>()
  const noteGens = (userStep: boolean) => {
    for (const s of internals.registry.subsets()) {
      const gens = userGens.get(s) ?? new Set<number>()
      const mine =
        userStep ||
        userNext.has(s) ||
        (s.flight !== undefined && gens.has(s.flight))
      const last = lastGen.get(s) ?? 0
      if (s.gen > last) {
        // Покоління, яке `purge` підняв у польоті, лишається завантаженням
        // користувача, чиє читання він перезапускає.
        if (mine) for (let g = last + 1; g <= s.gen; g++) gens.add(g)
        userGens.set(s, gens)
        lastGen.set(s, s.gen)
      }
      if (s.trailing && mine) userNext.add(s)
      else if (!s.trailing) userNext.delete(s)
    }
  }
  if (preloaded) noteGens(true)

  /**
   * Правило стабільності: жодна системна подія, крім `purge`, не змінює
   * складу й порядку видимого списку; завантаження користувача — дія
   * користувача, його завершення й початок виправдані.
   */
  const stability = (
    label: string,
    before: ReturnType<typeof lists>,
    purgeStep: boolean
  ) => {
    const after = lists()
    before.forEach((b, v) => {
      const a = after[v]
      if (b === undefined || a === undefined) return
      if (b.subset !== a.subset) return
      const same =
        a.keys.length === b.keys.length &&
        a.keys.every((x, i) => x === b.keys[i])
      if (same) return
      // Завантаження, що тривало чи почалось на цьому кроці, — користувача?
      const mine = userGens.get(a.subset!)
      const touched = [b.flight]
      for (let g = (b.gen ?? 0) + 1; g <= (a.gen ?? 0); g++) touched.push(g)
      if (touched.some((g) => g !== undefined && mine?.has(g) === true)) return
      // Сторінка вікна, читання якої було в польоті (дія користувача —
      // `loadAfter`/`loadBefore`; читання старого ланцюжка позначок не лишає,
      // тож його пізня відповідь росту не виправдовує): склад росте лише з
      // краю — попередні ключі лишаються префіксом чи суфіксом нового складу, а
      // приріст не більший за сторінки в польоті. Порожнє вікно теж росте так:
      // сторінка від порожнього краю — той самий випадок.
      const grown = a.keys.length - b.keys.length
      if (
        b.paging > 0 &&
        grown > 0 &&
        grown <= b.paging * LIMITS.windowPage &&
        (a.keys.slice(0, b.keys.length).join() === b.keys.join() ||
          a.keys.slice(grown).join() === b.keys.join())
      )
        return
      if (purgeStep) {
        // purge лише прибирає ключі, порядок решти той самий.
        const kept = b.keys.filter((x) => a.keys.includes(x))
        if (
          kept.length === a.keys.length &&
          kept.every((x, i) => x === a.keys[i])
        )
          return
      }
      fail(
        label,
        `view ${v} composition ${b.keys.join(",")} → ${a.keys.join(",")}`
      )
    })
  }

  const live = (object: ObjectName, k: Key) =>
    fake.row(object, k) !== undefined && !deleted.has(id(object, k))

  const commit = (fn: Parameters<CoreSession["commit"]>[0]) => {
    core.commit(fn, core.token())
  }

  /**
   * Перегідратація (план B3-6a, задача 1): знімок ядра йде в нове ядро над
   * тим самим сервером. Перевіряємо безпеку знімка (жодних значень `hidden`
   * чи `removed` ключа, жодного рядка без власника), що вигляди нового ядра
   * після `hydrate` показують те саме, що старого, і що після звірки
   * (`endHydration`) вони дорівнюють серверним. Читання нового ядра модель
   * відповідає сама й прибирає з журналу сервера: вони не належать основному
   * ядру, і його бар'єри не мають їх бачити.
   */
  async function rehydrate(label: string) {
    const raw = core.dehydrate()
    for (const [name, group] of Object.entries(raw.objects)) {
      const o = objectOf(name)
      const keyName = o.entry.keyName
      for (const slot of group.slots) {
        const slotKey = "state" in slot ? slot.key : (slot[0][keyName] as Key)
        const e = o.rows.get(slotKey)
        if (e === undefined)
          fail(label, `snapshot: ${name}/${slotKey} has no entry in the store`)
        else if (inspect.owners(name, slotKey) === 0)
          fail(label, `snapshot: ${name}/${slotKey} has no owner`)
        const hides =
          e!.removed !== undefined ||
          e!.stale.hidden !== undefined ||
          e!.row === undefined
        if (!("state" in slot) && hides)
          fail(label, `snapshot: values of a hidden or removed ${slotKey}`)
        if ("state" in slot && Object.hasOwn(slot, "values"))
          fail(label, `snapshot: a ${slot.state} slot carries values`)
      }
    }
    for (const [name, list] of Object.entries(raw.sections)) {
      for (const entry of list) {
        const header = objectOf(name).rows.get(entry.owner)
        if (
          header !== undefined &&
          (header.removed !== undefined || header.stale.hidden !== undefined)
        )
          fail(label, `snapshot: lines of a hidden owner ${entry.owner}`)
      }
    }
    // Знімок проходить крізь JSON, як крізь HTML.
    const snapshot = JSON.parse(JSON.stringify(raw)) as CoreSnapshot

    const mine: FakeReadLog[] = []
    const adapter = {
      capabilities: fake.adapter.capabilities,
      read: (items: Parameters<typeof fake.adapter.read>[0]) => {
        const from = fake.log.length
        const from2 = fake.pending.length
        const result = fake.adapter.read(items)
        mine.push(...fake.log.slice(from))
        for (const read of (fake.pending as FakeRead[]).splice(from2))
          queueMicrotask(() => read.answer())
        return result
      },
    }
    const next = createCore({
      subject: "u1",
      source: createCoreSource(
        () => adapter,
        fake.index,
        createReadLimiter(DEFAULT_CORE_LIMITS.readParallel),
        {
          run: () =>
            Promise.reject(new Error("a hydrated core writes nothing")),
          version: () => fake.server.version(),
        }
      ),
      index: fake.index,
      limits: LIMITS,
      log: (entry) => {
        if (entry.kind === "listener-failed") errors.push(entry.error)
      },
    })
    const nextInspect = inspectCore(next)
    // Дефекти основного ядра нового не стосуються: їх ловить своя перевірка
    // (`CAUGHT_BY`), а не перегідратація; нове ядро ламає лише власний.
    if (defects.includes("hydrate-without-revalidate"))
      nextInspect.defects.add("hydrate-without-revalidate")
    try {
      next.hydrate(snapshot)
      const violations = nextInspect.violations()
      if (violations.length > 0)
        fail(label, `after hydrate: ${violations.join("; ")}`)
      const held = [...coreInternals(next).registry.subsets()]
      for (const sub of held) {
        const v = SPECS.findIndex(
          (spec) => JSON.stringify(spec) === JSON.stringify(sub.form.spec)
        )
        if (v < 0) fail(label, "after hydrate: a view the model never held")
        sameViews(label, v, handles[v]!.getSnapshot(), next)
      }
      // Звірка: видимі вигляди — підписані.
      const unsubscribe = held.map((sub) => {
        const v = SPECS.findIndex(
          (spec) => JSON.stringify(spec) === JSON.stringify(sub.form.spec)
        )
        return next.view(SPECS[v]!).subscribe(() => {})
      })
      next.endHydration()
      for (let round = 0; round < 20; round++) await flush()
      const after = nextInspect.violations()
      if (after.length > 0) fail(label, `after reconcile: ${after.join("; ")}`)
      for (const sub of held) {
        const v = SPECS.findIndex(
          (spec) => JSON.stringify(spec) === JSON.stringify(sub.form.spec)
        )
        const snap = next.view(SPECS[v]!).getSnapshot()
        if (snap.status === "error" || snap.status === "purged") continue
        for (const row of snap.rows) {
          if (row.state === "removed") continue
          const at = `after hydrate: view ${v} ${row.key}`
          if (row.hidden === true) fail(label, `${at} still hidden`)
          const server = fake.row(sub.form.object.name, row.key)
          if (server === undefined || server.version !== row.version)
            fail(label, `${at}: version ${row.version}, server differs`)
          for (const field of Object.keys(row.values)) {
            if (field === "notes" && row.staleFields.includes(field)) continue
            if (!Object.is(row.values[field], server!.values[field]))
              fail(label, `${at}.${field} differs from the server`)
          }
        }
      }
      for (const stop of unsubscribe) stop()
    } finally {
      next.close("disposed")
      for (const read of mine) {
        const at = fake.log.indexOf(read)
        if (at >= 0) (fake.log as FakeReadLog[]).splice(at, 1)
      }
    }
  }

  /** The view of the old core and of the new one show the same (spec §6.6). */
  function sameViews(
    label: string,
    v: number,
    a: ViewSnapshot,
    nextCore: CoreSession
  ) {
    const where = `after hydrate: view ${v}`
    const to = nextCore.view(SPECS[v]!).getSnapshot()
    // Слот `hidden` лишає місце, а не факти рядка (версію, позначки): для
    // схованого ключа порівнюються лише ключ, `hidden` і відсутність значень.
    const shape = (row: RowView): unknown =>
      row.state === "removed"
        ? { key: row.key, state: "removed" }
        : row.hidden === true
          ? { key: row.key, hidden: true, values: row.values }
          : {
              key: row.key,
              version: row.version,
              values: row.values,
              staleFields: row.staleFields,
              hidden: row.hidden,
              stale: row.stale,
              state: row.state,
              refs:
                row.refs === undefined
                  ? undefined
                  : Object.fromEntries(
                      Object.entries(row.refs).map(([name, ref]) => [
                        name,
                        ref === null ? null : shape(ref),
                      ])
                    ),
            }
    const view = (snap: ViewSnapshot) => ({
      status: snap.status,
      isStale: snap.isStale,
      strategy: snap.strategy,
      truncated: snap.truncated,
      atEnd: snap.atEnd,
      atStart: snap.atStart,
      chain: snap.chain,
      target: snap.target,
      // Мутація, що тримала рядок `removed`, у знімок не йде.
      rows: snap.rows.map(shape),
      section:
        snap.section === undefined
          ? undefined
          : {
              ownerVersion: snap.section.ownerVersion,
              complete: snap.section.complete,
              lines: snap.section.lines,
              ownerState: snap.section.ownerState,
            },
    })
    const was = view(a)
    const now = view(to)
    for (const field of Object.keys(was) as (keyof typeof was)[]) {
      const x = JSON.stringify(was[field])
      const y = JSON.stringify(now[field])
      if (x !== y) fail(label, `${where}: ${field} ${x} → ${y}`)
    }
  }

  for (const [n, raw] of plan.entries()) {
    const s = onMutation(raw)
    const label = `step ${n} ${JSON.stringify(s)}`
    const stepStart = fake.log.length
    logAt = log.length
    restoredInStep.clear()
    const before = lists()
    preloadedSection = false
    let userViews = new Set<number>()
    let purgeStep = false
    let purgedScope: { object: ObjectName; scope: string } | undefined
    // Ключі, які `purge` кроку прибрав зі сховища (або назвав явно).
    let purgedKeys: { object: ObjectName; keys: Key[] } | undefined
    switch (s.t) {
      case "sub":
        subscribe(s.v, label)
        userViews = new Set([s.v])
        break
      case "unsub":
        subs[s.v]?.()
        subs[s.v] = undefined
        if (s.release) vi.advanceTimersByTime(RELEASE_MS)
        break
      case "churn": {
        const order = s.scroll
          ? SCROLL.map((_, i) => SCROLL[(s.v + i) % SCROLL.length]!)
          : [s.v]
        userViews = new Set(order)
        for (const v of order) {
          if (subs[v] !== undefined || closed !== undefined) continue
          subscribe(v, label)
          // Відповіді лише на читання цього кроку: завантаження вигляду.
          for (let round = 0; round < 20; round++) {
            await flush()
            const own = fake.pending.filter(
              (r) => fake.log.indexOf(r.log) >= stepStart
            )
            if (own.length === 0) break
            for (const read of own) {
              fake.take((r) => r === read).answer()
              record(read)
            }
          }
          // Інваріанти — і посеред прокрутки: інакше версії, які ядро
          // знало лише між завантаженням і звільненням, модель би не бачила.
          check(`${label} view ${v}`, stepStart)
          // `subscribe` записав відписку: `at` не звужений перевіркою вище.
          subs.at(v)?.()
          subs[v] = undefined
          vi.advanceTimersByTime(RELEASE_MS)
        }
        break
      }
      case "slow": {
        // Не більше двох: кожне займає місце обмежувача читань.
        if (subs[s.v] !== undefined || late.length >= 2) break
        subscribe(s.v, label)
        userViews = new Set([s.v])
        await flush()
        for (const read of fake.pending.filter(
          (r) => fake.log.indexOf(r.log) >= stepStart
        ))
          late.push(fake.take((r) => r === read))
        break
      }
      case "preload":
        userViews = new Set([s.v])
        preload(s.v, s.short, label)
        break
      case "refresh":
        userViews = new Set([s.v])
        if (s.showNew) handles[s.v]!.showNew()
        else handles[s.v]!.refresh()
        break
      case "page": {
        const v = WINDOWS[s.w]!
        // Лише підписаний вигляд: без нього вікна ще нема.
        if (subs[v] === undefined) break
        if (s.dir === "after") handles[v]!.loadAfter()
        else handles[v]!.loadBefore()
        break
      }
      case "visible":
        core.setVisible(SPECS[s.v]!, s.on)
        break
      case "answer": {
        if (fake.pending.length === 0) break
        // Генератор зміщує `pick` до малих чисел, а модель бере з кінця
        // черги: свіжі відповіді частіше, давні читання довше лишаються в
        // польоті й доходять пізно — після звільнень, витіснень і `purge`.
        const read = fake.take(
          fake.pending.length - 1 - (s.pick % fake.pending.length)
        )
        if (s.how === "forbidden") {
          read.fail("command.forbidden")
          break
        }
        if (s.how === "unavailable") {
          read.fail("command.unavailable")
          break
        }
        if (s.how === "missing") {
          // Рядок відсутній: на мить виконання рядка, якого читання просить,
          // немає — сервер його видаляє (рідше) чи на мить ховає його скоуп
          // (RLS), і рядок повертається наступним читанням.
          const object = read.object!
          const query = read.query
          const asked =
            query === undefined
              ? []
              : "id" in query
                ? [query.id]
                : "owner" in query && "tabularSection" in query
                  ? [query.owner]
                  : keysOf(query).length > 0
                    ? (keysOf(query) as Key[])
                    : object === TASK
                      ? KEYS
                      : ORG_KEYS
          const gone = asked.filter((k) => live(object, k))
          const victim = gone[s.at % Math.max(gone.length, 1)]
          if (victim === undefined) read.answer()
          else if (s.at % 3 === 0) {
            fake.remove(object, victim)
            deleted.add(id(object, victim))
            read.answer()
          } else {
            const scope =
              object === ORG
                ? victim
                : (fake.row(TASK, victim)!.values.org as string)
            fake.setVisibleScopes(
              (visibility ?? SCOPES).filter((x) => x !== scope)
            )
            read.answer()
            fake.setVisibleScopes(visibility)
          }
        } else if (s.how === "stale") {
          // Застаріла репліка: стан на мить між запитом і зараз.
          const span = fake.clock - read.issuedAt
          read.answer(read.issuedAt + (s.at < 3 ? 0 : s.at % (span + 1)))
        } else read.answer()
        record(read)
        break
      }
      case "edit":
        if (live(TASK, KEYS[s.k]!))
          fake.edit(TASK, KEYS[s.k]!, { title: `${TITLES[s.title]}${n}` })
        break
      case "delete":
        if (live(TASK, KEYS[s.k]!)) {
          fake.remove(TASK, KEYS[s.k]!)
          deleted.add(id(TASK, KEYS[s.k]!))
        }
        break
      case "move": {
        const row = fake.row(TASK, KEYS[s.k]!)
        if (row !== undefined && live(TASK, KEYS[s.k]!))
          fake.edit(TASK, KEYS[s.k]!, { org: row.values.org === S ? T : S })
        break
      }
      case "lines":
        if (live(TASK, K1)) setLines(s.qty + 1)
        break
      case "create":
        if (!created) {
          created = true
          fake.insert(TASK, {
            ref: K5,
            org: SCOPES[s.scope],
            title: "c",
            notes: "n5",
          })
        }
        break
      case "access":
        visibility = s.which === 0 ? undefined : [s.which === 1 ? T : S]
        fake.setVisibleScopes(visibility)
        break
      case "purgeKey": {
        purgeStep = true
        const object = s.org ? ORG : TASK
        const target = s.org ? ORG_KEYS[s.k % 2]! : KEYS[s.k]!
        commit((w) => w.purge(object, { keys: [target] }))
        if (closed !== undefined) break
        if (object === TASK) {
          // Надгробок ключа: відповідь польоту значень не пише, а журнал
          // стирає поля (Р11).
          for (const a of attempts)
            if (a.result === undefined && a.key === target) a.purged = true
          const entry = journal.get(target)
          if (entry !== undefined) entry.erased = true
        }
        purgedKeys = { object, keys: [target] }
        purgedTargets.add(id(object, target))
        purgeBarrier.set(id(object, target), stepStart)
        if (object === TASK) barrierSections(stepStart)
        break
      }
      case "purgeScope": {
        purgeStep = true
        const object = s.org ? ORG : TASK
        const scope = SCOPES[s.scope]!
        const held = [...objectOf(object).rows.keys()]
        const hadLines =
          object === TASK &&
          objectOf(TASK).sections.get(K1, "lines") !== undefined
        commit((w) => w.purge(object, { scope }))
        if (closed !== undefined) break
        purgedScope = { object, scope }
        purgedKeys = {
          object,
          keys: held.filter((k) => objectOf(object).rows.get(k) === undefined),
        }
        if (object === TASK) {
          // Надгробок пари — для спроби зі скоупом пари на старті; надгробок
          // ключа — для прибраного ключа. Поля стирає запис цього скоупу чи
          // невідомого (Р11).
          const buried = new Set(purgedKeys.keys)
          for (const a of attempts)
            if (
              a.result === undefined &&
              (a.scope === scope || buried.has(a.key))
            )
              a.purged = true
          for (const entry of journal.values()) {
            const at = entry.attempt.scope
            if (at === undefined || at === scope) entry.erased = true
          }
        }
        for (const k of purgedKeys.keys) purgedTargets.add(id(object, k))
        // Власник без шапки в сховищі, чиї рядки ТЧ прибрано, — прибраний;
        // з шапкою (в іншому скоупі) доступ не втрачено.
        if (
          hadLines &&
          objectOf(TASK).sections.get(K1, "lines") === undefined &&
          objectOf(TASK).rows.get(K1) === undefined
        )
          purgedTargets.add(id(TASK, K1))
        // П12: ключ, якого після purge у сховищі немає, повертає лише
        // читання, що почалось після нього.
        for (const k of object === TASK ? KEYS : ORG_KEYS) {
          if (objectOf(object).rows.get(k) === undefined)
            purgeBarrier.set(id(object, k), stepStart)
        }
        if (object === TASK) barrierSections(stepStart)
        break
      }
      case "hide": {
        // Плоский `hide` держану ТЧ не перечитує (тригери — монтування,
        // `preload`, `commit` зі слухачем).
        heldInFlight = false
        const object = s.org ? ORG : TASK
        const target = s.org ? ORG_KEYS[s.k % 2]! : KEYS[s.k]!
        commit((w) => w.hide(object, [target]))
        if (closed !== undefined) break
        hideBarrier.set(id(object, target), stepStart)
        break
      }
      case "hideSection": {
        if (closed !== undefined) break
        const section = SPECS[4]!
        heldInFlight = false
        userViews = new Set([4])
        if (s.state === "mounted") subscribe(4, label)
        else if (s.state === "held") {
          // Утримувана без слухачів і завантажена: відписка до звільнення
          // чи `preload` з відповіддю на його читання.
          if (subs[4] !== undefined) {
            subs[4]()
            subs[4] = undefined
          } else {
            preload(4, false, label)
            preloadedSection = false
            await flush()
            for (const read of fake.pending.filter(
              (r) => fake.log.indexOf(r.log) >= stepStart
            )) {
              fake.take((r) => r === read).answer()
              record(read)
            }
          }
        } else {
          // Завантаження в польоті під час `hide`: нове утримання чи `refresh`.
          const held = internals.registry.find(section)
          if (held === undefined) preload(4, false, label)
          else if (held.flight === undefined) handles[4]!.refresh()
          preloadedSection = false
        }
        await flush()
        // Бар'єр — після читань, які крок надіслав до `hide`.
        const barrier = fake.log.length
        const hidden = s.evict ? [K1, K2, K3, K4] : [K1]
        for (const k of hidden) {
          commit((w) => w.hide(TASK, [k]))
          hideBarrier.set(id(TASK, k), barrier)
        }
        if (closed !== undefined) break
        await flush()
        if (s.then === "sub") subscribe(4, label)
        else if (s.then === "preload") {
          preload(4, false, label)
          // `preload` застає перше завантаження в польоті: перевірку
          // (`check(s, true)`) відкладено до його кінця, і слухачів тоді
          // немає. Закінчений політ уже перечитано самим `preload`.
          heldInFlight =
            s.state === "flight" &&
            preloadedSection &&
            internals.registry.find(section)?.flight !== undefined
        }
        break
      }
      case "revalidate":
        core
          .revalidate(s.org ? ORG : TASK, { visibleOnly: s.visibleOnly })
          .catch((error: unknown) => errors.push(error))
        break
      case "markStale": {
        const version = fake.row(TASK, KEYS[s.k]!)?.version ?? 1
        commit((w) => w.markStale(TASK, [KEYS[s.k]!], version + s.plus))
        break
      }
      case "disconnect": {
        const ch = CHANNELS[s.channel]
        commit((w) => {
          if (s.clear && ch !== undefined) w.clearDisconnected(ch)
          else w.markDisconnected(ch)
        })
        break
      }
      case "markViews": {
        const spec = SPECS[s.v]!
        commit((w) =>
          w.markViews(
            spec.object,
            { needsRefresh: s.needs, hasNewRows: s.news },
            s.one ? spec : undefined
          )
        )
        break
      }
      case "time":
        vi.advanceTimersByTime(s.ms)
        break
      case "epoch":
        fake.epoch = EPOCHS[s.which]!
        if (fake.epoch !== null) primaryEpoch = fake.epoch
        break
      case "update": {
        const k = KEYS[s.k]!
        const stored = objectOf(TASK).rows.get(k)
        const server = fake.row(TASK, k)
        // База: підтверджена версія сховища, серверна чи застаріла.
        const base =
          s.base === 0
            ? (stored?.version ?? server?.version ?? 1)
            : s.base === 1
              ? (server?.version ?? 1)
              : Math.max(1, (stored?.version ?? 1) - 1)
        const values = s.lazy ? { notes: `w${n}` } : { title: `u${n}` }
        const existing = journal.get(k)
        const pending =
          closed === undefined &&
          existing !== undefined &&
          existing.attempt.result === undefined
        const attempt = begin(k)
        let mutation
        try {
          mutation = core.update(TASK, k, values, { expectedVersion: base })
        } catch (error) {
          sending = undefined
          // Одна мутація на ключ (Р1): `pending` — відмова до журналу.
          if (
            pending &&
            error instanceof DataError &&
            error.code === "data.mutation-pending"
          )
            break
          throw error
        }
        if (pending) fail(label, `${k}: an update of a pending key went out`)
        if (closed === undefined && !attempt.sent)
          fail(label, `${k}: an update sent no run`)
        track(attempt, mutation)
        if (closed === undefined)
          journal.set(k, { key: k, attempt, erased: false, created: checks })
        break
      }
      case "run": {
        if (runs.length === 0) break
        // Як і з читаннями: з кінця черги, тож давні `run` доходять пізно.
        const [held] = runs.splice(runs.length - 1 - (s.pick % runs.length), 1)
        answerRun(held!, s.how, s.at)
        break
      }
      case "removeMut": {
        // Ключ з мутацією стає `removed`: RLS на мить ховає його скоуп від
        // перечитування виглядів; дія «Скасувати» `removed` з мутацією в
        // дорозі — відповідь після неї нічого не пише (Р7, Р9).
        const k = KEYS[s.k]!
        const row = fake.row(TASK, k)
        if (row === undefined || closed !== undefined) break
        const hiddenScope = row.values.org as string
        fake.setVisibleScopes(
          (visibility ?? SCOPES).filter((x) => x !== hiddenScope)
        )
        core
          .revalidate(TASK, { visibleOnly: false })
          .catch((error: unknown) => errors.push(error))
        for (let round = 0; round < 20; round++) {
          await flush()
          const own = fake.pending.filter(
            (r) => fake.log.indexOf(r.log) >= stepStart
          )
          if (own.length === 0) break
          for (const read of own) {
            fake.take((r) => r === read).answer()
            record(read)
          }
        }
        fake.setVisibleScopes(visibility)
        const entry = journal.get(k)
        const shown = rowsOf(k)[0]
        if (
          s.cancel &&
          entry !== undefined &&
          shown?.state === "removed" &&
          shown.mutation?.id === entry.attempt.id &&
          shown.mutation.cancel !== undefined
        ) {
          shown.mutation.cancel()
          dropEntry(entry)
        }
        break
      }
      case "act": {
        const k = KEYS[s.k]!
        const entry = journal.get(k)
        const shown = rowsOf(k)[0]?.mutation
        if (entry === undefined || shown?.id !== entry.attempt.id) break
        if (s.act === "retry") {
          if (shown.retry === undefined) break
          const attempt = begin(k)
          const next = shown.retry()
          if (next === undefined) {
            sending = undefined
            fail(label, `${k}: retry offered, no attempt`)
          }
          if (!attempt.sent) fail(label, `${k}: retry sent no run`)
          track(attempt, next!)
          entry.attempt = attempt
          break
        }
        const action = s.act === "cancel" ? shown.cancel : shown.dismiss
        if (action === undefined) break
        action()
        dropEntry(entry)
        break
      }
      case "rehydrate":
        // Журнал мутацій у знімок не йде: `dehydrate` після запису — помилка
        // host-а (`TypeError`), тож крок виконується лише з порожнім журналом.
        if (closed !== undefined) break
        if (inspect.serviceSizes().journal > 0) {
          let refused = false
          try {
            core.dehydrate()
          } catch (error) {
            refused = error instanceof TypeError
          }
          if (!refused) fail(label, "dehydrate with a non-empty journal")
          break
        }
        await rehydrate(label)
        break
      case "close":
        if (closed !== undefined) break
        // Кожна неосіла мутація осідає закриттям, не успіхом.
        for (const a of attempts) if (a.result === undefined) a.mustFail = true
        journal.clear()
        core.close(s.reason)
        closed = {
          frames,
          sent: fake.log.length,
          snapshot: handles[0]!.getSnapshot(),
        }
        if (
          closed.snapshot.status !== "purged" ||
          closed.snapshot.reason !== s.reason ||
          closed.snapshot.rows.length !== 0
        )
          fail(label, "close snapshot is not purged with the reason")
        break
    }
    await flush()
    if (purgedScope !== undefined) {
      const o = objectOf(purgedScope.object)
      for (const k of o.rows.keys()) {
        if (o.rows.get(k)!.scope === purgedScope.scope)
          fail(label, `${purgedScope.object}/${k} survived the scope purge`)
      }
    }
    check(label, stepStart)
    if (purgedKeys !== undefined) checkPurged(label, purgedKeys)
    noteGens(userViews.size > 0)
    stability(label, before, purgeStep)
  }

  // Відповіді на `run`, що лишились у польоті: сервер приймає кожен.
  for (let i = 0; runs.length > 0; i++) {
    if (i > 100) fail("drain runs", "runs never end")
    const stepStart = fake.log.length
    logAt = log.length
    restoredInStep.clear()
    const before = lists()
    answerRun(runs.shift()!, "ok", 1)
    await flush()
    check(`drain run ${i}`, stepStart)
    noteGens(false)
    stability(`drain run ${i}`, before, false)
  }

  // Пізні відповіді на все, що лишилось у польоті: повільні читання й
  // кожне друге з решти — застарілою реплікою (стан на мить запиту) після
  // всіх звільнень і витіснень прогону, інші — станом зараз.
  preloadedSection = false
  for (let i = 0; late.length > 0 || fake.pending.length > 0; i++) {
    if (i > 500) fail("drain", "reads never end")
    const stepStart = fake.log.length
    logAt = log.length
    restoredInStep.clear()
    const before = lists()
    const slow = late.shift()
    const read = slow ?? fake.take()
    read.answer(slow !== undefined || i % 2 === 0 ? read.issuedAt : fake.clock)
    record(read)
    await flush()
    check(`drain ${i}`, stepStart)
    noteGens(false)
    stability(`drain ${i}`, before, false)
  }

  if (closed === undefined) await converge()

  /**
   * Збіжність до сервера: відновлюємо видимість, перечитуємо кожен
   * підписаний вигляд (`refresh`) і обидва об'єкти (`revalidate`), відповідаємо
   * на все станом зараз — і кожен показаний рядок, рядок `refs` та рядки ТЧ
   * мусять дорівнювати серверним (версія й значення) або бути `removed`,
   * коли сервер рядка не має.
   */
  async function converge() {
    // Таймери звільнення й TTL `preload` спрацьовують до перечитування: їхній
    // надгробок поховав би відповідь читання, що почалось раніше (за
    // задумом), і збіжність мірялась би проти артефакту моделі.
    // База сходиться до епохи, за якою йде сесія: відповіді покинутої
    // епохи сесія не застосовує ніколи.
    const epochs = inspect.versionEpochs()
    fake.epoch = epochs.current
    vi.advanceTimersByTime(10_000)
    await flush()
    fake.setVisibleScopes(undefined)
    visibility = undefined
    for (let v = 0; v < SPECS.length; v++) {
      if (subs[v] !== undefined) handles[v]!.refresh()
    }
    let settled = 0
    const done = Promise.all(
      [TASK, ORG].map((o) =>
        core
          .revalidate(o, { visibleOnly: false })
          .catch((error: unknown) => errors.push(error))
      )
    ).then(() => settled++)
    let quiet = 0
    for (let i = 0; quiet < 3; i++) {
      if (i > 500) fail("converge", "reads never end")
      await flush()
      if (fake.pending.length === 0 && settled > 0) quiet++
      else quiet = 0
      const stepStart = fake.log.length
      logAt = log.length
      restoredInStep.clear()
      while (fake.pending.length > 0) {
        const read = fake.take()
        read.answer()
        record(read)
      }
      await flush()
      check(`converge ${i}`, stepStart)
    }
    await done
    SPECS.forEach((spec, v) => {
      if (subs[v] === undefined) return
      const snap = handles[v]!.getSnapshot()
      const where = `converge view ${v}`
      if (snap.status === "purged") return
      // Після межі відкинутих відповідей поспіль сесія не читає: вихід
      // — лише нова сесія.
      if (epochs.unavailable) {
        if (
          snap.status !== "error" ||
          snap.error?.code !== "command.unavailable"
        )
          fail(where, `status ${snap.status} of an unavailable session`)
        return
      }
      if (snap.status !== "ready")
        fail(where, `status ${snap.status} after refresh`)
      for (const row of snap.rows) sameAsServer(where, spec.object, row)
      // Рядок, який сервер має, мусить бути показаний: порожня готова
      // картка чи список без нього — втрата, а не збіжність.
      const wanted =
        spec.kind === "keys"
          ? spec.keys
          : spec.kind === "card"
            ? [spec.key]
            : []
      for (const k of wanted) {
        if (fake.row(spec.object, k) === undefined) continue
        const shown = snap.rows.find((r) => r.key === k)
        if (shown === undefined || shown.state === "removed")
          fail(where, `${spec.object}/${k}: on the server, view shows none`)
      }
      if (spec.kind === "window") {
        // Після `refresh` вікно — перша сторінка серверного порядку.
        const entry = fake.index.byRef.get(TASK)!
        const compare = compareRows(
          spec.orderBy ?? [],
          fieldInfoOf(entry),
          entry.keyName,
          filterCollator()
        )
        const expected = KEYS.flatMap((k) => {
          const row = fake.row(TASK, k)
          return row === undefined ? [] : [row.values]
        })
          .sort(compare)
          .slice(0, LIMITS.windowPage)
          .map((values) => values.ref as Key)
        const shown = snap.rows.map((r) => r.key)
        // Уся перша сторінка сервера показана, у порядку сервера.
        const at = shown.map((k) => expected.indexOf(k))
        if (at.some((x, n) => x < 0 || (n > 0 && x <= at[n - 1]!)))
          fail(where, `window ${shown.join()} ⊄ server ${expected.join()}`)
        for (const k of expected) {
          if (!shown.includes(k))
            fail(
              where,
              `window ${shown.join()} lacks ${k} of ${expected.join()}`
            )
        }
      }
      if (spec.kind === "full" && snap.atEnd) {
        // Склад `full` — рядки сервера, що проходять фільтр (рядок, що
        // зник із сервера, склад уже прибрав перезавантаження).
        const shown = snap.rows.map((r) => r.key)
        const expected = KEYS.filter((k) => {
          const row = fake.row(TASK, k)
          return (
            row !== undefined &&
            (spec.where === undefined ||
              String(row.values.title) >=
                String((spec.where as { value: unknown }).value))
          )
        })
        if ([...shown].sort().join() !== [...expected].sort().join())
          fail(where, `composition ${shown.join()} ≠ server ${expected.join()}`)
      }
      if (spec.kind === "section" && snap.section !== undefined) {
        const owner = fake.row(TASK, spec.owner)
        const { ownerState, ownerVersion, lines } = snap.section
        if (owner === undefined) {
          // Без шапки в сховищі (читання власника ТЧ не знайшло) стан
          // власника невідомий.
          if (
            (ownerState !== "removed" && ownerState !== "unknown") ||
            lines.length > 0
          )
            fail(
              where,
              `owner is gone, section ${ownerState} with ${lines.length} lines`
            )
        } else {
          if (ownerVersion !== owner.version)
            fail(
              where,
              `owner version ${String(ownerVersion)} ≠ ${owner.version}`
            )
          const expected = linesHistory.at(-1)!.qty
          const shown = lines.map((l) => l.values.qty)
          if (JSON.stringify(shown) !== JSON.stringify(expected))
            fail(where, `lines ${String(shown)} ≠ server ${String(expected)}`)
        }
      }
    })
  }

  function sameAsServer(where: string, object: ObjectName, row: RowView) {
    const at = `${where} ${object}/${row.key}`
    const server = fake.row(object, row.key)
    if (row.state === "removed") {
      if (server !== undefined)
        fail(where, `${at}: removed, the server has the row`)
      return
    }
    if (server === undefined)
      return fail(where, `${at}: ${row.state}, the server has no such row`)
    if (row.version !== server.version)
      fail(where, `${at}: version ${row.version} ≠ server ${server.version}`)
    const fields = Object.keys(row.values)
    if (fields.length === 0) fail(where, `${at}: values hidden after refresh`)
    for (const field of fields) {
      if (field === "notes" && row.staleFields.includes(field)) continue
      if (!Object.is(row.values[field], server.values[field]))
        fail(where, `${at}.${field} ≠ server`)
    }
    for (const [field, ref] of Object.entries(row.refs ?? {})) {
      if (ref !== null) sameAsServer(`${where} ref`, ORG, ref)
      else {
        // `null` — лише для цілі, якої сервер не показує; наявна ціль
        // не може лишитись порожньою (гонка власності `include`).
        const target = row.values[field]
        if (typeof target === "string" && fake.row(ORG, target) !== undefined)
          fail(where, `${at}.${field}: ref is null, the server has the target`)
      }
    }
  }
}

// Порожнє чи незадане — 10 000 прогонів; нечислове чи неплюсове значення —
// помилка, а не тихі нуль прогонів, що виглядали б зеленим гейтом.
function runsFromEnv(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 10_000
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0)
    throw new Error(
      `CORE_MODEL_RUNS must be a positive integer, got ${JSON.stringify(raw)}`
    )
  return n
}
const RUNS = runsFromEnv(process.env.CORE_MODEL_RUNS)

const property = (defects: readonly DefectFlag[] = []) =>
  fc.asyncProperty(
    fc.array(STEP, { minLength: 10, maxLength: 80, size: "max" }),
    fc.boolean(),
    fc.constantFrom<Profile>("full", "scroll", "burial"),
    (steps, preloaded, profile) => runModel(steps, preloaded, profile, defects)
  )

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
})
afterEach(() => {
  vi.useRealTimers()
})

describe("core model", () => {
  it("holds the invariants over random interleavings", async () => {
    await fc.assert(property(), { numRuns: RUNS })
  }, 120_000)
})

const DEFECTS: readonly DefectFlag[] = [
  "no-token-check",
  "version-decrease",
  "no-tombstone",
  "no-horizon-tombstones",
  "no-horizon-seen",
  "removed-by-older-read",
  "purge-by-values",
  "purge-keeps-flights",
  "reread-changes-layout",
  "row-without-owner",
  "removed-keeps-sections",
  "revision-survives-row",
  "purge-keeps-views",
  "purge-marks-unrelated-views",
  "repeated-remove-keeps-epoch",
  "absent-row-ignored",
  "unbounded-seen",
  "system-reread-via-load",
  "hide-lifted-by-older-read",
  "section-ignores-hide",
  "recheck-needs-listeners",
  "page-without-generation",
  "window-copies-values",
  "bury-removed-current-epoch",
  "predict-before-answer",
  "settle-separate-commit",
  "write-back-lifts-hidden",
  "answer-after-cancel",
  "hidden-values-in-snapshot",
  "hydrate-without-revalidate",
]

// Какою перевіркою дефект ловиться, коли це важливо: нові перевірки
// (збіжність, межі пам'яті, `purge` картки, ТЧ у сховищі) не мають бути
// затулені старішими.
const CAUGHT_BY: Partial<Record<DefectFlag, RegExp>> = {
  "removed-keeps-sections": /section lines stored for a removed owner/,
  // Та сама перевірка `checkPurged` для картки й ТЧ: насіння після зміни
  // генератора (крок епохи) знаходить ТЧ.
  "purge-keeps-views": /(card|section) of purged/,
  "purge-marks-unrelated-views": /purged without a purge of its key/,
  "absent-row-ignored": /^converge/,
  "unbounded-seen": /seen \d+ > \d+/,
  "system-reread-via-load": /composition/,
  "hide-lifted-by-older-read": /after hide without a later read/,
  "section-ignores-hide": /not re-read after hide/,
  "recheck-needs-listeners": /not re-read after hide/,
  // Читання між позначкою `removed` і похованням слота відкидається, тож
  // `full` чи вікно закінчують без рядка сервера.
  "bury-removed-current-epoch": /^converge .*(composition|lacks)/,
  // Запис (план B3-4-Л, задача 4): кожен дефект — своєю перевіркою.
  "predict-before-answer": /\.title = u\d+, server at/,
  "settle-separate-commit": /the run row shown with its mutation pending/,
  "write-back-lifts-hidden": /after hide without a later read/,
  "answer-after-cancel": /a cancelled attempt settled with a row/,
  // Перегідратація (план B3-6a, задача 1): знімок і звірка.
  "hidden-values-in-snapshot": /snapshot: a hidden slot carries values/,
  "hydrate-without-revalidate": /after hydrate: view \d+ .*(server|hidden)/,
}

describe("core model self-check", () => {
  it.each(DEFECTS)(
    "turns red with the defect %s",
    async (flag) => {
      // Стале насіння: самотест відтворюваний, а найдовший шлях до червоного
      // (дефект горизонту) займає кілька тисяч прогонів.
      const result = await fc.check(property([flag]), {
        numRuns: 10_000,
        seed: 1,
        // Достатньо знайти червоний прогін: ужимання контрприкладу лише
        // подовжує самотест.
        endOnFailure: true,
      })
      expect(result.failed, `${flag} not caught`).toBe(true)
      expect(result.errorInstance).toBeInstanceOf(ModelFailure)
      // Контроль: той самий контрприклад без дефекту проходить, тож червоний
      // — від дефекту, а не від помилки моделі.
      const [steps, preloaded, profile] = result.counterexample!
      await runModel(steps, preloaded, profile, [])
      const caughtBy = CAUGHT_BY[flag]
      if (caughtBy !== undefined)
        expect((result.errorInstance as Error).message).toMatch(caughtBy)
    },
    120_000
  )
})
