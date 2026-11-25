import fc from "fast-check"
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import {
  ORGANIZATION_ID,
  OBJECT_ID,
  SCOPE_KIND_ID,
  catalogRights,
} from "../../../model/runtime/__tests__/entries"
import {
  CommandFailure,
  channelTopic,
  readResultFromWire,
  type CatalogEntry,
  type CommandError,
  type ReadRows,
  type RightsRow,
  type RightsSnapshot,
} from "simetra/model"
import { DataError } from "../../errors"
import {
  coreInternals,
  createCore,
  inspectCore,
  type CoreSession,
  type DefectFlag,
  type SyncState,
} from "../core"
import { compareRows, fieldInfoOf, filterCollator } from "../filter"
import { visibleRow } from "../object-store"
import { createCoreSource, createReadLimiter, type ServerPort } from "../source"
import { EPOCH_UNAVAILABLE, type Subset } from "../subsets"
import type { FakeRead, FakeReadLog, FakeSource } from "../testing/fake-source"
import { createFakeSignalTransport } from "../testing/fake-signal-transport"
import { MIN_VERSION_RETRIES, REJOIN_JITTER_MS } from "../receiver"
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
import {
  ORG,
  S,
  TASK,
  interruptWithin,
  key,
  modelRun,
  settleRuns,
  keysOf,
  org,
  setup,
  task,
} from "./core-support"
import { collectCore, type ReadCollector, type StampedEvent } from "./oracles"
import type { AttemptEvent } from "../attempts"
import { assertEvaluated, createO2, readsHeader } from "./o2"
import {
  assertEvaluated as assertO3Evaluated,
  checkpoints as o3Checkpoints,
  createO3,
  hasOwnDuty,
  headerHolderSince,
  judgeRows,
  judgeSection,
  lastBound as o3LastBound,
  type O3Change,
  type O3Join,
  type O3State,
  type O3View,
} from "./o3"
import { trackViews } from "./view-facts"

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
// Інтервал перевірки свіжості поточного прогону: за замовчуванням `REVALIDATE_MS`;
// прогін самотесту «хвиля приєднання не читає» бере інтервал, набагато більший за
// джитер приєднання, щоб такт не підміняв хвилю (план SK-0, Р-SK0-9).
let runInterval = REVALIDATE_MS
// Межа свіжості `resume()` — менша за кроки `time`: частина виглядів старша
// за неї, частина молодша.
const RESUME_MIN_MS = 500
// Подвійний сигнал повернення (focus + visibilitychange) — одна звірка.
const RESUME_COALESCE_MS = 1_000

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
  get revalidateIntervalMs() {
    return runInterval
  },
  resumeMinIntervalMs: RESUME_MIN_MS,
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
  // Вікна: у порядку заголовка, що змінюють чужі правки, і
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

// ── Знімок прав (спека П4-B §6.2 правило 4, §9.3) ──
const USER = "00000000-0000-4000-8000-0000000000a1"
const OTHER_USER = "00000000-0000-4000-8000-0000000000a2"
// Обидва об'єкти моделі під договором прав: прохід і бар'єр судять і задачі,
// і цілі `include`.
const RIGHTS_OBJECTS: readonly CatalogEntry[] = [
  { ...task, rights: catalogRights() },
  { ...org, rights: catalogRights() },
]
const LABELS: Readonly<Record<ObjectName, string>> = {
  [TASK]: "task",
  [ORG]: "organization",
}

/**
 * Права користувача моделі — еталон, незалежний від `readAllowed`: членство в
 * скоупах і рядки `read` рівня скоупу (`<мітка>\u0000<скоуп>`) обсягу `any`
 * та додаткові обсягу `own` (їх зникнення при наявному `any` — звуження).
 */
interface Grant {
  readonly user: string
  readonly members: readonly string[]
  readonly reads: readonly string[]
  readonly extra: readonly string[]
}

const grantKey = (object: ObjectName, scope: string) =>
  `${LABELS[object]}\u0000${scope}`

const FULL_GRANT: Grant = {
  user: USER,
  members: [...SCOPES],
  reads: [TASK, ORG].flatMap((o) => SCOPES.map((x) => grantKey(o, x))),
  extra: [],
}

/** Пару заборонено: скоупу немає в членстві або немає жодного рядка `read`. */
const grantDenies = (g: Grant, object: ObjectName, scope: string | null) =>
  scope === null ||
  !g.members.includes(scope) ||
  !(
    g.reads.includes(grantKey(object, scope)) ||
    g.extra.includes(grantKey(object, scope))
  )

const rightsRow = (at: string, extent: string): RightsRow => {
  const [object, scope] = at.split("\u0000") as [string, string]
  return {
    level: "scope",
    levelId: null,
    scope,
    container: null,
    object,
    action: "read",
    extent,
    dimensionId: null,
  }
}

const snapshotOf = (g: Grant): RightsSnapshot => ({
  userId: g.user,
  scopeSets: g.members.map((scope) => ({ scopeKind: SCOPE_KIND_ID, scope })),
  rights: [
    ...g.reads.map((at) => rightsRow(at, "any")),
    ...g.extra.map((at) => rightsRow(at, "own")),
  ],
  members: [],
  dimensionValues: [],
})

const without = (list: readonly string[], x: string) =>
  list.filter((y) => y !== x)
const withOne = (list: readonly string[], x: string) =>
  list.includes(x) ? list : [...list, x]

/** How the model answers a `rights` step. */
type RightsHow =
  "lose" | "regain" | "narrow" | "same" | "fail" | "hold" | "user"

type How = "ok" | "stale" | "forbidden" | "missing" | "unavailable"

/** What a signal step sends: an op of the change channel or an unparsable body. */
type SignalOp =
  "create" | "update" | "markDeletion" | "delete" | "invalidate" | "garbage"

/** How the model answers a held `run`. */
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
  | { t: "gap"; k: number; remove: boolean }
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
  | { t: "disconnect"; channel: number; join: boolean }
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
  | { t: "stale"; org: boolean }
  | { t: "version" }
  | { t: "return"; minAge: number }
  | { t: "suspend" }
  | { t: "resume" }
  | { t: "due" }
  | { t: "outage"; steps: number }
  | { t: "exhaust" }
  // `object`: 0 — рядок `read` задач, 1 — організацій, 2 — членство в скоупі.
  | { t: "rights"; what: RightsHow; object: number; scope: number }
  | { t: "race"; group: number; settle: "now" | "later" }
  // Кроки сигналів (B5b-3, задача 6). `ch`: 0 — канал скоупу рядка на
  // сервері, 1 — канал іншого скоупу; `ver`: 0 — версія сервера, 1 — старша
  // на одиницю (відлуння, переставлений сигнал), 2 — новіша (репліка
  // відстає); `change` — сервер спершу робить саму зміну.
  | {
      t: "signal"
      org: boolean
      k: number
      op: SignalOp
      ch: number
      ver: number
      change: boolean
    }
  // Повтор раніше надісланого повідомлення (той самий `id`): дубль і
  // перестановка — старе повідомлення після новіших.
  | { t: "replay"; pick: number }
  | { t: "join"; ch: number; recovered: boolean }
  // `ch` = CHANNELS.length — розрив усього з'єднання.
  | { t: "transport"; ch: number }
  | { t: "chanAuth"; ch: number }
  | { t: "connAuth"; final: boolean }
  | { t: "refreshTokens" }

const view = fc.nat(SPECS.length - 1)
const k = fc.nat(KEYS.length - 1)
const one = <T extends Step["t"]>(t: T) => fc.constant(t)

/**
 * Ваги (бриф, крок 1): сума 250 (планувальник — по 1 на `suspend`, `resume`,
 * `due` і `outage`; вага підібрана за самотестом: більші ваги зсувають
 * насіння так, що дефекти горизонту й скасування знаходяться за вдвічі
 * більше прогонів; решта — 246: чужа зміна між межами сторінок `full` — 4; повернення — 8; перегідратація — 6; перемикання епохи — 6; `hide` над
 * ТЧ-підмножиною — 6; сторінка вікна — 8; запис — 50: `update` 14, відповідь
 * `run` 20, дії мутації 8, чужа правка, `purge` чи `hide` ключа з мутацією 6,
 * `dispose()` з мутацією в дорозі 2); `purge` (16 + 14), відсутній рядок і
 * застаріла репліка — по 30, тобто по ~12 % кроків (частина кроків
 * `answer` порожня, бо в польоті нічого нема, тож серед дійових кроків
 * частка вища, близько 15 %). Самотест тримає насіння, яке знаходить
 * дефекти за кількістю прогонів: зміна генератора (ваги, профілі, масиви
 * кроків) зсуває ці числа, тож після неї самотест перевіряють заново.
 */
const STEP_ENTRIES: fc.WeightedArbitrary<Step>[] = [
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
  // Чужа зміна між збереженими межами сторінок системного перечитування
  // `full`: рядок зникає чи перелітає на край порядку (за `title`) саме тоді,
  // коли перечитування стартувало. Хибна межа не дає ні пропуску, ні дубля.
  {
    weight: 4,
    arbitrary: fc.record({ t: one("gap"), k, remove: fc.boolean() }),
  },
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
  // `hide` (права): значення ключа ховаються до читання,
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
      join: fc.boolean(),
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
  // Запис: `update` з базою — підтвердженою версією,
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
  // Перегідратація: знімок ядра, нове ядро над тим
  // самим сервером, `hydrate`, `endHydration`, звірка.
  { weight: 6, arbitrary: fc.record({ t: one("rehydrate") }) },
  // Несумісний об'єкт: липка позначка `stale-client`
  // й відповіді `version` без розбіжності, що її не знімають.
  { weight: 1, arbitrary: fc.record({ t: one("stale"), org: fc.boolean() }) },
  { weight: 2, arbitrary: fc.record({ t: one("version") }) },
  // Повернення: частина `version` і перечитування
  // видимих виглядів з межею свіжості; межі — менша й більша за кроки `time`.
  {
    weight: 8,
    arbitrary: fc.record({
      t: one("return"),
      minAge: fc.constantFrom(RELEASE_MS, 5_000),
    }),
  },
  // Планувальник свіжості (спека §6.7): вкладка ховається й повертається,
  // час іде до найближчого строку планувальника, сервер недоступний кілька кроків.
  { weight: 1, arbitrary: fc.record({ t: one("suspend") }) },
  { weight: 1, arbitrary: fc.record({ t: one("resume") }) },
  { weight: 1, arbitrary: fc.record({ t: one("due") }) },
  {
    weight: 1,
    arbitrary: fc.record({
      t: one("outage"),
      steps: fc.integer({ min: 1, max: 6 }),
    }),
  },
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
  },
]
const STEP: fc.Arbitrary<Step> = fc.oneof(...STEP_ENTRIES)

/**
 * Вигляди, чиє читання крок `race` запускає до відправки знімка: картка з
 * ТЧ свого власника, картки, ТЧ і списки ключів задач.
 */
const RACE_GROUPS: readonly (readonly number[])[] = [
  [2, 4],
  [3],
  [4],
  [0],
  [1],
  [7],
  [8],
  [2],
]

/**
 * Кроки знімка прав (бриф задачі 6 B5b-2) поверх звичайних: сума 52 проти 250,
 * тож заміна знімка йде в кожному прогоні кілька разів. `race` — обов'язковий
 * крок архітекторки: читання пари стартує до відправки знімка, пари в
 * сховищі немає, знімок її забороняє, відповідь осідає після заміни — одразу
 * чи пізніше, у будь-якому порядку з рештою кроків.
 */
const RIGHTS_ENTRIES: fc.WeightedArbitrary<Step>[] = [
  ...STEP_ENTRIES,
  ...(
    [
      ["lose", 10],
      ["regain", 10],
      ["narrow", 4],
      ["same", 3],
      ["fail", 3],
      ["hold", 6],
      ["user", 1],
    ] as const
  ).map(([what, weight]) => ({
    weight,
    arbitrary: fc.record({
      t: one("rights"),
      what: fc.constant<RightsHow>(what),
      object: fc.nat(2),
      scope: fc.nat(1),
    }),
  })),
  {
    weight: 15,
    arbitrary: fc.record({
      t: one("race"),
      group: fc.nat(RACE_GROUPS.length - 1),
      settle: fc.constantFrom<"now" | "later">("now", "later"),
    }),
  },
]
const RIGHTS_STEP: fc.Arbitrary<Step> = fc.oneof(...RIGHTS_ENTRIES)

/**
 * Кроки сигналів (B5b-3, задача 6) поверх кроків знімка прав: сума 60 проти
 * 302, тож сигнали йдуть у кожному прогоні кілька разів, а приєднання,
 * розриви й відмови каналів — у більшості. Кроки прав і решта лишаються:
 * приймач судять ті самі інваріанти й бар'єри.
 */
const SIGNAL_STEP: fc.Arbitrary<Step> = fc.oneof(
  ...RIGHTS_ENTRIES,
  {
    weight: 32,
    arbitrary: fc.record({
      t: one("signal"),
      org: fc.boolean(),
      k,
      op: fc.constantFrom<SignalOp>(
        "update",
        "update",
        "update",
        "create",
        "markDeletion",
        "delete",
        "delete",
        "invalidate",
        "garbage"
      ),
      ch: fc.constantFrom(0, 0, 0, 1),
      ver: fc.constantFrom(0, 0, 1, 2),
      change: fc.boolean(),
    }),
  },
  { weight: 8, arbitrary: fc.record({ t: one("replay"), pick: fc.nat(15) }) },
  {
    weight: 7,
    arbitrary: fc.record({
      t: one("join"),
      ch: fc.nat(CHANNELS.length - 1),
      recovered: fc.boolean(),
    }),
  },
  {
    weight: 5,
    arbitrary: fc.record({ t: one("transport"), ch: fc.nat(CHANNELS.length) }),
  },
  {
    weight: 4,
    arbitrary: fc.record({
      t: one("chanAuth"),
      ch: fc.nat(CHANNELS.length - 1),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      t: one("connAuth"),
      final: fc.constantFrom(false, false, false, true),
    }),
  },
  { weight: 2, arbitrary: fc.record({ t: one("refreshTokens") }) }
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

/**
 * Кроки, що не змінюють ні правди сервера, ні віри клієнта (О3 не рахує їх
 * зміною): плин часу, життєвий цикл вкладки й події каналу, які самі лише
 * вказують читанню час.
 */
const QUIET_STEPS: ReadonlySet<Step["t"]> = new Set([
  "time",
  "due",
  "join",
  "transport",
  "suspend",
  "resume",
])

/** One attempt of a mutation as the model tracks it. */
interface ModelAttempt {
  id: string
  readonly key: Key
  /** The stored scope of the key at the start; `undefined` — no row. */
  readonly scope: string | null | undefined
  /** The length of the read log when the attempt started. */
  readonly startedAt: number
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
  /** A purge or `removed` erased its fields: no `retry`. */
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

/**
 * Пауза після збою, незалежно від ядра (спека §8.4): `min(I, 0,1 × I × 2^(n − 1))`
 * від старту невдалої спроби.
 */
const pauseAfter = (failures: number) =>
  Math.min(runInterval, 0.1 * runInterval * 2 ** (failures - 1))

/**
 * Строк вигляду очима моделі: після збоїв — кінець паузи, інакше мить
 * відмітки + `ageMs`; вигляд, що ще не читався, строку не має.
 */
/** Факти вигляду для строку: збої, початок останнього збою й останнього застосованого читання. */
interface DueFacts {
  readonly failures: number
  readonly failedAt: number | undefined
  readonly refreshedAt: number | undefined
}

const modelDue = (sub: DueFacts, ageMs: number = runInterval) =>
  sub.failures > 0 && sub.failedAt !== undefined
    ? sub.failedAt + pauseAfter(sub.failures)
    : sub.refreshedAt === undefined
      ? Number.POSITIVE_INFINITY
      : sub.refreshedAt + ageMs

/** Тактів із читанням за прогони, що тривають: самотест не має бути порожнім. */
let tickReads = 0

/** Кроків О4 у відкритому вікні спокою за прогони: без них О4 порожній. */
let idleChecks = 0

/** Станів спокою з вимогою, які О2 оцінив за прогони: без них О2 порожній. */
let o2Checks = 0

/** Що О3 бачив у прогоні, який він зачервонив: самотест мутації «хвиля приєднання не читає». */
let o3Report:
  | {
      readonly objects: readonly ObjectName[]
      readonly bound: number
      readonly joins: readonly O3Join[]
      readonly server: readonly O3Change[]
      readonly reads: readonly { at: number; object: ObjectName | undefined }[]
    }
  | undefined

/** Інтервал самотесту хвилі: набагато більший за джитер приєднання, такт хвилю не підміняє. */
const LONG_INTERVAL_MS = 600_000

/** Виглядів, які О3 порівняв із сервером за прогони: без них О3 порожній. */
let o3Checks = 0

/** Скільки разів О3 пропустив вигляд названим станом за прогони: реплей стану його вимагає. */
const o3Skipped = new Map<O3State, number>()
const O3_NAMED_STATES: readonly O3State[] = [
  "first-load-error",
  "discard-bound",
  "stale-object",
  "purged",
  "card-without-duty",
  "section-owner-removed",
  "section-owner-hidden",
  "retry-pause",
]

/**
 * Прогін моделі. Ядро закривається наприкінці (і після збою): модель
 * перевіряє, що після закриття таймерів немає, і наступний прогін не бачить
 * чужих таймерів.
 */
/**
 * Закріплений прогін О2/О3 детермінований: джитер ядра (`Math.random`: перемикання
 * епохи, хвиля приєднання) іде з генератора, що стартує однаково в кожному прогоні.
 */
let pinnedRandom = false
const seededRandom = () => {
  let a = 0x9e3779b9
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

async function runModel(
  steps: readonly Step[],
  preloaded: boolean,
  profile: Profile,
  defects: readonly DefectFlag[] = [],
  schedulerChecks = true,
  rights = false,
  signals = false,
  intervalMs = REVALIDATE_MS,
  // О2 і О3 судять; без них прогін перевіряє лише інваріанти ядра, О1 і О4.
  judge = true
) {
  const held: { core?: CoreSession; reads?: ReadCollector } = {}
  runInterval = intervalMs
  const realRandom = Math.random
  if (pinnedRandom) Math.random = seededRandom()
  try {
    await runModelOn(
      steps,
      preloaded,
      profile,
      defects,
      schedulerChecks,
      rights || signals,
      signals,
      judge,
      (c, reads) => {
        held.core = c
        held.reads = reads
      }
    )
    // О1 над прогоном: кожен запит журналу фейка має подію з кодом і ціллю.
    idleChecks += held.reads?.evaluated() ?? 0
    const unpaired = held.reads?.finish() ?? []
    if (unpaired.length > 0) fail("end", `O1: ${unpaired.join("; ")}`)
  } finally {
    // Прогін, що впав раніше, не лишає збирача на перевірку тесту.
    held.reads?.stop()
    held.core?.close("disposed")
    runInterval = REVALIDATE_MS
    Math.random = realRandom
  }
  const timers = vi.getTimerCount()
  if (timers !== 0) fail("end", `${timers} timers after close`)
}

async function runModelOn(
  steps: readonly Step[],
  preloaded: boolean,
  profile: Profile,
  defects: readonly DefectFlag[],
  schedulerChecks: boolean,
  rights: boolean,
  signals: boolean,
  judge: boolean,
  opened: (core: CoreSession, reads: ReadCollector) => void
) {
  // Канал сигналів (B5b-3): приймач ядра тримає його лише зі знімком прав.
  const transport = createFakeSignalTransport()
  // Порт запису моделі: кожен `run` тримається, доки крок `run` не відповість
  // на нього (будь-який у будь-якому порядку); сервер пише лише тоді.
  const runs: HeldRun[] = []
  let sending: ModelAttempt | undefined
  // Порушення, які модель бачить поза кроком: у слухачі чи в `settled`.
  const asyncViolations: string[] = []
  // Годинник ядра — свій: фальшиві таймери vitest його не рухають, тож крок
  // `time` зсуває його разом із таймерами (інакше відмітки свіжості не старіють).
  let clock = 0
  const advance = (ms: number) => {
    clock += ms
    vi.advanceTimersByTime(ms)
  }
  // ── Знімок прав очима моделі ──
  // Права сервера; RLS фейка ніколи не ширша за них.
  let serverGrant = FULL_GRANT
  // Знімок, який ядро мусить тримати: останній доставлений зі `snapshot`
  // (частина `rights` летить одна за раз, тож останній доставлений — і
  // найновіший відправлений).
  let expectedGrant: Grant | undefined
  // Доставлено знімок іншого користувача: ядро мусить закритися.
  let expectSessionChange = false
  let sessionChanged = false
  const versions = new Map<string, string>()
  const grants = new Map<string, Grant>()
  const versionOf = (g: Grant) => {
    const json = JSON.stringify(snapshotOf(g))
    let version = versions.get(json)
    if (version === undefined) {
      version = (versions.size + 1).toString(16).padStart(64, "0")
      versions.set(json, version)
      grants.set(version, g)
    }
    return version
  }
  // Пара → довжина журналу запитів на мить останнього застосування знімка,
  // що її забороняє: показаний рядок пари — лише з читання, що надійшло на
  // сервер не раніше (Р4: бар'єр і надгробки знову відкритих пар).
  const rightsBarrier = new Map<string, number>()
  const pairKey = (object: ObjectName, scope: string) =>
    `${object}\u0000${scope}`
  // Ключі (`id`), які прохід заміни на цьому кроці мав право прибрати:
  // їхній збережений скоуп перед проходом — пара, яку знімок забороняє.
  let rightsPurgeable = new Set<string>()
  // На цьому кроці застосовано знімок прав: `purged` картки чи ТЧ без purge
  // її ключа — шлях проходу заміни, а не будь-якого іншого purge.
  let rightsPassInStep = false
  // Збережені скоупи рядків і скоуп ТЧ власника K1 на мить перед проходом.
  let capturedScopes = new Map<string, string | null>()
  let capturedLines: string | null | undefined
  // Рядки (`id` і версія) й версія власника ТЧ, що лишились у сховищі одразу
  // після застосування знімка: рядок забороненої пари серед них прохід не
  // прибрав, а не записало читання після бар'єра.
  let keptRows = new Map<string, "first snapshot" | "replacement">()
  let keptLines: { version: number; how: string } | undefined
  // Запити, що осіли (обгортка читання бачить їхнє осідання).
  const resolved = new Set<number>()

  // Обгортка читання сервера: бачить осідання запиту до того, як відповідь
  // дійде до ядра. Одна функція — і порт, і адаптер об'єктів, як
  // `serverFunctionAdapter`: частини пакета й `rights` ідуть одним запитом.
  let sharedRead: ServerPort["read"] | undefined
  const readOf = (f: FakeSource): ServerPort["read"] =>
    (sharedRead ??= async (items) => {
      const request = f.requests.length
      const slot = items.findIndex((item) => item.type === "rights")
      const result = await f.server.read(items)
      resolved.add(request)
      const item = slot < 0 ? undefined : result.items[slot]
      if (item !== undefined) deliveredRights(item)
      return result
    })
  const { fake, core, log, inspect, reads } = setup({
    now: () => clock,
    limits: LIMITS,
    mode: "manual",
    ...(signals ? { signals: transport } : {}),
    ...(rights
      ? {
          rightsSnapshot: true,
          objects: RIGHTS_OBJECTS,
          adapter: (f: FakeSource) => ({
            capabilities: f.adapter.capabilities,
            read: readOf(f),
          }),
          onRightsReplaced: (prev: unknown, next: { rightsVersion: string }) =>
            appliedRights(next.rightsVersion, prev === undefined),
          onSessionChanged: () => {
            sessionChanged = true
            // Закриття осідає кожну неосілу мутацію, не успіхом. Спроба, яку
            // ядро осіло до зміни сесії (відповідь іншого запиту того самого
            // такту), отримує `settled` лише мікрозадачею: її реакція вже в
            // черзі, а позначка — за нею, тож «неосіла» — та, що осідає після
            // закриття.
            const pending = attempts.filter((a) => a.result === undefined)
            queueMicrotask(() => {
              for (const a of pending)
                if (a.result === undefined) a.mustFail = true
            })
            journal.clear()
          },
        }
      : {}),
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
      read: rights ? readOf(f) : (items) => f.server.read(items),
    }),
  })
  for (const flag of defects) inspect.defects.add(flag)
  opened(core, reads)
  const internals = coreInternals(core)
  // Рядки, які вигляд цілі тримає на мить старту читання: обов'язок читання
  // рядка закриває читання вигляду, що саме його тримає.
  reads.setHolds((event) => {
    if (event.target.kind !== "view") return []
    const id = event.target.id
    return SPECS.flatMap((spec, v) =>
      internals.registry.find(spec)?.targetId === id
        ? handles[v]!.getSnapshot().rows.map(
            (row) => `${spec.object}\u0000${row.key}`
          )
        : []
    )
  })
  const o2 = createO2()
  // Крок `suspend` і показ вкладки очима моделі: О2 бачить відкладення прихованою вкладкою.
  let suspends = 0
  let hiddenSince: number | undefined
  let shownAt: number | undefined
  // Спроби лише цього ядра: друге ядро (перегідратація) нумерує цілі з нуля, і
  // його спроби не підтверджують вимог першого.
  const ownAttempts: AttemptEvent[] = []
  const ownNumbers = new Set<number>()
  let joinMark: number | undefined
  const ownEventList: StampedEvent[] = []
  let ownSeen = 0
  const ownEvents = () => {
    for (; ownSeen < reads.events.length; ownSeen++) {
      const e = reads.events[ownSeen]!
      if (e.attempt === undefined || ownNumbers.has(e.attempt))
        ownEventList.push(e)
    }
    return ownEventList
  }
  inspect.watchAttempts((event) => {
    ownAttempts.push(event)
    ownNumbers.add(event.attempt)
  })
  const tracker = trackViews(
    inspect,
    () => clock,
    (id) =>
      [...internals.registry.subsets()].find((x) => x.targetId === id)
        ?.loaded ?? false
  )
  /**
   * Стан свіжості виглядів з `sync()`: один знімок на синхронний відрізок
   * (мікрозадача його скидає), бо `sync()` обходить сховище.
   */
  let liveCache: ReadonlyMap<number, SyncState> | undefined
  const syncedViews = () => {
    if (liveCache === undefined) {
      liveCache = new Map(
        inspect
          .sync()
          .flatMap((state) =>
            state.target.kind === "view"
              ? [[state.target.id, state] as const]
              : []
          )
      )
      queueMicrotask(() => {
        liveCache = undefined
      })
    }
    return liveCache
  }
  /** Вигляд чекає повтору відкинутого завантаження: строк із причиною `retry` у `sync()`. */
  const inRetryPause = (sub: Subset) =>
    syncedViews().get(sub.targetId)?.dueCause === "retry"
  /** Завантаження вигляду в польоті (`flight` ядра) — з `sync()`. */
  const loadFlying = (sub: Subset) =>
    (syncedViews()
      .get(sub.targetId)
      ?.flights.some((f) => f.kind === "load") ??
      false) ||
    // Пауза повтору відкинутого завантаження: `sync()` показує строк з причиною
    // `retry`, але політ завантаження ще триває.
    inRetryPause(sub)
  /** Вимога вигляду за видом — з `sync()`. */
  const requires = (sub: Subset, kind: string) =>
    syncedViews()
      .get(sub.targetId)
      ?.requirements.some((r) => r.kind === kind) ?? false
  /** Сторінок вікна в польоті (кожен напрям — окремий політ). */
  const pagesFlying = (sub: Subset) =>
    syncedViews()
      .get(sub.targetId)
      ?.flights.filter((f) => f.kind === "page").length ?? 0

  // ── Сигнали очима моделі (B5b-3) ──
  // Сигнали, що дійшли до приймача й ще не дали читання: ключ → пари
  // (скоупи каналів), об'єкт → пари з `invalidate` чи нерозібраним тілом.
  // Читання пачки — лише за таким сигналом або як дочитування мінімальної
  // версії після нього; `purge` пари чи ключа знімає їх (0 запитів).
  // Лічильник на пару: два сигнали однієї пари можуть дати дві пачки.
  const owed = new Map<string, Map<string, number>>()
  const owedWhole = new Map<ObjectName, Map<string, number>>()
  const retryLeft = new Map<string, number>()
  // Ключі, чий сигнал уже прочитано: дочитування мінімальної версії
  // дозволені, лише коли модель побачила позначку `minVersion` ключа.
  const awaitingMark = new Set<string>()
  const grantRetries = () => {
    for (const at of [...awaitingMark]) {
      const [object, k] = at.split("\u0000") as [ObjectName, Key]
      if (objectOf(object).rows.get(k)?.stale.minVersion === undefined) continue
      awaitingMark.delete(at)
      retryLeft.set(at, MIN_VERSION_RETRIES)
    }
  }
  // `id` повідомлень, які приймач уже бачив: повтор він відкидає.
  const seenIds = new Set<string>()
  // Об'єкти, ключі яких на цьому кроці читала пачка, і цілі `include`
  // виглядів, що їх перечитує сигнал: запити кроку до них — від сигналу.
  const signalObjects = new Set<ObjectName>()
  // Бюджет приймача (рішення архітекторки): кожен вигляд, який пачка чи
  // хвиля назвала, — рівно одне перечитування за подію (вигляд у польоті —
  // його один хвіст). Перечитування понад названі — не від сигналу: їх судять
  // перевірки планувальника.
  // Хвиля — окремо: межу відкинутих і приховану вкладку вона тримає, як
  // планувальник, а паузу після збою й межу свіжості — ні (Р10).
  const owedRereads = new Map<Subset, { batch: number; wave: number }>()
  // Перечитування на старті кроку й скільки з них уже зараховано сигналу.
  let rereadsAtStep = new Map<Subset, number>()
  const coveredInStep = new Map<Subset, number>()
  /** Every re-read of the view in this step came from a batch (or a wave). */
  const bySignal = (sub: Subset, withWave: boolean) => {
    const delta = tracker.rereads(sub.targetId) - (rereadsAtStep.get(sub) ?? 0)
    if (delta <= 0) return false
    const owed = owedRereads.get(sub) ?? { batch: 0, wave: 0 }
    let covered = coveredInStep.get(sub) ?? 0
    const fromBatch = Math.min(delta - covered, owed.batch)
    owed.batch -= fromBatch
    covered += fromBatch
    if (withWave) {
      const fromWave = Math.min(delta - covered, owed.wave)
      owed.wave -= fromWave
      covered += fromWave
    }
    owedRereads.set(sub, owed)
    coveredInStep.set(sub, covered)
    return covered === delta
  }
  // Ключі, які пачка вже читала в цьому синхронному проході: пачка читає
  // ключ один раз (дедуплікація за ключем).
  let passKeys: Set<string> | undefined
  const owe = (
    into: Map<string, Map<string, number>>,
    at: string,
    scope: string
  ) => {
    const counts = into.get(at) ?? new Map<string, number>()
    counts.set(scope, (counts.get(scope) ?? 0) + 1)
    into.set(at, counts)
  }
  // `stored` — збережені скоупи ключів об'єкта перед `purge`: дочитування
  // мінімальної версії несе скоуп рядка, і `purge` пари скидає його.
  const dropOwedPair = (
    object: ObjectName,
    scope: string,
    stored: ReadonlyMap<Key, string | null>
  ) => {
    for (const [at, counts] of owed)
      if (at.startsWith(`${object}\u0000`)) counts.delete(scope)
    owedWhole.get(object)?.delete(scope)
    for (const [k, at] of stored)
      if (at === scope) {
        retryLeft.delete(id(object, k))
        awaitingMark.delete(id(object, k))
      }
  }
  const storedScopes = (object: ObjectName) =>
    new Map(
      [...objectOf(object).rows.keys()].map(
        (k) => [k, objectOf(object).rows.get(k)!.scope] as const
      )
    )
  const dropOwedKey = (object: ObjectName, key: Key) => {
    owed.delete(id(object, key))
    retryLeft.delete(id(object, key))
    awaitingMark.delete(id(object, key))
  }
  // Сигнал пари, яку модель не надсилала чи яку `purge` уже зняв, — читання
  // без сигналу (0 запитів після `purge`, §8.4).
  const take = (
    counts: Map<string, number> | undefined,
    scopes: readonly (string | null)[]
  ) => {
    let any = false
    for (const scope of scopes) {
      const n = scope === null ? 0 : (counts?.get(scope) ?? 0)
      if (n === 0) continue
      any = true
      if (n === 1) counts!.delete(scope!)
      else counts!.set(scope!, n - 1)
    }
    return any
  }
  inspect.watchSignalReads((object, read) => {
    // Після межі відкинутих кожна відповідь до нової сесії відкидається (§6.2):
    // читання за сигналом на видимій вкладці — запит без шансу. Прихована
    // вкладка не читає й без межі.
    if (
      read.by === "batch" &&
      core.visible &&
      inspect.versionEpochs().unavailable
    )
      asyncViolations.push(
        "a read started by the receiver after the discard limit"
      )
    for (const sub of read.views) {
      const owedOf = owedRereads.get(sub) ?? { batch: 0, wave: 0 }
      owedOf[read.by] += 1
      owedRereads.set(sub, owedOf)
      signalObjects.add(sub.form.object.name)
      for (const step of sub.form.include) signalObjects.add(step.target)
    }
    if (read.by === "wave") return
    if (core.visible && read.keys.length > 0) signalObjects.add(object)
    if (passKeys === undefined) {
      passKeys = new Set()
      queueMicrotask(() => {
        passKeys = undefined
      })
    }
    for (const { key, scopes } of read.keys) {
      const at = id(object, key)
      if (passKeys.has(at))
        asyncViolations.push(`${at}: read twice in one batch`)
      passKeys.add(at)
      if (take(owed.get(at), scopes)) {
        retryLeft.delete(at)
        awaitingMark.add(at)
        continue
      }
      // Дочитування мінімальної версії несе скоуп рядка, а не каналу, тож
      // лічиться лише кількість.
      grantRetries()
      const left = retryLeft.get(at) ?? 0
      if (left > 0) retryLeft.set(at, left - 1)
      else asyncViolations.push(`${at}: a signal read without a signal`)
    }
    if (
      read.invalidated.length > 0 &&
      !take(owedWhole.get(object), read.invalidated)
    )
      asyncViolations.push(`${object}: a whole re-read without a signal`)
    if (
      read.whole &&
      read.invalidated.length === 0 &&
      read.keys.length <= DEFAULT_CORE_LIMITS.keysPerRequest
    )
      asyncViolations.push(`${object}: a whole re-read without an invalidate`)
  })

  // Сервер: дві організації (скоупи), чотири задачі в двох скоупах, ТЧ K1.
  for (const org of ORG_KEYS) fake.insert(ORG, { ref: org })
  KEYS.slice(0, 4).forEach((k, i) =>
    fake.insert(TASK, {
      ref: k,
      org: i < 2 ? S : T,
      title: `t${i + 1}`,
      notes: `n${i + 1}`,
      // Рядок повний для списочної форми: без цього ключ не йшов би в `known`.
      status: null,
      subject: null,
    })
  )
  let created = false
  // Надіслані сигнали (для повторів) і остання версія ключа, яку модель
  // назвала в сигналі (рядок, якого вже немає на сервері).
  const sentSignals: {
    topic: string
    payload: unknown
    object: ObjectName
    scope: string
    key: Key
    op: SignalOp
  }[] = []
  const lastSent = new Map<string, number>()
  let signalSeq = 0
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
  // Індекси журналу запитів доставлених читань, що відповіли на ключ маркером.
  const markerReads = new Map<string, number[]>()
  // Причина показу після `hide`: маркер читання, що почалось до нього, — свій
  // шлях (його не знімає позначки, новішої за старт, спека §6.7).
  const afterHide = (object: ObjectName, k: Key, barrier: number) =>
    (markerReads.get(id(object, k)) ?? []).some((index) => index < barrier)
      ? " (a marker of a read older than the hide)"
      : ""
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
  // нього, а рядки ТЧ власника — лише з читання ТЧ.
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
  // Рядки, які сховище тримає очима моделі: їх дає відповідь читання, їх
  // забирає purge; ключ, вилучений й не прочитаний знову, — власник «відсутній».
  const heldRows = new Set<string>()
  // Скільки разів `purge` вилучав ключ: рядок, що вийшов і повернувся, — новий.
  const purgeCount = new Map<string, number>()
  const markPurged = (at: string) => {
    purgeCount.set(at, (purgeCount.get(at) ?? 0) + 1)
    purgedTargets.add(at)
    heldRows.delete(at)
  }
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
  // Об'єкти з липкою позначкою `stale-client` (§10) і довжина журналу
  // запитів у мить позначки: відтоді запитів об'єкта не буде, а його рядки
  // нічого не показують до кінця прогону.
  const staled = new Map<ObjectName, number>()
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
    for (const row of result.rows) {
      // Маркер не несе рядка: доставлено лише підтвердження ключа `known`.
      if (!("ref" in row)) {
        const marked = read.log.known?.keys[(row as { known: number }).known]
        if (marked !== undefined) {
          const list = markerReads.get(id(object, marked as Key)) ?? []
          list.push(index)
          markerReads.set(id(object, marked as Key), list)
        }
        continue
      }
      rows.set(row.ref as Key, row.version as number)
    }
    for (const k of rows.keys()) heldRows.add(id(object, k))
    for (const [k, version] of rows) {
      const list = deliveries.get(id(object, k)) ?? []
      list.push({ index, object, rows: new Map([[k, version]]) })
      deliveries.set(id(object, k), list)
    }
    // Цілі `include` приходять рядками `included` тієї самої відповіді (Р8):
    // це доставка читання, що почалось у цю мить журналу, як і читання за
    // ключем цілі. Цілі завжди повні, маркерів вони не мають.
    for (const [name, targets] of Object.entries(result.included ?? {})) {
      for (const row of targets) {
        const k = row.ref as Key
        heldRows.add(id(name, k))
        const list = deliveries.get(id(name, k)) ?? []
        list.push({
          index,
          object: name,
          rows: new Map([[k, row.version as number]]),
        })
        deliveries.set(id(name, k), list)
      }
    }
  }

  const deliveredSince = (object: ObjectName, k: Key, index: number) =>
    (deliveries.get(id(object, k)) ?? []).some((d) => d.index >= index)
  const deliveredVersion = (object: ObjectName, k: Key, version: number) =>
    (deliveries.get(id(object, k)) ?? []).some((d) => d.rows.get(k) === version)

  const subscribe = (v: number, label: string) => {
    if (subs[v] !== undefined) return
    const held = [...internals.registry.subsets()]
    const spare = held.some((s) => listenersOf(s) === 0)
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
  // Мить останньої відписки вигляду: рядки вигляду лишаються в сховищі до кінця
  // затримки звільнення, далі їх тримає лише інший вигляд.
  const unsubAt = new Map<number, number>()
  // Утримання `preload` очима моделі: до кінця його строку вигляд тримає ціль.
  const preloadUntil = new Map<number, number>()
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
        held.some((x) => listenersOf(x) === 0)
      )
        fail(label, "preload refused with a spare hold")
    }
    promise?.catch((error: unknown) => errors.push(error))
    if (promise !== undefined)
      // Утримання `preload` складаються: довше не скорочується коротшим.
      preloadUntil.set(
        v,
        Math.max(
          preloadUntil.get(v) ?? -1,
          clock + (short ? 500 : DEFAULT_CORE_LIMITS.preloadTtlMs)
        )
      )
    if (promise !== undefined && v === 4) preloadedSection = true
  }

  /**
   * Ключі рядків, які сховище тримає очима моделі: рядки в публічних знімках
   * виглядів, яких ще тримає підписник, `preload` чи затримка звільнення.
   */
  const heldKeys = () => {
    const keys = new Set<string>()
    for (const [v, handle] of handles.entries()) {
      const held =
        subs[v] !== undefined ||
        (preloadUntil.get(v) ?? -1) > clock ||
        (unsubAt.has(v) && clock < unsubAt.get(v)! + RELEASE_MS)
      if (!held) continue
      for (const row of handle.getSnapshot().rows) keys.add(row.key)
    }
    return keys
  }

  /** Склад видимих списків і номери їхніх завантажень. */
  const lists = () =>
    SPECS.map((spec, v) => {
      if (subs[v] === undefined || !isList(spec) || closed !== undefined)
        return undefined
      const s = internals.registry.find(spec)
      return {
        keys: handles[v]!.getSnapshot().rows.map((r) => r.key),
        // Номер завантаження в польоті й номер останнього, що почалось.
        flight:
          s !== undefined && loadFlying(s)
            ? tracker.loads(s.targetId)
            : undefined,
        loads: s === undefined ? 0 : tracker.loads(s.targetId),
        subset: s,
        // Сторінки вікна в польоті: вони виправдовують ріст складу.
        paging: s === undefined ? 0 : pagesFlying(s),
      }
    })

  const objectOf = (name: ObjectName) => internals.objects.get(name)!

  /** Скоуп рядка сервера тієї версії: організація — сама свій скоуп. */
  const scopeAt = (object: ObjectName, k: Key, version: number) =>
    object === ORG
      ? k
      : (fake.row(TASK, k, version)?.values.org as string | undefined)
  /** Бар'єр знімка над парою рядка цієї версії, `undefined` — пари не забороняли. */
  const barrierOf = (object: ObjectName, k: Key, version: number) => {
    const scope = scopeAt(object, k, version)
    return scope === undefined
      ? undefined
      : rightsBarrier.get(pairKey(object, scope))
  }
  /**
   * Рядок цієї версії забороненої пари, якого не приніс жоден дозвіл після
   * бар'єра: ні читання, що надійшло на сервер після застосування знімка,
   * ні відповідь `run` спроби, що почалась після нього.
   */
  const deniedRow = (object: ObjectName, k: Key, version: number) => {
    const barrier = barrierOf(object, k, version)
    if (barrier === undefined) return false
    const read = (deliveries.get(id(object, k)) ?? []).some(
      (d) => d.index >= barrier && d.rows.get(k) === version
    )
    const run = runDeliveredAt.get(`${id(object, k)}\u0000${version}`)
    return !read && (run === undefined || run < barrier)
  }
  /** Рядки ТЧ власника цієї версії — лише з читання ТЧ після бар'єра його пари. */
  const deniedLines = (owner: Key, ownerVersion: number) => {
    const barrier = barrierOf(TASK, owner, ownerVersion)
    return (
      barrier !== undefined &&
      !sectionDeliveries.some(
        (d) =>
          d.owner!.key === owner &&
          d.owner!.version === ownerVersion &&
          d.index >= barrier
      )
    )
  }

  /**
   * RLS сервера за правами — окремо для кожного об'єкта, поверх видимості
   * кроків моделі: RLS не ширша за права, тож читання після застосування
   * знімка забороненої пари її не приносить, а дозволена пара іншого
   * об'єкта в тому самому скоупі повертається.
   */
  const setGrant = (g: Grant) => {
    serverGrant = g
    fake.rightsSnapshot = snapshotOf(g)
    fake.rightsVersion = versionOf(g)
    for (const object of [TASK, ORG]) {
      const allowed = SCOPES.filter((x) => !grantDenies(g, object, x))
      fake.setObjectScopes(
        object,
        allowed.length === SCOPES.length ? undefined : allowed
      )
    }
  }

  /** Відповідь `rights` дійшла до ядра: знімок, який воно мусить тримати. */
  function deliveredRights(item: { ok: boolean; value?: unknown }) {
    if (closed !== undefined || sessionChanged || !item.ok) return
    const value = item.value as { rightsVersion: string; snapshot?: unknown }
    // Підтвердження `known` знімка не змінює.
    if (value.snapshot === undefined) return
    const g = grants.get(value.rightsVersion)
    if (g === undefined) {
      asyncViolations.push(`rights: an answer the model never gave`)
      return
    }
    if (expectedGrant !== undefined && expectedGrant.user !== g.user)
      expectSessionChange = true
    else expectedGrant = g
  }

  // Сховище на мить перед проходом заміни (запис між доставкою знімка й
  // застосуванням теж судиться): за цими скоупами прохід судить пари.
  inspect.watchRightsPass(() => {
    capturedScopes = new Map()
    for (const object of [TASK, ORG]) {
      const o = objectOf(object)
      for (const k of o.rows.keys())
        capturedScopes.set(id(object, k), o.rows.get(k)!.scope)
    }
    capturedLines = objectOf(TASK).sections.get(K1, "lines")?.scope
  })

  /**
   * Ядро застосувало знімок: бар'єр кожної пари, яку він забороняє, і ключі,
   * які прохід мав право прибрати, — лише ті, чий збережений скоуп перед
   * проходом він забороняє (прохід, що прибрав дозволену пару, —
   * дефект), та власник ТЧ без відомого скоупу.
   */
  function appliedRights(version: string, first: boolean) {
    const g = grants.get(version)
    if (g === undefined) {
      asyncViolations.push(`rights: applied a snapshot the model never gave`)
      return
    }
    rightsPassInStep = true
    const at = fake.log.length
    for (const object of [TASK, ORG])
      for (const scope of SCOPES)
        if (grantDenies(g, object, scope))
          rightsBarrier.set(pairKey(object, scope), at)
    for (const [key, scope] of capturedScopes) {
      const [object] = key.split("\u0000") as [ObjectName]
      // Прохід прибирає збережені пари, які знімок забороняє: їхні сигнали
      // приймач скидає (`purged`).
      if (scope !== null && grantDenies(g, object, scope))
        dropOwedPair(
          object,
          scope,
          new Map(
            [...capturedScopes].flatMap(([at, stored]) => {
              const [o, k] = at.split("\u0000") as [ObjectName, Key]
              return o === object ? [[k, stored] as const] : []
            })
          )
        )
      if (grantDenies(g, object, scope)) {
        rightsPurgeable.add(key)
        markPurged(key)
      }
    }
    if (
      capturedLines === "unknown" ||
      (capturedLines !== undefined && grantDenies(g, TASK, capturedLines))
    )
      markPurged(id(TASK, K1))
    // Що лишилось у сховищі після проходу.
    const how = first ? "first snapshot" : "replacement"
    keptRows = new Map()
    for (const object of [TASK, ORG]) {
      const o = objectOf(object)
      for (const k of o.rows.keys())
        keptRows.set(`${id(object, k)}\u0000${o.rows.get(k)!.version}`, how)
    }
    const lines = objectOf(TASK).sections.get(K1, "lines")
    keptLines =
      lines === undefined ? undefined : { version: lines.ownerVersion, how }
  }

  /** Як рядок забороненої пари опинився в сховищі: шлях дефекту. */
  const deniedHow = (object: ObjectName, k: Key, version: number) => {
    const kept = keptRows.get(`${id(object, k)}\u0000${version}`)
    return kept === undefined
      ? "written past the rights barrier"
      : `kept by the rights pass (${kept})`
  }
  const deniedLinesHow = (ownerVersion: number) =>
    keptLines?.version === ownerVersion
      ? `kept by the rights pass (${keptLines.how})`
      : "written past the rights barrier"

  /** Показаний рядок (зі значеннями чи схований) проти сервера й позначок. */
  const checkRow = (
    label: string,
    object: ObjectName,
    row: RowView,
    where: string
  ) => {
    const at = `${where} ${object}/${row.key}`
    if (row.state === "removed") return
    if (staled.has(object)) {
      if (Object.keys(row.values).length > 0)
        fail(label, `${at}: values of a stale-client object`)
      return
    }
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
      fail(
        label,
        `${at}: shown after hide without a later read${afterHide(object, row.key, hidden)}`
      )
    // Показаний рядок (і ціль `refs`) прибраного `purge` ключа — лише з
    // читання, що почалось після нього (П12).
    const purged = purgeBarrier.get(id(object, row.key))
    if (purged !== undefined && !deliveredSince(object, row.key, purged))
      fail(label, `${at}: shown after purge without a later read`)
    // Версія — з доставленого читання або з відповіді `run` живої спроби;
    // бар'єри (`hide`, `purge`, `removed`) знімає лише читання: write-back
    // позначок не знімає й прибраного не воскрешає.
    if (
      !deliveredVersion(object, row.key, row.version) &&
      !runDelivered.has(`${id(object, row.key)}\u0000${row.version}`)
    )
      fail(label, `${at}: version ${row.version} never delivered`)
    // Пара, яку забороняє застосований знімок: рядок — лише з дозволу після
    // нього (Р4).
    if (deniedRow(object, row.key, row.version))
      fail(label, `${at}: shown, ${deniedHow(object, row.key, row.version)}`)
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
    // `loading` без даних — спільний знімок без рядків: ознаку він не несе,
    // а перше ж відмовлене читання дає `error` з `isStale`.
    if (
      staled.has(spec.object) &&
      snap.status !== "purged" &&
      snap.status !== "loading"
    ) {
      if (snap.isStale !== true)
        fail(label, `${where}: a stale-client object, the view is not isStale`)
      if ((snap.section?.lines.length ?? 0) > 0)
        fail(label, `${where}: lines of a stale-client object`)
    }
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
        fail(
          label,
          rightsPassInStep
            ? `${where}: purged by the rights pass of an allowed pair`
            : `${where}: purged without a purge of its key`
        )
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
      if (snap.section.lines.length > 0 && deniedLines(owner, version))
        fail(label, `${where}: lines shown, ${deniedLinesHow(version)}`)
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
    grantRetries()
    if (errors.length > 0)
      fail(label, `unexpected rejection ${String(errors[0])}`)
    if (rights && closed === undefined) {
      // Знімок іншого користувача закриває ядро `session-changed` (Р7) — і
      // лише він.
      if (sessionChanged !== expectSessionChange)
        fail(
          label,
          sessionChanged
            ? "rights: session-changed without a snapshot of another user"
            : "rights: a snapshot of another user did not close the core"
        )
      if (sessionChanged) {
        closed = {
          frames,
          sent: fake.log.length,
          snapshot: handles[0]!.getSnapshot(),
        }
        if (
          closed.snapshot.status !== "purged" ||
          closed.snapshot.reason !== "session-changed"
        )
          fail(label, "rights: another user, the core is not session-changed")
      } else {
        const held = core.rights()?.rightsVersion
        const want =
          expectedGrant === undefined ? undefined : versionOf(expectedGrant)
        if (held !== want)
          fail(
            label,
            `rights: the core holds ${String(held)}, the model ${String(want)}`
          )
      }
    }
    for (const [object, mark] of staled) {
      for (const sent of fake.log.slice(mark)) {
        const target = sent.query?.object
        if (target !== undefined && `${target.kind}.${target.name}` === object)
          fail(label, `${object}: a read went out after the stale-client mark`)
      }
    }
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
            // Перехід у `removed` стирає поля мутації ключа, що вже
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
            fail(
              label,
              `${at}: values after hide without a later read${afterHide(name, k, hidden)}`
            )
          const barrier = removedBarrier.get(id(name, k))
          if (barrier !== undefined && !deliveredSince(name, k, barrier))
            fail(label, `${at}: values after removed without a later read`)
          if (deniedRow(name, k, e.version))
            fail(label, `${at}: stored, ${deniedHow(name, k, e.version)}`)
        }
      }
      // Слот, що зник зі сховища, лишає бар'єр; позначку стану — ні.
      for (const key of [...wasRemoved.keys()]) {
        const [object, k] = key.split("\u0000") as [ObjectName, Key]
        if (object === name && o.rows.get(k) === undefined)
          wasRemoved.delete(key)
      }
    }

    const stored = objectOf(TASK).sections.get(K1, "lines")
    if (
      stored !== undefined &&
      stored.lines.length > 0 &&
      deniedLines(K1, stored.ownerVersion)
    )
      fail(label, `${K1}: lines stored, ${deniedLinesHow(stored.ownerVersion)}`)

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
   * `hasNewRows` (Р4): відповідь читань, що стартували до знімка, ставить
   * ознаку лише рядком поза складом вигляду, якого знімок не забороняє, —
   * інакше ознака виказала б, що заборонений рядок існує. `reads` — читання,
   * на які модель щойно відповіла.
   */
  const newsBefore = () =>
    new Map(
      [...internals.registry.subsets()].map((sub) => [
        sub,
        { news: sub.hasNewRows, layout: new Set(sub.layout) },
      ])
    )
  const checkNews = (
    label: string,
    before: ReturnType<typeof newsBefore>,
    reads: readonly FakeRead[]
  ) => {
    if (closed !== undefined) return
    for (const sub of internals.registry.subsets()) {
      const was = before.get(sub)
      if (!sub.hasNewRows || was?.news === true) continue
      const object = sub.form.object.name
      const fresh = reads.some((read) => {
        const index = fake.log.indexOf(read.log)
        return [...deliveries.values()].some((list) =>
          list.some(
            (d) =>
              d.index === index &&
              d.object === object &&
              [...d.rows].some(
                ([k, version]) =>
                  was?.layout.has(k) !== true &&
                  (barrierOf(object, k, version) ?? -1) <= index
              )
          )
        )
      })
      if (!fresh)
        fail(
          label,
          `view ${sub.form.spec.kind} of ${object}: hasNewRows from rows of a denied pair`
        )
    }
  }

  /**
   * Вікно: знімок несе ланцюжок вікна, а ланцюжок не
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
   * `hide` власника, перечитана: є читання ТЧ власника, надіслане після `hide`, або
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
    if (loadFlying(s)) return
    heldInFlight = false
    // Сесія після межі відкинутих відповідей не читає; власник
    // `removed` рядків не показує, і читання ТЧ їх не поверне.
    if (inspect.versionEpochs().unavailable) return
    // Несумісний об'єкт не перечитується взагалі (§10).
    if (staled.has(TASK)) return
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

  // ── Запис ──
  // Журнал моделі: мутація ключа, доки її не прибрав успіх, дія чи `close`.
  const journal = new Map<Key, ModelEntry>()
  const attempts: ModelAttempt[] = []
  const attemptById = new Map<string, ModelAttempt>()
  // Версії, які принесла відповідь `run` живої спроби: джерело показаного
  // рядка поряд із читаннями, але не зняття бар'єрів.
  const runDelivered = new Set<string>()
  // Те саме з довжиною журналу запитів на старті спроби: бар'єр знімка знімає
  // лише відповідь спроби, що почалась після нього.
  const runDeliveredAt = new Map<string, number>()
  let checks = 0
  // Епоха primary, на який іде `run`.
  let primaryEpoch = EA

  /** Starts tracking an attempt; `sending` links it to the `run` it sends. */
  const begin = (key: Key) => {
    const attempt: ModelAttempt = {
      id: "",
      key,
      scope: objectOf(TASK).rows.get(key)?.scope,
      startedAt: fake.log.length,
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
    // Скасована спроба нічого не пише й рядків не віддає.
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
   * рядку, стерті поля після `purge` чи `removed`.
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
            : attempt.result.error instanceof DataError
              ? fail(label, `${k}: a journal mutation settled with a DataError`)
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
        // `hidden` і `removed` мають пріоритет показу над станом мутації;
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
        // Дії за станом: `retry` — лише `failed`, `dismiss` — лише
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
    // Сервер не пише рядка пари, якої права не дозволяють.
    if (
      rights &&
      grantDenies(serverGrant, TASK, fake.row(TASK, k)!.values.org as string)
    ) {
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
          runDeliveredAt.set(
            `${id(TASK, k)}\u0000${attempt!.runVersion}`,
            attempt!.startedAt
          )
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
        : // Без `run` у дорозі крок стає межею відкинутих відповідей (сесія
          // вичерпана, планувальник не читає): ваги генератора не зсуваються.
          { t: "exhaust" }
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
  if (rights) setGrant(FULL_GRANT)

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
    // Читання доходить до фейка мікрозадачею збирача: спершу `flush`.
    for (let i = 0; i < 50; i++) {
      await flush()
      if (fake.pending.length === 0) break
      while (fake.pending.length > 0) {
        const read = fake.take()
        read.answer()
        record(read)
      }
      await flush()
    }
    check("preload", 0)
  }

  // Завантаження, які почала дія користувача (підписка, прокрутка,
  // `refresh`, `showNew`, `preload`, початкове завантаження), і чи належить
  // користувачу наступне завантаження з черги. Правило стабільності
  // виправдовує зміну складу лише завантаженням користувача. Модель веде це
  // сама (рішення архітекторки 23.11, 2а): номер завантаження — лічильник
  // подій «спробу розпочато» (`view-facts.ts`), політ і черга — з `sync()`,
  // перезапуск — з наслідку «після purge»; полів `Subset` не читає.
  const userLoads = new Map<number, Set<number>>()
  const lastLoads = new Map<number, number>()
  const userNext = new Set<number>()
  const lastFlight = new Map<number, number | undefined>()
  const noteGens = (userStep: boolean) => {
    for (const sub of internals.registry.subsets()) {
      const id = sub.targetId
      const state = syncedViews().get(id)
      const loads = tracker.loads(id)
      // Пауза повтору відкинутого завантаження — те саме завантаження в польоті
      // (`sync()` показує її строком із причиною `retry`): без неї кінець польоту
      // користувача здається розривом, і його повтор перестає бути його.
      const flight =
        state?.flights.some((f) => f.kind === "load") ||
        state?.dueCause === "retry"
          ? loads
          : undefined
      const mineSet = userLoads.get(id) ?? new Set<number>()
      // Заміна знімка прав посеред кроку відповіді перезапускає завантаження
      // користувача в польоті (Р5а — перше завантаження, прохід — `purge`
      // пари): його спроба осіла «після purge» (покоління підняли), і новий
      // політ почався за той самий крок — це те саме завантаження
      // користувача. Два завантаження за крок після польоту користувача — теж
      // його ланцюжок. Системне завантаження після осілого польоту — одне й
      // без перезапуску.
      const was = lastFlight.get(id)
      const restarted =
        rights &&
        was !== undefined &&
        mineSet.has(was) &&
        flight !== undefined &&
        flight !== was &&
        (loads >= was + 2 || tracker.lost(id, was))
      lastFlight.set(id, flight)
      const mine =
        userStep ||
        userNext.has(id) ||
        (flight !== undefined && mineSet.has(flight)) ||
        restarted
      const last = lastLoads.get(id) ?? 0
      if (loads > last) {
        if (mine) for (let g = last + 1; g <= loads; g++) mineSet.add(g)
        userLoads.set(id, mineSet)
        lastLoads.set(id, loads)
      }
      const queued = state?.queued.some((q) => q.kind === "load") ?? false
      if (queued && mine) userNext.add(id)
      else if (!queued) userNext.delete(id)
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
    purgeStep: boolean,
    // Ключі, які прохід заміни знімка прав мав право прибрати на кроці.
    rightsGone: ReadonlySet<string> = new Set()
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
      const mine = userLoads.get(a.subset!.targetId)
      const touched = [b.flight]
      for (let g = b.loads + 1; g <= a.loads; g++) touched.push(g)
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
      // Сума двох дозволених причин одного кроку: сторінка в польоті лягла, а
      // `purge` чи прохід знімка прав прибрав ключі (відповідь сторінки
      // осідає в `settleRights` того самого кроку). Після віднімання ключів,
      // дозволених причиною кроку, старі ключі лишаються префіксом чи
      // суфіксом нового складу з приростом не більшим за сторінки в польоті.
      const allowedGone = (x: Key) =>
        !a.keys.includes(x) &&
        (purgeStep || rightsGone.has(id(SPECS[v]!.object, x)))
      const rest = b.keys.filter((x) => !allowedGone(x))
      const restGrown = a.keys.length - rest.length
      if (
        rest.length < b.keys.length &&
        b.paging > 0 &&
        restGrown > 0 &&
        restGrown <= b.paging * LIMITS.windowPage &&
        (a.keys.slice(0, rest.length).join() === rest.join() ||
          a.keys.slice(restGrown).join() === rest.join())
      )
        return
      // purge лише прибирає ключі, порядок решти той самий; прохід знімка
      // прав — лише ключі пар, які знімок забороняє.
      const kept = b.keys.filter((x) => a.keys.includes(x))
      const removedOnly =
        kept.length === a.keys.length && kept.every((x, i) => x === a.keys[i])
      if (purgeStep && removedOnly) return
      if (removedOnly && rightsGone.size > 0) {
        const object = SPECS[v]!.object
        const wrong = b.keys.find(
          (x) => !a.keys.includes(x) && !rightsGone.has(id(object, x))
        )
        if (wrong === undefined) return
        fail(
          label,
          `view ${v}: the rights pass removed ${object}/${wrong} of an allowed pair`
        )
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
   * Перегідратація: знімок ядра йде в нове ядро над
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
          read: (items) => fake.server.read(items),
        }
      ),
      index: fake.index,
      limits: LIMITS,
      log: (entry) => {
        if (entry.kind === "listener-failed") errors.push(entry.error)
      },
    })
    collectCore(next, fake)
    const nextInspect = inspectCore(next)
    // Дефекти основного ядра нового не стосуються: їх ловить своя перевірка
    // (`CAUGHT_BY`), а не перегідратація; нове ядро ламає лише власний.
    if (defects.includes("hydrate-without-revalidate"))
      nextInspect.defects.add("hydrate-without-revalidate")
    if (defects.includes("late-hydrated-not-reread"))
      nextInspect.defects.add("late-hydrated-not-reread")
    if (defects.includes("hydrated-row-not-reread"))
      nextInspect.defects.add("hydrated-row-not-reread")
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
        // Новий рантайм не несе позначки старого: вигляд несумісного об'єкта
        // у ньому не `isStale`; безпеку його знімка перевірено вище.
        if (staled.has(SPECS[v]!.object)) continue
        sameViews(label, v, handles[v]!.getSnapshot(), next)
      }
      // Звірка: видимі вигляди — підписані; кожен другий підписується вже
      // після `endHydration` (умовне монтування, §6.6) і мусить читатися сам.
      const subscribeHeld = (late: boolean, skip: readonly Subset[] = []) =>
        held.flatMap((sub, i) => {
          if ((i % 2 === 1) !== late || skip.includes(sub)) return []
          const v = SPECS.findIndex(
            (spec) => JSON.stringify(spec) === JSON.stringify(sub.form.spec)
          )
          return [next.view(SPECS[v]!).subscribe(() => {})]
        })
      const unsubscribe = subscribeHeld(false)
      next.endHydration()
      // Картка над рядком, який тримає лише непідписаний гідрований список
      // (довіра — факт рядка, §6.6): список лишається без підписки, тож рядок
      // читає тільки сама картка.
      const donor = held.find(
        (sub, i) =>
          i % 2 === 1 &&
          sub.form.spec.kind !== "card" &&
          sub.form.spec.kind !== "section" &&
          !staled.has(sub.form.object.name) &&
          sub.layout.length > 0 &&
          !held.some(
            (other) =>
              other.form.spec.kind === "card" &&
              other.form.spec.object === sub.form.object.name &&
              other.form.spec.key === sub.layout[0]
          )
      )
      const donorCard: ViewSpec | undefined =
        donor === undefined
          ? undefined
          : {
              kind: "card",
              object: donor.form.object.name,
              key: donor.layout[0]!,
            }
      if (donorCard !== undefined)
        unsubscribe.push(next.view(donorCard).subscribe(() => {}))
      unsubscribe.push(
        ...subscribeHeld(true, donor === undefined ? [] : [donor])
      )
      for (let round = 0; round < 20; round++) await flush()
      const after = nextInspect.violations()
      if (after.length > 0) fail(label, `after reconcile: ${after.join("; ")}`)
      for (const sub of held) {
        if (sub === donor) continue
        const v = SPECS.findIndex(
          (spec) => JSON.stringify(spec) === JSON.stringify(sub.form.spec)
        )
        if (staled.has(SPECS[v]!.object)) continue
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
      // Дефект `late-hydrated-not-reread` ловить перевірка вище; ця — лише свій.
      if (
        donorCard !== undefined &&
        !defects.includes("late-hydrated-not-reread")
      ) {
        const snap = next.view(donorCard).getSnapshot()
        const row = snap.rows[0]
        if (row !== undefined && row.state !== "removed") {
          const at = `after hydrate: card over a hydration-only row ${row.key}`
          if (row.hidden === true) fail(label, `${at} still hidden`)
          const server = fake.row(donorCard.object, row.key)
          if (server === undefined || server.version !== row.version)
            fail(label, `${at}: version ${row.version}, server differs`)
        }
      }
      for (const stop of unsubscribe) stop()
    } finally {
      next.close("disposed")
      reads.retain(mine)
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
    // Слот `hidden` лишає місце, а не факти рядка: його `version` і `stale`
    // знімок не несе (гідрований рядок має умовну версію 0), решта
    // порівнюється повністю.
    const shape = (row: RowView): unknown =>
      row.state === "removed"
        ? { key: row.key, state: "removed" }
        : {
            key: row.key,
            version: row.hidden === true ? undefined : row.version,
            values: row.values,
            staleFields: row.staleFields,
            hidden: row.hidden,
            stale: row.hidden === true ? undefined : row.stale,
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
      // Журнал порожній (`rehydrate` інакше лише перевіряє відмову), тож
      // стан рядка однаковий на обох боках.
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

  // ---------------------------------------------------- планувальник (§6.7)
  // Сервер недоступний ще стільки кроків: кожне читання кроку падає.
  let outage = 0
  // Початок безперервної «здорової» видимості вигляду для межі збіжності.
  const healthySince = new Map<Subset, number>()
  // Явний `revalidate` над виглядом у польоті: хвіст мусить перечитати його
  // після осідання (Р7); значення — лічильник перечитувань на виклик.
  const tailWatch = new Map<Subset, { rereads: number; visibleOnly: boolean }>()
  let lastResumeClock: number | undefined

  /** Факти строку вигляду з подій спроб (`view-facts.ts`), а не з полів `Subset`. */
  const dueOf = (sub: Subset): DueFacts => ({
    failures: tracker.failures(sub.targetId),
    failedAt: tracker.failedAt(sub.targetId),
    refreshedAt: tracker.refreshedAt(sub.targetId),
  })
  /** Підписник вигляду очима моделі: її власні `subscribe` / `unsub` (один підписник на вигляд). */
  const listenersOf = (sub: Subset) =>
    subs[SPECS.indexOf(sub.form.spec)] === undefined ? 0 : 1
  /** `setVisible` моделі за ідентифікатором цілі: нове утримання вигляду починає без відмітки. */
  const visibleBy = new Map<number, boolean>()
  /** Вигляд бачить користувач: сам чи через змонтований вигляд-носій. */
  const shown = (sub: Subset) =>
    (visibleBy.get(sub.targetId) ?? listenersOf(sub) > 0) &&
    (sub.form.spec.kind !== "section" || listenersOf(sub) > 0)
  /** Завантаження чи системне перечитування вигляду в польоті (сторінка — окремо). */
  const inFlight = (sub: Subset) =>
    (syncedViews()
      .get(sub.targetId)
      ?.flights.some((f) => f.kind !== "page") ??
      false) ||
    inRetryPause(sub)
  const exhausted = (sub: Subset) =>
    sub.status === "error" && sub.error === EPOCH_UNAVAILABLE
  // Після межі відкинутих планувальник не читає жодного вигляду до нової
  // сесії (спека §6.2): не лише того, що сам у `unavailable`. Явне читання
  // (`revalidate`, `resume()`) цього правила не знає.
  const sessionDown = () => inspect.versionEpochs().unavailable
  /** Ціль планувальника очима моделі (Р3), не функцією ядра. */
  const isTarget = (sub: Subset, tab: boolean = core.visible) =>
    tab &&
    sub.alive &&
    !sub.purged &&
    sub.loaded &&
    shown(sub) &&
    !inFlight(sub) &&
    !exhausted(sub) &&
    !sessionDown() &&
    !staled.has(sub.form.object.name) &&
    Number.isFinite(modelDue(dueOf(sub)))
  /** Об'єкти, чий відкладений строк (перемикання епохи, відкинута відповідь) настав. */
  const dueObjects = (at: number) =>
    new Set(
      [...inspect.scheduledDue()].flatMap(([name, due]) =>
        due <= at ? [name] : []
      )
    )
  const readsObject = (sub: Subset, names: ReadonlySet<ObjectName>) =>
    names.has(sub.form.object.name) ||
    sub.form.include.some((step) => names.has(step.target))

  /** Вигляд у паузі після збою: до її кінця його не читає ні такт, ні `resume()`. */
  const inPause = (sub: Subset, at: number) => {
    const due = dueOf(sub)
    return due.failures > 0 && due.failedAt !== undefined && at < modelDue(due)
  }

  /** Вигляд, якого читання з межею `minAge` не бере (спека §6.7). */
  const young = (sub: Subset, at: number, minAge: number) => {
    const due = dueOf(sub)
    return (
      inFlight(sub) ||
      exhausted(sub) ||
      (due.failures > 0 && due.failedAt !== undefined
        ? at < modelDue(due)
        : // Вигляд, що ще не читався (картка зі сховища, гідратований),
          // строку не має (Р3): його рядок свіжіє виглядом-носієм.
          due.refreshedAt === undefined || at - due.refreshedAt < minAge)
    )
  }

  /** Інваріанти планувальника після кроку (бриф задачі 6). */
  const checkScheduler = (label: string) => {
    if (closed !== undefined) return
    const live = [...internals.registry.subsets()]
    const timers = inspect.serviceSizes().schedulerTimers
    if (timers > 1) fail(label, `scheduler timers ${timers} > 1`)
    const targets = live.filter((sub) => isTarget(sub))
    const deferred =
      !sessionDown() &&
      [...inspect.scheduledDue().keys()].some((name) => !staled.has(name))
    if (core.visible && (targets.length > 0 || deferred) && timers !== 1)
      fail(label, "scheduler has no timer on a visible tab with a target")
    // Межа збіжності: вигляд, безперервно видимий на видимій вкладці й без
    // збою, перечитується не пізніше `max(від, строк) + I` (читання, що йде,
    // робить вигляд не-ціллю: `rt` тут — від відправки до відповіді).
    for (const sub of healthySince.keys())
      if (!live.includes(sub)) healthySince.delete(sub)
    for (const sub of live) {
      if (!isTarget(sub)) {
        healthySince.delete(sub)
        continue
      }
      const since = healthySince.get(sub) ?? clock
      healthySince.set(sub, since)
      if (clock > Math.max(since, modelDue(dueOf(sub))))
        fail(
          label,
          `a view was not re-read within its ${tracker.failures(sub.targetId) > 0 ? "failure pause" : "interval"}: ${sub.form.object.name} ${sub.form.spec.kind}`
        )
    }
    for (const [sub, watch] of tailWatch) {
      if (tracker.rereads(sub.targetId) > watch.rereads) {
        tailWatch.delete(sub)
        continue
      }
      if (inFlight(sub)) continue
      // Хвіст не стартує для вигляду, який вибув: прибраний, не завантажений,
      // не видимий (для `visibleOnly`), несумісного об'єкта чи після межі.
      tailWatch.delete(sub)
      if (
        sub.alive &&
        !sub.purged &&
        sub.loaded &&
        (!watch.visibleOnly || shown(sub)) &&
        (sub.form.spec.kind !== "section" || listenersOf(sub) > 0) &&
        !exhausted(sub) &&
        !inspect.versionEpochs().unavailable &&
        !staled.has(sub.form.object.name)
      )
        fail(
          label,
          "an explicit revalidate left no tail pass for a view in flight"
        )
    }
  }

  /**
   * Частина `rights` у польоті (утримана чи в запиті з читаннями, що чекають
   * відповіді) відклала б новий знімок за наступні відповіді: модель дає їй
   * осісти, відповідаючи на читання її запиту станом зараз.
   */
  const settleRights = async () => {
    for (let round = 0; round < 20; round++) {
      fake.holdRights = false
      fake.releaseRights()
      const stuck = new Set(
        fake.rightsLog.flatMap((r) =>
          resolved.has(r.request) ? [] : [r.request]
        )
      )
      if (stuck.size === 0) return
      for (const read of fake.pending.filter((r) => stuck.has(r.log.request))) {
        fake.take((r) => r === read).answer()
        record(read)
      }
      await flush()
    }
  }

  /**
   * `purge` пари (скоуп, об'єкт) з обліком моделі (надгробки спроб, стерті
   * поля, бар'єри П12); `undefined` — ядро закрите.
   */
  /** Sends a signal; one the receiver holds the channel of is owed a read. */
  const emit = (
    topic: string,
    payload: unknown,
    object: ObjectName,
    scope: string,
    key: Key,
    op: SignalOp
  ) => {
    // Нерозібране тіло `id` не дає: приймач не відкидає його повтору.
    const message = (payload as { id: string }).id
    if (
      closed === undefined &&
      transport.subscribed().has(topic) &&
      (op === "garbage" || !seenIds.has(message))
    ) {
      if (op !== "garbage") seenIds.add(message)
      if (op === "invalidate" || op === "garbage") owe(owedWhole, object, scope)
      else owe(owed, id(object, key), scope)
    }
    transport.emit(topic, payload)
  }

  const purgePair = (
    object: ObjectName,
    scope: string,
    stepStart: number,
    // Хто робить `purge`: модель сама чи приймач (відмова `auth` каналу).
    act = () => commit((w) => w.purge(object, { scope }))
  ) => {
    const held = [...objectOf(object).rows.keys()]
    const stored = storedScopes(object)
    const hadLines =
      object === TASK && objectOf(TASK).sections.get(K1, "lines") !== undefined
    act()
    if (closed !== undefined) return undefined
    dropOwedPair(object, scope, stored)
    const purgedKeys = {
      object,
      keys: held.filter((k) => objectOf(object).rows.get(k) === undefined),
    }
    if (object === TASK) {
      // Надгробок пари — для спроби зі скоупом пари на старті; надгробок
      // ключа — для прибраного ключа. Поля стирає запис цього скоупу чи
      // невідомого.
      const buried = new Set(purgedKeys.keys)
      for (const a of attempts)
        if (a.result === undefined && (a.scope === scope || buried.has(a.key)))
          a.purged = true
      for (const entry of journal.values()) {
        const at = entry.attempt.scope
        if (at === undefined || at === scope) entry.erased = true
      }
    }
    for (const k of purgedKeys.keys) markPurged(id(object, k))
    // Власник без шапки в сховищі, чиї рядки ТЧ прибрано, — прибраний;
    // з шапкою (в іншому скоупі) доступ не втрачено.
    if (
      hadLines &&
      objectOf(TASK).sections.get(K1, "lines") === undefined &&
      objectOf(TASK).rows.get(K1) === undefined
    )
      markPurged(id(TASK, K1))
    // П12: ключ, якого після purge у сховищі немає, повертає лише
    // читання, що почалось після нього.
    for (const k of object === TASK ? KEYS : ORG_KEYS) {
      if (objectOf(object).rows.get(k) === undefined)
        purgeBarrier.set(id(object, k), stepStart)
    }
    if (object === TASK) barrierSections(stepStart)
    return purgedKeys
  }

  // ── О3: правда сервера очима клієнта й зміни, за якими модель веде межі ──
  /**
   * Рядок, який сервер віддав би клієнтові: його видимість (RLS моделі) і
   * права користувача входять у правду, а не лише наявність рядка.
   */
  const truthRow = (object: ObjectName, k: Key) => {
    const row = fake.row(object, k)
    if (row === undefined) return undefined
    const scope =
      object === ORG
        ? k
        : ((row.values.org as string | null | undefined) ?? null)
    if (
      scope !== null &&
      visibility !== undefined &&
      !visibility.includes(scope)
    )
      return undefined
    if (grantDenies(serverGrant, object, scope)) return undefined
    return row
  }
  const serverDigest = () =>
    [TASK, ORG].map((object) =>
      (object === TASK ? KEYS : ORG_KEYS)
        .map((k) => truthRow(object, k)?.version ?? "-")
        .join()
    )
  let digest = serverDigest()
  /**
   * Приєднання каналу, яке тримає приймач: його об'єкт іде в хвилю (О3 бере від
   * нього межу зміни, про яку клієнт дізнається цією подією).
   */
  const joined = (channel: string, recovered: boolean) => {
    const at = CHANNELS.indexOf(channel)
    const object = at < 2 ? TASK : ORG
    if (
      closed === undefined &&
      !sessionChanged &&
      transport.subscribed().has(channel) &&
      !staled.has(object)
    )
      o3Joins.push({ object, at: clock, after: ownEvents().length })
    transport.join(channel, recovered)
  }
  const o3Changes: O3Change[] = []
  const o3Joins: O3Join[] = []
  const o3Server: O3Change[] = []
  /** Фіксує зміну правди сервера: час моделі — кінець кроку, у якому її побачено. */
  /**
   * Збій читання (відмова чи недоступність сервера): правда не змінилась, але
   * показ вигляду міг стати помилкою до наступного читання, а його не викликає
   * подія каналу.
   */
  const noteFault = (object: ObjectName | undefined) => {
    for (const o of object === undefined ? [TASK, ORG] : [object])
      o3Changes.push({ object: o, at: clock })
  }
  const noteServerChanges = () => {
    const next = serverDigest()
    ;[TASK, ORG].forEach((object, i) => {
      if (next[i] !== digest[i]) {
        o3Changes.push({ object, at: clock })
        o3Server.push({ object, at: clock })
      }
    })
    digest = next
  }

  for (const [n, raw] of plan.entries()) {
    const s = onMutation(raw)
    const label = `step ${n} ${JSON.stringify(s)}`
    const stepStart = fake.log.length
    logAt = log.length
    restoredInStep.clear()
    signalObjects.clear()
    coveredInStep.clear()
    rereadsAtStep = new Map(
      [...internals.registry.subsets()].map((sub) => [
        sub,
        tracker.rereads(sub.targetId),
      ])
    )
    const before = lists()
    preloadedSection = false
    rightsPurgeable = new Set()
    rightsPassInStep = false
    let userViews = new Set<number>()
    let purgeStep = false
    // Крок планувальника: читання, які він запустив, рахуються за лічильниками
    // перечитувань виглядів на старті кроку.
    const schedulerStep = s.t === "time" || s.t === "due" || s.t === "resume"
    const tickStep = schedulerStep || s.t === "exhaust"
    const readsAtStart = new Map<Subset, number>()
    // Вигляди в стані межі відкинутих (Р3): планувальник їх не читає.
    const exhaustedAtStart = new Set<Subset>()
    const failedAtStart = new Map<
      Subset,
      { failures: number; failedAt: number | undefined }
    >()
    if (schedulerStep && closed === undefined) {
      for (const sub of internals.registry.subsets()) {
        readsAtStart.set(sub, tracker.rereads(sub.targetId))
        if (exhausted(sub) || sessionDown()) exhaustedAtStart.add(sub)
        failedAtStart.set(sub, {
          failures: tracker.failures(sub.targetId),
          failedAt: tracker.failedAt(sub.targetId),
        })
      }
    }
    const hiddenAtStart = !core.visible
    const deferredAtStart = inspect.scheduledDue()
    const tickAtStart = core.freshness.lastTickAt()
    // Об'єкти, яким крок «повернення» не мав слати читань.
    const quiet = new Set<ObjectName>()
    // Вигляди з молодою відміткою й їхні лічильники перечитувань на старті.
    const youngViews = new Map<Subset, number>()
    // З них — у паузі після збою.
    const pausedViews = new Set<Subset>()
    // Вигляди зі старою (чи без) відміткою: звірка мусить їх перечитати.
    const agedViews = new Map<Subset, number>()
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
        unsubAt.set(s.v, clock)
        if (s.release) advance(RELEASE_MS)
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
          unsubAt.set(v, clock)
          advance(RELEASE_MS)
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
      case "visible": {
        core.setVisible(SPECS[s.v]!, s.on)
        const held = internals.registry.find(SPECS[s.v]!)
        if (held !== undefined) visibleBy.set(held.targetId, s.on)
        break
      }
      case "answer": {
        if (fake.pending.length === 0) break
        // Генератор зміщує `pick` до малих чисел, а модель бере з кінця
        // черги: свіжі відповіді частіше, давні читання довше лишаються в
        // польоті й доходять пізно — після звільнень, витіснень і `purge`.
        const read = fake.take(
          fake.pending.length - 1 - (s.pick % fake.pending.length)
        )
        if (s.how === "forbidden") {
          noteFault(read.object)
          read.fail("command.forbidden")
          break
        }
        if (s.how === "unavailable") {
          noteFault(read.object)
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
          // Правда сервера на мить змінилась (рядок зник чи скоуп сховано), і
          // клієнт міг це прочитати, хоч до кінця кроку рядок повертається: це
          // зміна без події каналу для О3.
          if (victim !== undefined) o3Changes.push({ object, at: clock })
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
      case "gap": {
        core
          .revalidate(TASK, { visibleOnly: false })
          .catch((error: unknown) => errors.push(error))
        if (!live(TASK, KEYS[s.k]!)) break
        if (s.remove) {
          fake.remove(TASK, KEYS[s.k]!)
          deleted.add(id(TASK, KEYS[s.k]!))
        } else fake.edit(TASK, KEYS[s.k]!, { title: `zz${n}` })
        break
      }
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
            status: null,
            subject: null,
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
          // стирає поля.
          for (const a of attempts)
            if (a.result === undefined && a.key === target) a.purged = true
          const entry = journal.get(target)
          if (entry !== undefined) entry.erased = true
        }
        purgedKeys = { object, keys: [target] }
        dropOwedKey(object, target)
        markPurged(id(object, target))
        purgeBarrier.set(id(object, target), stepStart)
        if (object === TASK) barrierSections(stepStart)
        break
      }
      case "purgeScope": {
        purgeStep = true
        const object = s.org ? ORG : TASK
        const scope = SCOPES[s.scope]!
        const purged = purgePair(object, scope, stepStart)
        if (purged === undefined) break
        purgedScope = { object, scope }
        purgedKeys = purged
        break
      }
      case "hide": {
        // Плоский `hide` держану ТЧ не перечитує (тригери — монтування,
        // `preload`, `commit` зі слухачем).
        heldInFlight = false
        const object = s.org ? ORG : TASK
        if (staled.has(object)) break
        const target = s.org ? ORG_KEYS[s.k % 2]! : KEYS[s.k]!
        commit((w) => w.hide(object, [target]))
        if (closed !== undefined) break
        hideBarrier.set(id(object, target), stepStart)
        break
      }
      case "hideSection": {
        // Несумісний об'єкт не перечитується: `hide` над ним вже нічого не
        // змінює, а очікування перечитування було б хибним.
        if (closed !== undefined || staled.has(TASK)) break
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
            unsubAt.set(4, clock)
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
          else if (!loadFlying(held)) handles[4]!.refresh()
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
            (() => {
              const found = internals.registry.find(section)
              return found !== undefined && loadFlying(found)
            })()
        }
        break
      }
      case "revalidate": {
        const object = s.org ? ORG : TASK
        // Явний `revalidate` над виглядом у польоті ставить хвіст (Р7).
        if (closed === undefined && !staled.has(object))
          for (const sub of internals.registry.subsets())
            if (
              sub.form.object.name === object &&
              sub.alive &&
              !sub.purged &&
              sub.loaded &&
              inFlight(sub) &&
              (!s.visibleOnly || shown(sub)) &&
              (sub.form.spec.kind !== "section" || listenersOf(sub) > 0) &&
              !tailWatch.has(sub)
            )
              tailWatch.set(sub, {
                rereads: tracker.rereads(sub.targetId),
                visibleOnly: s.visibleOnly,
              })
        core
          .revalidate(object, { visibleOnly: s.visibleOnly })
          .catch((error: unknown) => errors.push(error))
        break
      }
      case "markStale": {
        const version = fake.row(TASK, KEYS[s.k]!)?.version ?? 1
        commit((w) => w.markStale(TASK, [KEYS[s.k]!], version + s.plus))
        break
      }
      case "disconnect": {
        const ch = CHANNELS[s.channel]
        // З приймачем розрив і приєднання йдуть лише через транспорт: пряма
        // позначка розійшлася б із каналами, які він тримає.
        if (signals) {
          if (s.join && ch !== undefined) joined(ch, false)
          else transport.fail({ kind: "transport", channel: ch })
          break
        }
        // Приєднання лише пише `joinAt`: позначку знімає читання після нього.
        if (s.join && ch !== undefined) internals.epochs.join(ch)
        else commit((w) => w.markDisconnected(ch))
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
        advance(s.ms)
        break
      case "epoch":
        fake.epoch = EPOCHS[s.which]!
        if (fake.epoch !== null) primaryEpoch = fake.epoch
        break
      case "update": {
        // Запис у несумісний об'єкт відмовляється без транспорту (§10):
        // модель `run` тут нічого не чекає, а відмову перевіряє `ssr.test.ts`.
        if (staled.has(TASK)) break
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
        const mutation = core.update(TASK, k, values, { expectedVersion: base })
        if (pending) {
          sending = undefined
          // Одна мутація на ключ: `pending` — відмова до журналу й
          // транспорту, мутація осідає `failed` з кодом (§7.1).
          if (attempt.sent)
            fail(label, `${k}: an update of a pending key went out`)
          if (mutation.id === existing.attempt.id)
            fail(label, `${k}: a refused update reused the pending attempt`)
          void mutation.settled.then((result) => {
            if (
              result.ok ||
              !(result.error instanceof DataError) ||
              result.error.code !== "data.mutation-pending"
            )
              asyncViolations.push(
                `${k} ${mutation.id}: a refused update settled ${result.ok ? "ok" : result.error.code}`
              )
          })
          break
        }
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
        // дорозі — відповідь після неї нічого не пише.
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
          if (shown.retry === undefined || staled.has(TASK)) break
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
      case "stale": {
        if (closed !== undefined) break
        const object = s.org ? ORG : TASK
        if (!staled.has(object)) staled.set(object, fake.log.length)
        core.staleClient(object)
        break
      }
      case "version":
        if (closed === undefined) core.requestVersion()
        break
      case "return": {
        if (closed !== undefined) break
        // Вигляд із відміткою молодшою за межу читання від кроку не отримує
        // (лічильник перечитувань вигляду); об'єкт «тихий», коли таких усі
        // видимі завантажені вигляди, що читають його (власним читанням чи
        // ціллю `include`): тоді жодного читання не мало піти й до джерела.
        const at = clock
        const readers = [...coreInternals(core).registry.subsets()].filter(
          (sub) => sub.alive && !sub.purged && sub.loaded && shown(sub)
        )
        // Строк такту, що вже настав (вигляд зі строком у цю мить), виконує
        // перше ж перепланування кроку без таймера: такт читає вигляди своєю
        // межею `0,9 × I`, а не межею кроку (§6.7), як і на `resume()`.
        const overdue =
          [...internals.registry.subsets()].some(
            (sub) => isTarget(sub) && modelDue(dueOf(sub)) <= at
          ) ||
          [...inspect.scheduledDue()].some(
            ([name, due]) => due <= at && !staled.has(name)
          )
        const byTick = (sub: Subset) =>
          overdue && !young(sub, at, 0.9 * runInterval)
        // Читання не бере вигляд, чий строк не настав (молодша за межу відмітка,
        // пауза після збою чи вигляд, що ще не читався), вигляд у польоті й
        // вигляд, що вичерпав межу відкинутих (спека П4-B §6.7).
        const youngNow = (sub: Subset) =>
          young(sub, at, s.minAge) && !byTick(sub)
        for (const sub of readers) {
          if (inPause(sub, at)) pausedViews.add(sub)
          if (youngNow(sub)) youngViews.set(sub, tracker.rereads(sub.targetId))
          else if (
            !young(sub, at, s.minAge) &&
            !staled.has(sub.form.object.name)
          )
            agedViews.set(sub, tracker.rereads(sub.targetId))
        }
        for (const object of [TASK, ORG]) {
          const of = readers.filter(
            (sub) =>
              sub.form.object.name === object ||
              sub.form.include.some((step) => step.target === object)
          )
          if (of.every(youngNow)) quiet.add(object)
        }
        core.requestVersion()
        for (const object of [TASK, ORG])
          core
            .revalidate(object, { visibleOnly: true, minAgeMs: s.minAge })
            .catch((error: unknown) => errors.push(error))
        break
      }
      case "suspend":
        core.suspend()
        suspends++
        hiddenSince = clock
        break
      case "due": {
        // До найближчого строку планувальника — за інспекцією, не до
        // найближчого фейкового таймера: інші таймери ядра не заважають.
        const due = inspect.schedulerDueAt()
        if (due !== undefined && closed === undefined)
          advance(Math.max(0, due - clock))
        break
      }
      case "outage":
        outage = s.steps
        break
      case "exhaust": {
        // Доводимо сесію до межі відкинутих відповідей: перемикання епохи,
        // далі відповіді покинутої епохи на кожне перечитування. Далі час
        // іде понад `I`: планувальник не мусить прочитати жодного вигляду.
        if (closed !== undefined || !core.visible || staled.has(TASK)) break
        subscribe(7, label)
        userViews = new Set([7])
        for (let round = 0; round < 40; round++) {
          const epochs = inspect.versionEpochs()
          if (epochs.unavailable) break
          fake.epoch =
            epochs.current === null
              ? EA
              : epochs.previous === null
                ? epochs.current === EA
                  ? EB
                  : EA
                : epochs.previous
          if (fake.epoch !== null) primaryEpoch = fake.epoch
          core
            .revalidate(TASK, { visibleOnly: false })
            .catch((error: unknown) => errors.push(error))
          for (let i = 0; i < 20; i++) {
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
          // Без плину часу між проходами: відкладені повтори відкинутих
          // відповідей лишаються в планувальнику до самої межі.
        }
        await flush()
        if (!inspect.versionEpochs().unavailable) break
        // Кожен завантажений вигляд читається ще раз явно: відкинута відповідь
        // позначає його межею. Планувальник не бере вигляд лише в цьому стані.
        for (const object of [TASK, ORG])
          core
            .revalidate(object, { visibleOnly: false })
            .catch((error: unknown) => errors.push(error))
        for (let i = 0; i < 20; i++) {
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
        const before = new Map(
          [...internals.registry.subsets()].map((sub) => [
            sub,
            tracker.rereads(sub.targetId),
          ])
        )
        // Явні перечитування кроку вище — не сигнал: зарахування починається
        // з цієї миті.
        rereadsAtStep = new Map(before)
        coveredInStep.clear()
        // Перепланування (подія видимості вигляду) і час понад `I`: вигляд у
        // стані межі не дає строку.
        core.setVisible(SPECS[7]!, true)
        const seven = internals.registry.find(SPECS[7]!)
        if (seven !== undefined) visibleBy.set(seven.targetId, true)
        await flush()
        advance(2 * runInterval)
        await flush()
        for (const [sub, rereads] of before)
          if (
            tracker.rereads(sub.targetId) !== rereads &&
            !bySignal(sub, false)
          ) {
            // Читання зробив такт планувальника: він же й помилка.
            tickReads++
            fail(
              label,
              "a read started by the scheduler after the discard limit"
            )
          }
        break
      }
      case "resume": {
        if (closed !== undefined) {
          core.resume()
          break
        }
        const at = clock
        const coalesced =
          lastResumeClock !== undefined &&
          at - lastResumeClock < RESUME_COALESCE_MS
        if (!coalesced) lastResumeClock = at
        // Об'єкти з настаним строком перемикання епохи чи повтору відкинутої
        // відповіді `resume()` бере незалежно від межі (Р5, Р6).
        const dueNow = dueObjects(at)
        const shownViews = [...internals.registry.subsets()].filter(
          (sub) => sub.alive && !sub.purged && sub.loaded && shown(sub)
        )
        const readers = shownViews.filter((sub) => !readsObject(sub, dueNow))
        // Подвійний сигнал — одна звірка: другий виклик не читає нічого.
        const byResume = (sub: Subset) =>
          !coalesced && !young(sub, at, RESUME_MIN_MS)
        // Вкладка стала видимою: планувальник бере прострочене одразу, і такт
        // читає всі вигляди зі строком у вікні `0,1 × I` (§6.7).
        const overdue =
          [...internals.registry.subsets()].some(
            (sub) => isTarget(sub, true) && modelDue(dueOf(sub)) <= at
          ) ||
          [...inspect.scheduledDue()].some(
            ([name, due]) => due <= at && !staled.has(name)
          )
        const byTick = (sub: Subset) =>
          overdue && !young(sub, at, 0.9 * runInterval)
        // Вимога сильніша за вік (§8.4, п. 7): вигляд, чия вимога «склад не
        // підтверджено» стояла на старті кроку поза паузою збою, `resume()`
        // читає й молодшим за межу. Лише такий: молодий вигляд без вимоги
        // межа й далі тримає.
        const byRequirement = (sub: Subset) =>
          requires(sub, "composition-unconfirmed") &&
          tracker.failures(sub.targetId) === 0 &&
          !inPause(sub, at)
        const youngNow = (sub: Subset) =>
          !byResume(sub) && !byTick(sub) && !byRequirement(sub)
        for (const sub of readers) {
          if (inPause(sub, at)) pausedViews.add(sub)
          if (youngNow(sub)) youngViews.set(sub, tracker.rereads(sub.targetId))
          else if (byResume(sub) && !staled.has(sub.form.object.name))
            agedViews.set(sub, tracker.rereads(sub.targetId))
        }
        for (const object of [TASK, ORG]) {
          // Прочитаний строком вигляд (власним чи ціллю `include`) читає й
          // свої цілі: об'єкт не «тихий».
          if (
            shownViews.some(
              (sub) =>
                readsObject(sub, dueNow) && readsObject(sub, new Set([object]))
            )
          )
            continue
          const of = readers.filter(
            (sub) =>
              sub.form.object.name === object ||
              sub.form.include.some((step) => step.target === object)
          )
          if (of.every(youngNow)) quiet.add(object)
        }
        core.resume()
        shownAt = clock
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
      case "rights": {
        if (!rights || closed !== undefined) break
        const scope = SCOPES[s.scope]!
        const object = s.object === 1 ? ORG : TASK
        const at = grantKey(object, scope)
        const g = serverGrant
        const lose: Grant =
          s.object === 2
            ? { ...g, members: without(g.members, scope) }
            : { ...g, reads: without(g.reads, at), extra: without(g.extra, at) }
        const regain: Grant =
          s.object === 2
            ? { ...g, members: withOne(g.members, scope) }
            : { ...g, reads: withOne(g.reads, at) }
        const next =
          s.what === "lose" || s.what === "fail"
            ? lose
            : s.what === "regain"
              ? regain
              : s.what === "narrow"
                ? {
                    ...g,
                    extra: g.extra.includes(at)
                      ? without(g.extra, at)
                      : withOne(g.extra, at),
                  }
                : s.what === "hold"
                  ? grantDenies(g, object, scope)
                    ? regain
                    : lose
                  : s.what === "user"
                    ? { ...g, user: OTHER_USER }
                    : g
        // Утримана відповідь лишається в польоті через наступні кроки, аж до
        // наступного кроку прав: ядро тим часом іде за старшим знімком.
        if (s.what === "hold") {
          fake.holdRights = true
          setGrant(next)
          core.requestRights()
          break
        }
        if (s.what === "fail")
          fake.rightsError = { code: "command.unavailable" }
        setGrant(next)
        fake.holdRights = false
        fake.releaseRights()
        core.requestRights()
        await flush()
        // Збій лишає старий знімок; сервер повертається до прав кроку, і
        // наступна службова точка (тут — сам крок) їх приносить: ядро не
        // відстає від сервера, тож звуження не випадає на крок повернення, де
        // перевірка меж свіжості його не чекає.
        if (s.what === "fail") {
          check(`${label} failed`, stepStart)
          fake.rightsError = undefined
          setGrant(g)
          core.requestRights()
          await flush()
        }
        break
      }
      case "race": {
        if (!rights || closed !== undefined || staled.has(TASK)) break
        const group = RACE_GROUPS[s.group]!
        const spec = SPECS[group[0]!]!
        const k =
          spec.kind === "card"
            ? spec.key
            : spec.kind === "section"
              ? spec.owner
              : spec.kind === "keys"
                ? spec.keys[0]!
                : K1
        if (!live(TASK, k)) break
        const scope = fake.row(TASK, k)!.values.org as string
        const at = grantKey(TASK, scope)
        // Знімок цього кроку мусить дійти до відповідей кроку.
        await settleRights()
        // Пара дозволена й ядро тримає цей знімок.
        if (grantDenies(serverGrant, TASK, scope)) {
          setGrant({
            ...serverGrant,
            members: withOne(serverGrant.members, scope),
            reads: withOne(serverGrant.reads, at),
          })
          fake.holdRights = false
          fake.releaseRights()
          core.requestRights()
          await flush()
        }
        // Пари в сховищі немає: прохід заміни її не прибирає й не ховає
        // надгробком — відповідь тримає лише бар'єр знімка.
        const o = objectOf(TASK)
        const lines = o.sections.get(K1, "lines")
        const stored =
          [...o.rows.keys()].some((x) => o.rows.get(x)!.scope === scope) ||
          lines?.scope === scope ||
          lines?.scope === "unknown"
        // Перевірки кроку `purgeScope` тут не діють: читання цього ж кроку
        // законно повертають рядки після нього.
        if (stored) {
          purgeStep = true
          if (purgePair(TASK, scope, stepStart) === undefined) break
        }
        await flush()
        // Читання пари стартують до відправки знімка.
        const from = fake.log.length
        userViews = new Set(group)
        for (const v of group) {
          if (subs[v] !== undefined) handles[v]!.refresh()
          else preload(v, true, label)
        }
        await flush()
        const own = fake.pending.filter((r) => fake.log.indexOf(r.log) >= from)
        setGrant({
          ...serverGrant,
          reads: without(serverGrant.reads, at),
          extra: without(serverGrant.extra, at),
        })
        fake.holdRights = false
        fake.releaseRights()
        core.requestRights()
        await flush()
        // Відповідь — на мить старту, коли пару ще було видно; `later` лишає
        // читання в польоті для наступних кроків і злиття в кінці.
        if (s.settle === "now") {
          const news = newsBefore()
          const answered = own.filter((read) => fake.pending.includes(read))
          for (const read of answered) {
            fake.take((r) => r === read).answer(read.issuedAt)
            record(read)
          }
          await flush()
          checkNews(label, news, answered)
        }
        break
      }
      case "signal": {
        if (!signals) break
        const object = s.org ? ORG : TASK
        let target = s.org ? ORG_KEYS[s.k % 2]! : KEYS[s.k]!
        // Версія до зміни: `delete` несе версію стану «до» (§8.1).
        let base =
          fake.row(object, target)?.version ?? lastSent.get(id(object, target))
        if (s.change && object === TASK && closed === undefined) {
          if (s.op === "create") {
            if (!created) {
              created = true
              target = K5
              fake.insert(TASK, {
                ref: K5,
                org: SCOPES[s.k % 2],
                title: "s",
                notes: "n5",
                status: null,
                subject: null,
              })
              base = fake.row(TASK, K5)!.version
            }
          } else if (s.op === "delete") {
            if (live(TASK, target)) {
              fake.remove(TASK, target)
              deleted.add(id(TASK, target))
            }
          } else if (s.op !== "garbage" && live(TASK, target)) {
            fake.edit(TASK, target, {
              title: `${TITLES[(s.k + n) % TITLES.length]}${n}`,
            })
            if (s.op !== "invalidate") base = fake.row(TASK, target)!.version
          }
        }
        const version = Math.max(
          1,
          (base ?? 1) + (s.ver === 1 ? -1 : s.ver === 2 ? 1 : 0)
        )
        lastSent.set(id(object, target), base ?? 1)
        const rowScope =
          object === ORG
            ? target
            : ((fake.row(TASK, target)?.values.org as string | undefined) ??
              SCOPES[s.k % 2]!)
        const scope =
          s.ch === 0 ? rowScope : SCOPES.find((x) => x !== rowScope)!
        const entryId = object === TASK ? OBJECT_ID : ORGANIZATION_ID
        const payload =
          s.op === "garbage"
            ? { id: String(++signalSeq), object: entryId, op: "move" }
            : s.op === "invalidate"
              ? { id: String(++signalSeq), object: entryId, op: "invalidate" }
              : {
                  id: String(++signalSeq),
                  object: entryId,
                  op: s.op,
                  keys: { id: target },
                  row_ver: version,
                }
        const topic = channel(object, scope)
        sentSignals.push({
          topic,
          payload,
          object,
          scope,
          key: target,
          op: s.op,
        })
        emit(topic, payload, object, scope, target, s.op)
        break
      }
      case "replay": {
        if (!signals || sentSignals.length === 0) break
        const x =
          sentSignals[sentSignals.length - 1 - (s.pick % sentSignals.length)]!
        emit(x.topic, x.payload, x.object, x.scope, x.key, x.op)
        break
      }
      case "join":
        // Мітка О2: читання, що знімає вимогу приєднання, стартує після неї.
        joinMark = ownEvents().length
        if (signals) joined(CHANNELS[s.ch]!, s.recovered)
        break
      case "transport":
        if (signals)
          transport.fail({ kind: "transport", channel: CHANNELS[s.ch] })
        break
      case "refreshTokens":
        if (signals) await transport.refreshTokens()
        break
      case "chanAuth": {
        if (!signals) break
        const ch = CHANNELS[s.ch]!
        // Відмову бачить лише тримач каналу: тоді приймач робить `purge` пари.
        if (closed !== undefined || !transport.subscribed().has(ch)) {
          transport.fail({ kind: "auth", channel: ch })
          break
        }
        purgeStep = true
        const object = s.ch < 2 ? TASK : ORG
        const scope = SCOPES[s.ch % 2]!
        const purged = purgePair(object, scope, stepStart, () =>
          transport.fail({ kind: "auth", channel: ch })
        )
        if (purged === undefined) break
        purgedScope = { object, scope }
        purgedKeys = purged
        break
      }
      case "connAuth": {
        if (!signals) break
        // Остаточна відмова токена з'єднання закриває ядро, коли приймач
        // тримає хоч одну підписку (лише тоді він бачить помилку).
        const holds = transport.subscribed().size > 0
        transport.fail(
          s.final ? { kind: "auth", final: true } : { kind: "auth" }
        )
        if (!s.final || closed !== undefined) break
        const snap = handles[0]!.getSnapshot()
        const shut =
          snap.status === "purged" && snap.reason === "connection-refused"
        if (shut !== holds)
          fail(
            label,
            shut
              ? "closed by a refusal the receiver could not see"
              : "a final connection refusal did not close the core"
          )
        if (!shut) break
        for (const a of attempts) if (a.result === undefined) a.mustFail = true
        journal.clear()
        closed = { frames, sent: fake.log.length, snapshot: snap }
        break
      }
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
    // Сервер недоступний: кожне читання цього кроку падає.
    if (outage > 0) {
      if (closed === undefined) {
        for (const read of fake.pending.filter(
          (r) => fake.log.indexOf(r.log) >= stepStart
        )) {
          noteFault(read.object)
          fake.take((r) => r === read).fail("command.unavailable")
        }
        await flush()
      }
      outage--
    }
    if (tickStep && core.freshness.lastTickAt() !== tickAtStart) tickReads++
    // О4 (спека ядра синхронізації §5.13): вікно спокою прихованої вкладки.
    // Крок без дій — плин часу; відкриває вікно крок, після якого вкладка
    // прихована, запису в польоті немає і запитів без відповіді теж.
    const idleProblem = reads.idleStep({
      quiet: s.t === "time" || s.t === "due",
      idle: !core.visible && runs.length === 0,
    })
    if (idleProblem !== undefined) fail(label, idleProblem)
    // О2 (§5.13): обіцянки й докази вимог у стані спокою.
    const o2Before = o2.evaluated()
    // `sync()` обходить сховище: лише у спокої, коли О2 щось судить.
    const quietNow = fake.pending.length === 0 && fake.inFlight === 0
    const o2Problem =
      !judge || !quietNow
        ? undefined
        : o2.step({
            now: clock,
            states: inspect.sync(),
            events: ownEvents(),
            attempts: ownAttempts,
            fake,
            revalidateMs: runInterval,
            releaseDelayMs: DEFAULT_CORE_LIMITS.releaseDelayMs,
            lastJoin: () => joinMark,
            // Тримач — слухач вигляду з кроків моделі, видимий на видимій вкладці.
            // Власник «відсутній», доки його не прочитано знову після purge.
            ownerPurged: (object, k) =>
              purgedTargets.has(id(object as ObjectName, k)) &&
              !heldRows.has(id(object as ObjectName, k)),
            holderPresent: (target) =>
              target.kind === "view" &&
              subs[SPECS.indexOf(target.spec)] !== undefined,
            purgedView: (target) =>
              target.kind === "view" &&
              handles[SPECS.indexOf(target.spec)]?.getSnapshot().status ===
                "purged",
            targetHeld: (target) =>
              target.kind === "view" &&
              (subs[SPECS.indexOf(target.spec)] !== undefined ||
                (preloadUntil.get(SPECS.indexOf(target.spec)) ?? -1) > clock),
            holderVisible: (target) => {
              if (target.kind !== "view") return false
              const v = SPECS.indexOf(target.spec)
              return (
                core.visible &&
                subs[v] !== undefined &&
                (visibleBy.get(target.id) ?? true)
              )
            },
            storeEmpty: !heldKeys().size,
            rowAlive: (_object, k) => heldKeys().has(k),
            suspends,
            ...(hiddenSince === undefined ? {} : { hiddenSince }),
            tabHidden: !core.visible,
            ...(shownAt === undefined ? {} : { shownAt }),
            headerGone: (_object, k) => {
              const shown = handles.flatMap((handle, v) =>
                subs[v] === undefined
                  ? []
                  : handle.getSnapshot().rows.filter((r) => r.key === k)
              )
              return (
                shown.length > 0 && shown.every((r) => r.state === "removed")
              )
            },
            rowLife: (object, k) =>
              purgeCount.get(id(object as ObjectName, k as Key)) ?? 0,
          })
    o2Checks += o2.evaluated() - o2Before
    if (o2Problem !== undefined) fail(label, `O2: ${o2Problem}`)
    if (schedulerStep && closed === undefined) {
      const dueNow = new Set(
        [...deferredAtStart].flatMap(([name, due]) =>
          due <= clock ? [name] : []
        )
      )
      for (const [sub, rereads] of readsAtStart) {
        if (tracker.rereads(sub.targetId) === rereads) continue
        // Пачка сигналів і хвиля читають за подією каналу, а не за строком:
        // межа відкинутих і пауза після збою стосуються планувальника (§6.2,
        // §8.4). Вигляд пропускається, лише коли кожне його перечитування
        // кроку зараховано названому сигналом (бюджет приймача).
        if (bySignal(sub, false)) continue
        // Читання, яке запустив планувальник (чи `resume()`).
        if (s.t !== "resume" && hiddenAtStart && !core.visible)
          fail(label, "a read started by the scheduler on a hidden tab")
        if (s.t !== "resume" && exhaustedAtStart.has(sub))
          fail(label, "a read started by the scheduler after the discard limit")
        const was = failedAtStart.get(sub)!
        // Пауза діє на такт і на `resume()`; строк перемикання епохи її
        // не знає (Р5, Р6).
        if (
          was.failures > 0 &&
          was.failedAt !== undefined &&
          clock < was.failedAt + pauseAfter(was.failures) &&
          !readsObject(sub, dueNow) &&
          // Хвиля приєднання перечитує вигляд явно (Р10), як `revalidate`.
          !bySignal(sub, true)
        )
          fail(label, "a view was read inside its failure pause")
      }
    }
    // Хвиля приєднання й пачка сигналів перечитують за подією каналу, а не
    // за межею свіжості: `resume()` бере хвилю разом зі звіркою (Р10).
    for (const [sub, rereads] of youngViews) {
      if (bySignal(sub, true)) continue
      if (tracker.rereads(sub.targetId) !== rereads)
        fail(
          label,
          `a view younger than the limit was re-read${pausedViews.has(sub) ? " (inside its failure pause)" : ""}`
        )
    }
    for (const [sub, rereads] of agedViews) {
      if (tracker.rereads(sub.targetId) === rereads)
        fail(label, "a view older than the limit was not re-read")
    }
    for (const object of quiet) {
      // Запити до об'єкта від пачки (ключі, названі вигляди й їхні цілі
      // `include`) — від сигналу.
      if (signalObjects.has(object)) continue
      for (const sent of fake.log.slice(stepStart)) {
        const target = sent.query?.object
        if (target !== undefined && `${target.kind}.${target.name}` === object)
          fail(label, `${object}: a view younger than the limit got a read`)
      }
    }
    if (purgedScope !== undefined) {
      const o = objectOf(purgedScope.object)
      for (const k of o.rows.keys()) {
        if (o.rows.get(k)!.scope === purgedScope.scope)
          fail(label, `${purgedScope.object}/${k} survived the scope purge`)
      }
    }
    check(label, stepStart)
    if (schedulerChecks) checkScheduler(label)
    if (purgedKeys !== undefined) checkPurged(label, purgedKeys)
    noteGens(userViews.size > 0)
    stability(label, before, purgeStep, rightsPurgeable)
    noteServerChanges()
    // Шаг, що міг змінити віру клієнта без події каналу (`purge`, `hide`,
    // відповідь-репліка, права, перегідратація), — зміна для О3 в обох
    // об'єктах: клієнт виправляє її лише читанням за інтервалом.
    if (!QUIET_STEPS.has(s.t))
      for (const object of [TASK, ORG]) o3Changes.push({ object, at: clock })
  }

  // Утримана відповідь `rights` доходить до злиття: інакше її запит не осяде.
  if (rights) {
    rightsPurgeable = new Set()
    rightsPassInStep = false
    const before = lists()
    fake.holdRights = false
    // Довжина журналу ДО кроку, як в інших кроках: читання цього кроку
    // (хвостове перечитування) мусять рахуватися «пізнішими» (#400).
    const stepStart = fake.log.length
    fake.releaseRights()
    await flush()
    check("release rights", stepStart)
    noteGens(false)
    stability("release rights", before, false, rightsPurgeable)
  }

  // Відповіді на `run`, що лишились у польоті: сервер приймає кожен.
  for (let i = 0; runs.length > 0; i++) {
    if (i > 100) fail("drain runs", "runs never end")
    const stepStart = fake.log.length
    logAt = log.length
    restoredInStep.clear()
    rightsPurgeable = new Set()
    rightsPassInStep = false
    const before = lists()
    answerRun(runs.shift()!, "ok", 1)
    await flush()
    check(`drain run ${i}`, stepStart)
    noteGens(false)
    stability(`drain run ${i}`, before, false, rightsPurgeable)
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
    rightsPurgeable = new Set()
    rightsPassInStep = false
    const before = lists()
    const slow = late.shift()
    const read = slow ?? fake.take()
    noteFault(read.object)
    read.answer(slow !== undefined || i % 2 === 0 ? read.issuedAt : fake.clock)
    record(read)
    await flush()
    check(`drain ${i}`, stepStart)
    noteGens(false)
    stability(`drain ${i}`, before, false, rightsPurgeable)
  }

  if (closed === undefined && judge) await o3Phase()
  if (closed === undefined) await converge()

  /**
   * О3 (спека §5.13, план SK-0 Р-SK0-9): вкладка видима, без `refresh()` і
   * `revalidate`, іде час моделі; кожен видимий вигляд, чия межа минула, мусить
   * показувати правду сервера. Межу кожної зміни рахує оракул за причиною.
   */
  async function o3Phase() {
    // База відповідає епохою, за якою йде сесія: інакше кожне читання відкидає
    // не оракул, а модель (так само, як у збіжності).
    fake.epoch = inspect.versionEpochs().current
    noteServerChanges()
    if (!core.visible) core.resume()
    const phaseStart = clock
    const o3 = createO3()
    const views = (): O3View[] =>
      SPECS.flatMap((spec, v): O3View[] => {
        const sub = internals.registry.find(spec)
        if (
          subs[v] === undefined ||
          sub === undefined ||
          !core.visible ||
          !(visibleBy.get(sub.targetId) ?? true)
        )
          return []
        const snap = handles[v]!.getSnapshot()
        const objects = [
          sub.form.object.name,
          ...sub.form.include.map((step) => step.target),
        ]
        let state: O3State = "live"
        let holderSince: number | undefined
        if (snap.status === "purged") state = "purged"
        else if (inspect.versionEpochs().unavailable) state = "discard-bound"
        else if (objects.some((o) => staled.has(o))) state = "stale-object"
        else if (
          snap.status === "error" &&
          !sub.loaded &&
          tracker.failures(sub.targetId) === 0
        )
          state = "first-load-error"
        else if (
          spec.kind === "section" &&
          snap.section?.ownerState === "stale"
        ) {
          state = "section-owner-hidden"
          // Шапку K1 читає лише вигляд ключів чи картка, що її тримає; секція
          // перечитує рядки, не шапку.
          // Тримач без власної вимоги чи строку (картка без обов'язку, рядки 17/20)
          // шапки не читає: тримачем він не є.
          holderSince = headerHolderSince({
            phaseStart,
            visible: core.visible,
            holders: SPECS.flatMap((other, w) => {
              if (
                subs[w] === undefined ||
                other.object !== spec.object ||
                !readsHeader(other, spec.owner)
              )
                return []
              const held = internals.registry.find(other)
              return [
                held === undefined
                  ? undefined
                  : syncedViews().get(held.targetId),
              ]
            }),
          })
        } else if (syncedViews().get(sub.targetId)?.dueCause === "retry")
          state = "retry-pause"
        else if (
          spec.kind === "section" &&
          snap.section?.ownerState === "removed"
        )
          state = "section-owner-removed"
        else if (
          (spec.kind === "card" || spec.kind === "section") &&
          sub.loaded
        ) {
          const duty = syncedViews().get(sub.targetId)
          if (duty !== undefined && !hasOwnDuty(duty))
            state = "card-without-duty"
        }
        return [
          {
            id: sub.targetId,
            objects,
            state,
            holderSince,
            truth: () => o3Truth(v),
          },
        ]
      })
    const input = () => ({
      now: clock,
      phaseStart,
      intervalMs: runInterval,
      changes: o3Changes,
      joins: o3Joins,
      views: views(),
    })
    const settle = async (label: string) => {
      for (let i = 0; ; i++) {
        await flush()
        if (fake.pending.length === 0) return
        if (i > 200) fail(label, "reads never end")
        const stepStart = fake.log.length
        logAt = log.length
        restoredInStep.clear()
        while (fake.pending.length > 0) {
          const read = fake.take()
          read.answer()
          record(read)
        }
        await flush()
        check(label, stepStart)
      }
    }
    const judge = () => {
      const problem = o3.step(input())
      if (problem === undefined) return
      const failure = o3.failure()!
      o3Report = {
        ...failure,
        joins: [...o3Joins],
        server: [...o3Server],
        reads: ownEvents().map((e) => ({
          at: e.at,
          object:
            e.target.kind === "service"
              ? undefined
              : (e.target.object as ObjectName),
        })),
      }
      fail("o3", problem)
    }
    await settle("o3 start")
    if (closed !== undefined) return
    judge()
    const end = o3LastBound(input())
    for (const at of o3Checkpoints(input())) {
      // Вікно приєднання проходимо дрібно, щоб хвиля читала в свій час; далі —
      // стрибком до межі такту.
      while (clock < at) {
        advance(
          clock < phaseStart + 2_500 ? Math.min(at - clock, 500) : at - clock
        )
        await settle(`o3 ${clock}`)
        if (closed !== undefined) return
      }
      judge()
    }
    // Пауза повтору відкинутого читання довша за межу: судимо знову з її кінцем.
    for (
      let n = 0;
      n < 40 && views().some((view) => view.state === "retry-pause");
      n++
    ) {
      advance(500)
      await settle(`o3 pause ${clock}`)
      if (closed !== undefined) return
      judge()
    }
    // Пауза повтору скінчена: стан `retry-pause` — не вічна умова. Пауза, що не
    // кінчається в межах часу моделі, — дефект (повтор не прийшов), а не названий
    // стан: оракул не судить уявну нескінченну паузу.
    if (views().some((view) => view.state === "retry-pause"))
      fail("o3", "a retry pause did not end within the model time")
    if (clock < end) fail("o3", "the model did not reach the last bound")
    o3Checks += o3.evaluated()
    for (const state of O3_NAMED_STATES)
      o3Skipped.set(state, (o3Skipped.get(state) ?? 0) + o3.skipped(state))
  }

  /** Розбіжність показу вигляду з правдою сервера; `undefined` — збігається. */
  function o3Truth(v: number): string | undefined {
    const spec = SPECS[v]!
    const snap = handles[v]!.getSnapshot()
    const where = `o3 view ${v}`
    const rowMismatch = (row: RowView) => {
      try {
        sameAsServer(where, spec.object, row)
        return undefined
      } catch (error) {
        if (error instanceof ModelFailure) return error.message
        throw error
      }
    }
    if (snap.status !== "ready") return `${where}: status ${snap.status}`
    // Склад вигляду системне перечитування не змінює (нові рядки чекають дії
    // користувача, `hasNewRows`): О3 судить показані рядки, а не склад.
    const rows = judgeRows(
      snap.rows.map((row) => ({
        state: row.state,
        mismatch: () => rowMismatch(row),
      }))
    )
    if (rows !== undefined) return rows
    if (spec.kind !== "section" || snap.section === undefined) return undefined
    const owner = truthRow(TASK, spec.owner)
    const problem = judgeSection(
      {
        ownerVersion: owner?.version,
        lines: owner === undefined ? [] : linesHistory.at(-1)!.qty,
      },
      {
        ownerState: snap.section.ownerState,
        ownerVersion: snap.section.ownerVersion,
        lines: snap.section.lines.map((l) => l.values.qty),
      }
    )
    return problem === undefined ? undefined : `${where}: ${problem}`
  }

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
    advance(10_000)
    await flush()
    // Читання, які запустив цей плин часу (такт, хвиля приєднання, пачка
    // сигналів), осідають до знімка прав: інакше вони займають обмежувач
    // читань, і частина `rights` до сервера не доходить.
    for (let i = 0; fake.pending.length > 0; i++) {
      if (i > 100) fail("converge", "reads never end")
      const stepStart = fake.log.length
      logAt = log.length
      restoredInStep.clear()
      while (fake.pending.length > 0) {
        const read = fake.take()
        read.answer()
        record(read)
      }
      await flush()
      check(`converge settle ${i}`, stepStart)
    }
    // Права повертаються повністю й ядро застосовує їх до перечитування:
    // знову відкриті пари читає вже читання після знімка.
    if (rights) {
      setGrant({ ...FULL_GRANT, user: serverGrant.user })
      await settleRights()
      core.requestRights()
      await flush()
      await settleRights()
      check("converge rights", fake.log.length)
      if (core.rights()?.rightsVersion !== fake.rightsVersion)
        fail(
          "converge rights",
          "the core holds no full rights before re-reading"
        )
    }
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
      // Вигляд несумісного об'єкта закритий; вигляд, що вмикає його ціллю
      // `include`, живий: ціль нерозв'язана, а решта збігається з сервером.
      if (staled.has(spec.object)) return
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
    if (staled.has(object)) return
    const server = truthRow(object, row.key)
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
      else if (!staled.has(ORG)) {
        // `null` — лише для цілі, якої сервер не показує; наявна ціль
        // не може лишитись порожньою (гонка власності `include`).
        const target = row.values[field]
        if (typeof target === "string" && truthRow(ORG, target) !== undefined)
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

const property = (
  defects: readonly DefectFlag[] = [],
  schedulerChecks = true,
  rights = false,
  signals = false,
  intervalMs = REVALIDATE_MS,
  judge = true
) =>
  fc.asyncProperty(
    fc.array(signals ? SIGNAL_STEP : rights ? RIGHTS_STEP : STEP, {
      minLength: 10,
      maxLength: 80,
      size: "max",
    }),
    fc.boolean(),
    fc.constantFrom<Profile>("full", "scroll", "burial"),
    (steps, preloaded, profile) =>
      modelRun(
        runModel(
          steps,
          preloaded,
          profile,
          defects,
          schedulerChecks,
          rights,
          signals,
          intervalMs,
          judge
        )
      )
  )

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
})
// Прогін, перерваний межею часу, закриває ядро й таймери ще в своєму тесті.
afterEach(async () => {
  await settleRuns()
  vi.useRealTimers()
})

// Бюджети тестів властивостей: таймаут vitest і межа fast-check
// (`interruptWithin`) — з однієї сталої на тест. Запас — близько двох найгірших
// замірів (локальна машина й CI): фаза О3 і оракули кожного кроку подовжили
// прогін, а перерваний пошук без помилки (`errorInstance` порожній) не доводить
// нічого, тож кількість прогонів не зменшуємо, а межу піднімаємо.
const BUDGET_MS = 300_000
const RIGHTS_BUDGET_MS = 600_000

/*
 * Режими властивостей (рішення архітекторки 25.11). Інваріанти ядра, О1 і О4
 * шукають контрприклади на НОВИХ сидах у кожному прогоні. О2 і О3 у шлюзі судять
 * ЗАКРІПЛЕНІ сиди з тим самим числом прогонів і детермінованим джитером ядра:
 * їхній набір винятків заморожено, а новий сид пошуку — не виняток, а рядок
 * списку для планів SK-3 і SK-4. Пошук О2 і О3 на нових сидах — окрема команда
 * (не в CI): `CORE_MODEL_SEED=random`; `CORE_MODEL_RUNS` діє в обох режимах.
 */
// Закріплено рішенням архітекторки 25.11: зелені на повному числі прогонів.
const PINNED_SEEDS = { plain: 1, rights: 1, signals: 1 } as const
const searchO2O3 = process.env.CORE_MODEL_SEED === "random"
const judgedRun = (profile: keyof typeof PINNED_SEEDS) =>
  searchO2O3 ? {} : { seed: PINNED_SEEDS[profile] }

describe("core model", () => {
  it(
    "holds the invariants over random interleavings",
    async () => {
      tickReads = 0
      idleChecks = 0
      await fc.assert(property([], true, false, false, REVALIDATE_MS, false), {
        numRuns: RUNS,
        ...interruptWithin(BUDGET_MS),
      })
      // Без тактів із читанням інваріанти планувальника порожні.
      expect(tickReads, "no tick with a read").toBeGreaterThan(0)
      expect(idleChecks, "no step in an idle window").toBeGreaterThan(0)
    },
    BUDGET_MS
  )

  it(
    "judges O2 and O3 over the pinned seed (plain)",
    async () => {
      o2Checks = 0
      o3Checks = 0
      pinnedRandom = !searchO2O3
      try {
        await fc.assert(property(), {
          numRuns: RUNS,
          ...judgedRun("plain"),
          ...interruptWithin(BUDGET_MS),
        })
      } finally {
        pinnedRandom = false
      }
      assertEvaluated(o2Checks, "the plain property")
      assertO3Evaluated(o3Checks, "the plain property")
    },
    BUDGET_MS
  )

  // Каталог зі знімком прав (B5b-2): ті самі кроки й кроки знімка — втрата
  // пари, звуження, без змін, збій, утримана відповідь, читання до знімка,
  // інший користувач. Без прав прогін вище лишається тим самим (насіння
  // самотесту й регресій не зсуваються).
  it(
    "holds the invariants with the rights snapshot",
    async () => {
      tickReads = 0
      await fc.assert(property([], true, true, false, REVALIDATE_MS, false), {
        numRuns: RUNS,
        ...interruptWithin(RIGHTS_BUDGET_MS),
      })
      expect(tickReads, "no tick with a read").toBeGreaterThan(0)
    },
    RIGHTS_BUDGET_MS
  )

  it(
    "judges O2 and O3 over the pinned seed (rights snapshot)",
    async () => {
      o2Checks = 0
      o3Checks = 0
      pinnedRandom = !searchO2O3
      try {
        await fc.assert(property([], true, true), {
          numRuns: RUNS,
          ...judgedRun("rights"),
          ...interruptWithin(RIGHTS_BUDGET_MS),
        })
      } finally {
        pinnedRandom = false
      }
      assertEvaluated(o2Checks, "the rights property")
      assertO3Evaluated(o3Checks, "the rights property")
    },
    RIGHTS_BUDGET_MS
  )

  // Приймач сигналів (B5b-3): ті самі кроки й кроки знімка прав плюс сигнали
  // каналу змін у будь-якому порядку з дублями, приєднання з `recovered` і
  // без, розриви, відмови каналу й з'єднання. Прогони без сигналів не
  // змінюються (їхні насіння самотесту й регресій не зсуваються).
  it(
    "holds the invariants with the signal receiver",
    async () => {
      tickReads = 0
      await fc.assert(property([], true, true, true, REVALIDATE_MS, false), {
        numRuns: RUNS,
        ...interruptWithin(RIGHTS_BUDGET_MS),
      })
      expect(tickReads, "no tick with a read").toBeGreaterThan(0)
    },
    RIGHTS_BUDGET_MS
  )

  it(
    "judges O2 and O3 over the pinned seed (signal receiver)",
    async () => {
      o2Checks = 0
      o3Checks = 0
      pinnedRandom = !searchO2O3
      try {
        await fc.assert(property([], true, true, true), {
          numRuns: RUNS,
          ...judgedRun("signals"),
          ...interruptWithin(RIGHTS_BUDGET_MS),
        })
      } finally {
        pinnedRandom = false
      }
      assertEvaluated(o2Checks, "the signals property")
      assertO3Evaluated(o3Checks, "the signals property")
    },
    RIGHTS_BUDGET_MS
  )
})

// Межа часу властивості (обв'язка): прогін понад бюджет тесту червоний сам і
// не продовжується у фоні в наступному тесті.
describe("the time budget of a property", () => {
  const SMALL_BUDGET_MS = 3_000
  let started = 0
  let finished = 0
  const counted = fc.asyncProperty(
    fc.array(STEP, { minLength: 10, maxLength: 80, size: "max" }),
    fc.boolean(),
    fc.constantFrom<Profile>("full", "scroll", "burial"),
    (steps, preloaded, profile) => {
      started++
      return modelRun(
        runModel(steps, preloaded, profile).finally(() => {
          finished++
        })
      )
    }
  )

  it(
    "fails a property that outlives its budget as an interrupt",
    async () => {
      await expect(
        fc.assert(counted, {
          numRuns: 1_000_000,
          ...interruptWithin(SMALL_BUDGET_MS),
        })
      ).rejects.toThrow(/interrupted/i)
    },
    SMALL_BUDGET_MS
  )

  it("leaves no run of it going in the next test", async () => {
    // Перерваний прогін осів ще в своєму тесті: ядро й таймери закрито там.
    expect(finished, "the interrupted run is still in flight").toBe(started)
    const at = started
    for (let i = 0; i < 50; i++)
      await new Promise<void>((resolve) => setImmediate(resolve))
    expect(started, "a run started after its test ended").toBe(at)
    expect(vi.getTimerCount()).toBe(0)
  })
})

// Фіксовані прогони знайдених контрприкладів: насіння й шлях fast-check
// відтворюють той самий прогін на будь-якій машині.
describe("core model regressions", () => {
  // Явні кроки: усічені шляхи реплеїв нижче не доводять, що без виправлення
  // прогін червоний. Завантаження вигляду відкинуто за епохою, далі його
  // перечитує `return` — модель не мусить вважати вигляд «у польоті».
  // Пауза повтору береться з `sync()` (строк із причиною `retry`): `return` під
  // час живої паузи, відповіді й плин часу — модель і ядро згодні, чи вигляд
  // у польоті, на кожному кроці.
  // Явні кроки того ж реплею: `sub` на прихованій вкладці ставить завантаження в
  // чергу (M6 з причиною `mount`); його старт — наслідок дії, не вкладка у спокої.
  it("does not take a queued `mount` load on a hidden tab for a tab at rest", async () => {
    const steps: Step[] = [
      { t: "suspend" },
      { t: "revalidate", org: false, visibleOnly: false },
      { t: "epoch", which: 1 },
      { t: "answer", pick: 0, how: "missing", at: 0 },
      { t: "epoch", which: 2 },
      { t: "sub", v: 10 },
      { t: "answer", pick: 0, how: "stale", at: 0 },
      { t: "churn", v: 1, scroll: false },
      { t: "epoch", which: 1 },
      { t: "answer", pick: 0, how: "missing", at: 0 },
      { t: "purgeScope", org: false, scope: 0 },
      { t: "due" },
    ]
    await modelRun(runModel(steps, true, "burial", [], true, true, false))
  })

  // Нестабільний за природою: джитер перемикання епохи (`Math.random`). Той самий
  // прогін 40 разів: модель не мусить розходитися з ядром, коли пауза повтору
  // стоїть у `sync()` поруч із строком об'єкта.
  it("keeps the model and the core agreed on the retry pause beside an object timer", async () => {
    const steps: Step[] = [
      { t: "hideSection", state: "mounted", then: "none", evict: false },
      { t: "sub", v: 0 },
      { t: "churn", v: 0, scroll: true },
      { t: "epoch", which: 1 },
      { t: "answer", pick: 0, how: "missing", at: 0 },
      { t: "epoch", which: 2 },
      { t: "answer", pick: 2, how: "missing", at: 0 },
      { t: "epoch", which: 1 },
      { t: "edit", k: 0, title: 0 },
      { t: "answer", pick: 0, how: "stale", at: 2 },
      { t: "answer", pick: 6, how: "missing", at: 0 },
      { t: "sub", v: 2 },
      { t: "revalidate", org: false, visibleOnly: true },
      { t: "answer", pick: 2, how: "stale", at: 0 },
      { t: "page", w: 1, dir: "after" },
      { t: "return", minAge: 1000 },
    ]
    for (let i = 0; i < 40; i++) {
      await modelRun(runModel(steps, false, "scroll", [], true, false, false))
      await settleRuns()
    }
  }, 120_000)

  // Строк рядка зник у мить строку, бо тримач (вигляд) пішов: не прострочена
  // обіцянка, а названий стан «немає тримача».
  it("does not owe a row deadline that left with its released holder", async () => {
    const steps: Step[] = [
      { t: "hideSection", state: "mounted", then: "none", evict: false },
      { t: "answer", pick: 1, how: "missing", at: 0 },
      { t: "churn", v: 1, scroll: false },
      { t: "answer", pick: 0, how: "forbidden", at: 0 },
      { t: "unsub", v: 1, release: true },
      { t: "answer", pick: 0, how: "stale", at: 0 },
      { t: "answer", pick: 0, how: "missing", at: 0 },
      { t: "sub", v: 2 },
      { t: "answer", pick: 0, how: "missing", at: 0 },
      { t: "answer", pick: 0, how: "missing", at: 0 },
      { t: "unsub", v: 0, release: true },
    ]
    await modelRun(runModel(steps, true, "scroll", [], true, true, true))
  })

  // Без хвоста `{ time 5000 }, answer`: після нескінченного штучного циклу
  // відкидань вимога рядка `version-epoch-switched` переживає обмежений виняток
  // (родина рядка 19 §5.14, SK-4) — див. #360. Це випадок списку, не виняток.
  it("agrees with the core on a view in the M8 retry pause", async () => {
    const answer: Step = { t: "answer", pick: 0, how: "ok", at: 0 }
    const refresh: Step = { t: "refresh", v: 0, showNew: false }
    const steps: Step[] = [
      { t: "sub", v: 0 },
      answer,
      { t: "epoch", which: 1 },
      refresh,
      answer,
      { t: "epoch", which: 2 },
      refresh,
      answer,
      { t: "epoch", which: 1 },
      refresh,
      answer,
      { t: "return", minAge: 1000 },
      answer,
      { t: "time", ms: 500 },
      answer,
      answer,
    ]
    await modelRun(runModel(steps, false, "full", [], true, false, false))
  })

  it("`return` rereads a view whose load was discarded and never retried", async () => {
    const steps: Step[] = [
      { t: "closeInFlight" },
      { t: "race", group: 5, settle: "now" },
      { t: "gap", k: 0, remove: false },
      { t: "answer", pick: 0, how: "forbidden", at: 0 },
      { t: "churn", v: 0, scroll: false },
      { t: "return", minAge: 1000 },
    ]
    await modelRun(runModel(steps, false, "full", [], true, true, true))
  })

  it.each([
    // #312: явний `revalidate` над виглядом у польоті після `unavailable`/`resume`.
    {
      issue: 312,
      seed: -568825302,
      path: "884:11:11:14:15:17:21:21:21:24:23:23:13:13:13:13:13:13:13:13:13:13:13:13:13:13:13:13:13:13:13:13",
    },
    // #114: write-back результату `run`, що стартував до знову відкритої
    // пари, коли її надгробок витіснено (горизонт кошика пари).
    {
      issue: 114,
      rights: true,
      seed: -1706902252,
      path: "5727:5:10:14:14:18:22:27:29:29:33:42:38:21:40:44:43:44:48:47:48:49:17:47:48:42:26:35:34:34:31:31:31:31:31:31:31:31:31:31:31:31:31:32:32:32:32:32:32",
    },
    {
      issue: 114,
      rights: true,
      seed: -1180098105,
      path: "3643:2:6:16:16:16:16:19:3:14:22:22:25:28:15:28:27:28:32:33:34:33:34:37:39:42:41:25:35:37:40:42:42:34:38:36:34:35:35:37:37:39:41:40:41:41:41:41:41:40:38:37",
    },
    // #114: рядки ТЧ старшої версії власника за новішою шапкою, що переїхала
    // в дозволений скоуп.
    {
      issue: 114,
      rights: true,
      seed: 843533137,
      path: "9974:2:2:8:2:3:5:5:14:14:10:10:10:10:10:10:10:10:10:10:10:10:10:10:10:10:10",
    },
    // #114: рядки ТЧ читання, старшого за знову відкриту пару, коли її
    // надгробок витіснено, а шапку в сховищі записало новіше читання.
    {
      issue: 114,
      rights: true,
      seed: 206032993,
      path: "7554:3:2:5:5:9:10:12:17:19:21:20:21:33:27:26:31:32:32:32:42:44:45:52:58:55:61:59:59:58:59:59:64:22:7:11:1:0:16:10:8:19:19:21:21:16:16:21:13:12:13:13:13:13:13:13:13:13:13:13",
    },
    // #114: мутація, яку ядро осіло відповіддю іншого запиту того самого
    // такту до зміни користувача, — не «осідання після закриття».
    {
      issue: 114,
      rights: true,
      seed: 1736980771,
      path: "2032:4:1:11:11:11:16:17:23:23:28:29:29:35:35:43:43:47:42:47:49:49:54:60:61:61:61:65:48:49:54:41:61:66:65:65:69:57:62:62:64:60:61:61:38:38:38:38:38:38:38:38:38:38:38:38:38:38:38:38:38",
    },
    // #114: рядки ТЧ без відомого скоупу, що прослизнули з репліки, яка
    // відстає в правах, прибирає й заміна, де об'єкт нічого не втратив.
    {
      issue: 114,
      rights: true,
      seed: 1407422309,
      path: "9302:4:1:9:11:14:18:22:24:27:29:36:43:43:46:47:51:51:14:14:14:29:18:16:24:29:28:28:31:31:27:27:27:27:27:29:28:28:28:29:28:29:29:29:29:29",
    },
    // #114: такт і хвиля приєднання займають обмежувач читань перед
    // збіжністю, і частина `rights` збіжності не доходить до сервера.
    {
      issue: 114,
      signals: true,
      seed: 929198240,
      path: "4036:7:7:11:12:22:25:24:29:31:35:35:26:6:30:35:26:24:24:26:25:31:32:32:35:36:47:46:54:37:31:50:51:56:56:60:64:68:22:3:28:35:35:36:33:30:29:28:29:29:33:33:33:33:33:33:35:36:28:34:38:38",
    },
    // #114: відповідь читання за ключем, старша за завантаження `full`, лягла
    // після нього (розбіжне «рядка немає», П15): відхилений рядок відповіді
    // завантаження не лишає складу без нього після збіжності.
    {
      issue: 114,
      signals: true,
      seed: 1071874945,
      path: "1376:4:0:8:12:13:15:17:22:20:22:23:24:21:19:21:21:22:22:2:5:5:17:17:17:17:17:17:18:19:19:19:19:23:23:24",
    },
    // #114: сторінка, що стартувала до вимоги пачки сигналів, не повторюється
    // за чужою вимогою (§8.4, п. 7: сторінка підтверджує лише себе) — інакше
    // повтор заміняє сторінку й змінює склад без дії користувача.
    {
      issue: 114,
      signals: true,
      seed: -518023336,
      path: "9307:4:1:4:11:8:19:20:5:3:16:11:14:16:11:19:19:19:11:11:9:9:8:8:8:17:8:9:8:9:11:8:11:12:11:8:10:10",
    },
    // #114: вимога складу, що лишилась на прихованій вкладці, сильніша за
    // вік — `resume()` читає вигляд і молодшим за `resumeMinIntervalMs`.
    {
      issue: 114,
      signals: true,
      seed: -1610915587,
      path: "7505:2:3:5:5:22:14:3:5:9:9:11:10:13:12:12:13:19:18:18:18:18:7:8:8:8:8:8:8:8:8:8:8:8:8:8:8:8:8:8:8:8:8:8:8:8:9",
    },
    // #374: сторінка вікна лягла в `settleRights` того самого кроку, що й purge
    // пари, — сума двох дозволених причин для правила стабільності.
    {
      issue: 374,
      rights: true,
      seed: 364721987,
      path: "9750:3:0:4:11:13:18:21:24:24:29:29:31:36:4:3:34:34:38:38:38:42:45:45:48:50:49:49:49:44:44:44:44:44:44:44:44:44:45:3:44:45:45:45:45:45:45:45:45:45:45:45:45:45:45:45",
    },
    // #374: відповідь мінімальної версії до purge, коли надгробки ключа й
    // пари витіснено: приймач мусить судити за горизонтом, як сховища.
    {
      issue: 374,
      signals: true,
      seed: -543971651,
      path: "8357:4:7:18:18:24:27:28:28:28:40:42:36:35:35:39:41:41:42:41:23:29:2:23:25:21:21:21:21:21:21:21:21:21:21:21:21:21:21:21",
    },
    // О2: вигляд, знищений `purge` пари, зберігає вимогу без умови (умова
    // «purged»), і збій першого завантаження — стан, а не дефект.
    {
      issue: "O2 purged view",
      o2: true,
      rights: true,
      signals: true,
      seed: -93404445,
      path: "997:7:3:15:5:11:17:27:16:10:20:10:18:17:21:11:63:11:16:17:36:17:45:56:33:25:30:35:61:47:55:47:46:53:69:53:52:51:53:32:31:47:30:37:21:20:20:22:21:20:20:20:20:20:20:20:20:20:20:20:20:26:20:22:20:21:20:20",
    },
    {
      issue: "O2 min-version row",
      o2: true,
      seed: 2025024491,
      path: "2007:4:2:11:14:18:20:20:20:26:26:10:10:10:10:10:10:10:10:10:10:10:10:10:10:10:10:10:10:10:10:10:11",
    },
    {
      issue: "O2 purged owner release",
      o2: true,
      rights: true,
      signals: true,
      seed: 1329672921,
      path: "9819:8:13:17:16:22:24:33:33:41:44:45:48:48:48:48:52:52:52:56:58:53:29:54:52:55:54:55:55:44:44:44:44:44:44:44:44:44:44:44:44:44:44:44:44:44",
    },
    // Рядок з вимогою «мінімальна версія» вилучено `purge`, поки читання були в
    // польоті, і прочитано знову: вимога зникла разом із рядком, а не без доказу.
    // Строк зник зі `sync()` на прихованій вкладці: обіцянки більше немає.
    {
      issue: "O2 deadline left sync()",
      o2: true,
      seed: -1703697790,
      path: "9992:4:4:12:12:13:13:16:4:6:10:14:14:21:21:24:13:18:18:18:26:28:16:17:21:22:22:22:24:27:33",
    },
    // Відкинута за епохою спроба знімає вимогу «ціль відстала від шапки», як і
    // збійна; читання йде повтором після паузи.
    {
      issue: "O2 discarded load drops a requirement",
      o2: true,
      signals: true,
      seed: -1229539262,
      path: "837:9:6:10:11:11:13:18:19:19:19:22:25:37:38:39:39:39:47:40:38:42:42:42:27:25:25:25:25:28:25:25:26:27:27:26:27:32:26:26:26:31:28:29:26:27:27",
    },
    // О3: картка без власної вимоги й строку над рядком, якого сервер не має.
    {
      issue: "O3 card without duty",
      o3: "card-without-duty" as const,
      seed: 0,
      path: "467",
    },
    // О3: ТЧ, чий власник `removed`, і шапку читає лише перечитування шапки.
    {
      issue: "O3 section over a removed owner",
      o3: "section-owner-removed" as const,
      seed: -1579167006,
      path: "37:2:3:5:13:13:21:30:23:22:22:24:29:29:39:38:42:45:43:44:46:48:27:25:25:25:25:25:9:12:2:13:4:7:11:11:11:12:12:12:12:14:13:13:13:12:12:12:12:12",
    },
    // Вигляд, чию паузу повтору модель брала за політ, хоча повтору вже не було:
    // паузу тепер дає строк із причиною `retry` у `sync()`.
    {
      issue: "return rereads a view after a discarded load",
      seed: -565918531,
      path: "1556:2:3:5:15:16:14:13:13:14:14:14:18:18:12",
    },
    {
      issue: "return rereads a view after a discarded load (rights)",
      rights: true,
      seed: -1716810821,
      path: "4910:3:1:0:3:6:12:12:16:17:18:21:26:3:8:13:13:14:20:24:24:24:14",
    },
    {
      issue: "return rereads a view after a discarded load (signals)",
      signals: true,
      seed: 681021836,
      path: "6052:3:2:1:7:9:14:14:16:16:16:22:22:22:26:27:27:30:31:32:32:32:16",
    },
    // О4: черга M6 несе причину `mount` підписки (дія на прихованій вкладці):
    // це не читання вкладки у спокої.
    {
      issue: "O4 queued mount on a hidden tab",
      rights: true,
      seed: -404532396,
      path: "1072:4:0:4:10:15:10:11:36:19:42:81:11:17:48:31:39:35:16:41:52:45:72:13:19:20:20:25:32:39:37:42:41:19:66:31:35:34:63:32:32:35:37:41:35:42:34:34:42:45:45:45:45:38:38:38:38:38:38:38:38:38:38:38:38:38:38:38:38:38:38",
    },
    // CI 45595370220: пауза retry поруч зі строком об'єкта (нестабільний за джитером).
    {
      issue: "pause beside an object timer",
      seed: -998057425,
      path: "5432:3:0:0:1:8:10:11:11:17:21:21:19:26:27:26:36:37:40:26:30:44:40:39:38:38:40:49:58:64:47:45:60:54:43:54:37:56:37:48:62:50:61:42:51",
    },
    // CI 45595370220: строк рядка зник у мить строку разом із тримачем.
    {
      issue: "row deadline left with its holder",
      o2: true,
      signals: true,
      seed: 1459187033,
      path: "2387:6:2:12:12:12:17:9:13:13:13:22:22:27:29:28:28:34:35:35:38:18:5:32:31:31:31:33:38:39:39:39:44:45:45:50:53:56:58:58:63:63:63:67:68:39:39:39:39:39:39:39:39:39:39:39:39:39:39:39:39:39:39:39",
    },
    // О3: вигляд у довгій паузі повтору відкинутого читання (рядок 18 стану retry).
    {
      issue: "O3 view in a retry pause",
      seed: 958004524,
      path: "1210:2:2:5:15:15:18:7:9:9:10:14:14:16:20:23:23:26:33:32:31:37:3:17:3:31:29:27:26:26:26:26:26:26:27:27:27:27:27:28:28:29:29:30",
    },
    // CI 45601548174: вигляд бачить стару версію власника після кроків із правами.
    {
      issue: "O3 view owner version (signals)",
      o3: "section-owner-hidden" as const,
      signals: true,
      seed: -372539610,
      path: "7725:6:5:9:3:1:5:5:6:8:12:4:5:4:5:5:8:10:12:12:14:14:14:14:17:17:17:17:18:18:18:18:19:20:19:20:21:20:21:22:22",
    },
    // Пауза повтору — те саме завантаження користувача в польоті: без неї модель
    // губила його номер, і складу, що ріс після повтору, ніхто не виправдовував.
    {
      issue: "user load across a retry pause",
      seed: -997846743,
      path: "6453:1:1:0:8:10:11:13:15:15:17:17:17:19:19:19:20:20:20:20:20:20:20:20:20:21:21:21:21:21:21",
    },
    // Шапка власника зникла зі сховища читанням, що не знайшло рядка: похідна
    // вимога «ціль відстала від шапки» ТЧ іде разом із нею (давній, з 7498db70).
    {
      issue: "O2 behind-header requirement left with its header",
      o2: true,
      seed: 290039941,
      path: "3206:3:2:1:11:11:16:10:11:17:18:20:19:20:19:19:23:25:25:27:30:34:37:35:34:38:41:43:49:49:49:53:54:58:59:68:72:72:72:79:78:78:78:59:59:59:59:59:59:59:59:59:59:59:59:59:59:59:59:59:59:59:59:59:59",
    },
    // CI 45621977924: тримач шапки — картка без власної вимоги й строку, шапки
    // вона не читає, тож тримачем для межі стану не є.
    {
      issue: "O3 section over a hidden owner, a card without duty",
      o3: "section-owner-hidden" as const,
      seed: 580488793,
      path: "3912:8:7:19:19:21:20:20:26:26:27:27:27:30:33:39:45:49:50:51:57:57:44:55:26:51:51:59:67:75:76:3:32:29:42:43:48:47:48:51:52:54:32:49:51:51:53:53:53:53:48:48:48:49:49:49:38:14:16:21:1:16:17:17:17:17:18:17:19:19:19:20:19:20:20:20:20",
    },
    {
      issue: "O2 purged row returns",
      o2: true,
      seed: 968292387,
      path: "8463:4:0:4:12:12:17:20:22:23:22:28:34:33:34:34:19:19:19:19:19:19:19:19:19:19:19:19:19:19:19:19:19:19:19:19:19:19:19:19",
    },
    {
      issue: "O2 purge and unsub",
      o2: true,
      rights: true,
      signals: true,
      seed: 1825111737,
      path: "3010:3:2:26:4:7:12:11:18:31:45:26:36:32:32:39:45:32:32:38:42:41:41:51:22:36:36:36:36:37:19:17:20:15:16:16:15:15:19:15:15:15:19:15:16:15:15:15:22:15:17:22:16:15:16:15:16:16:19:11:9:8:9:8",
    },
    // #400: оракул рахував довжину журналу після кроку `release rights`, тож
    // хвостове перечитування цього кроку не вважалося пізнішим читанням.
    {
      issue: 400,
      rights: true,
      seed: -1708729583,
      path: "9564:1:0:2:2:2:3:3:3:3:2:3:3:3:3:3:3:3:3:4:5:5:5:5:6:6:6",
    },
  ])(
    "replays the counterexample of #$issue (seed $seed)",
    async ({ seed, path, rights = false, signals = false, o2 = false, o3 }) => {
      o2Checks = 0
      o3Checks = 0
      o3Skipped.clear()
      await fc.assert(property([], true, rights, signals), {
        seed,
        path,
        endOnFailure: true,
        ...interruptWithin(BUDGET_MS),
      })
      // Прогін із вимогами: без оціненого стану спокою О2 порожній.
      if (o2) assertEvaluated(o2Checks, `replay of seed ${seed}`)
      // Реплей О3: фаза судила вигляди й справді пропустила названий стан.
      if (o3 !== undefined) {
        assertO3Evaluated(o3Checks, `replay of seed ${seed}`)
        expect(o3Skipped.get(o3) ?? 0, `${o3} was never used`).toBeGreaterThan(
          0
        )
      }
    },
    BUDGET_MS
  )

  // #114: вигляд із `needsRefresh` від механізму свіжості стає видимим
  // після межі відкинутих — перехід у видимість не читає (§6.2).
  it("replays a view marked unconfirmed that becomes visible after the discard limit (#114)", async () => {
    const steps: readonly Step[] = [
      { t: "closeInFlight" },
      { t: "hide", org: false, k: 0 },
      {
        t: "signal",
        org: false,
        k: 0,
        op: "update",
        ch: 0,
        ver: 0,
        change: false,
      },
      { t: "churn", v: 1, scroll: false },
      { t: "race", group: 0, settle: "later" },
      { t: "answer", pick: 7, how: "unavailable", at: 0 },
      { t: "replay", pick: 0 },
      { t: "return", minAge: 1000 },
      { t: "unsub", v: 0, release: false },
      { t: "sub", v: 0 },
      { t: "run", pick: 0, how: "unavailable", at: 0 },
      { t: "act", k: 0, act: "retry" },
      { t: "closeInFlight" },
      { t: "answer", pick: 0, how: "stale", at: 0 },
      {
        t: "signal",
        org: false,
        k: 0,
        op: "update",
        ch: 0,
        ver: 0,
        change: false,
      },
      { t: "run", pick: 0, how: "ok", at: 0 },
    ]
    await runModel(steps, true, "scroll", [], true, true, true)
  }, 120_000)

  // #114: строк такту настав рівно в мить кроку `return`: такт читає
  // вигляд, старший за свою межу `0,9 × I`, хоч і молодший за межу кроку.
  it("replays the tick due at the moment of a return step (#114)", async () => {
    const steps: readonly Step[] = [
      { t: "sub", v: 1 },
      { t: "sub", v: 2 },
      { t: "run", pick: 1, how: "conflict", at: 1 },
      { t: "answer", pick: 5, how: "stale", at: 1 },
      { t: "markViews", v: 7, one: false, needs: true, news: false },
      { t: "delete", k: 1 },
      { t: "unsub", v: 0, release: true },
      { t: "hide", org: true, k: 4 },
      { t: "answer", pick: 2, how: "stale", at: 6 },
      { t: "update", k: 4, lazy: false, base: 1 },
      { t: "sub", v: 2 },
      { t: "answer", pick: 5, how: "stale", at: 4 },
      { t: "edit", k: 3, title: 0 },
      { t: "hideSection", state: "held", then: "none", evict: true },
      { t: "churn", v: 12, scroll: true },
      { t: "purgeScope", org: true, scope: 1 },
      { t: "answer", pick: 7, how: "stale", at: 1 },
      { t: "update", k: 3, lazy: true, base: 2 },
      { t: "answer", pick: 4, how: "missing", at: 6 },
      { t: "answer", pick: 6, how: "stale", at: 6 },
      { t: "due" },
      { t: "purgeKey", org: false, k: 2 },
      { t: "answer", pick: 5, how: "missing", at: 0 },
      { t: "act", k: 0, act: "retry" },
      { t: "rehydrate" },
      { t: "answer", pick: 2, how: "forbidden", at: 1 },
      { t: "move", k: 2 },
      { t: "unsub", v: 10, release: true },
      { t: "run", pick: 2, how: "ok", at: 0 },
      { t: "resume" },
      { t: "answer", pick: 4, how: "ok", at: 2 },
      { t: "epoch", which: 0 },
      { t: "time", ms: 1000 },
      { t: "answer", pick: 2, how: "stale", at: 3 },
      { t: "return", minAge: 5000 },
      { t: "update", k: 0, lazy: false, base: 1 },
      { t: "purgeScope", org: false, scope: 0 },
      { t: "page", w: 0, dir: "before" },
      { t: "return", minAge: 1000 },
      { t: "purgeKey", org: true, k: 4 },
      { t: "answer", pick: 0, how: "forbidden", at: 5 },
      { t: "answer", pick: 3, how: "forbidden", at: 6 },
      { t: "hide", org: false, k: 2 },
      { t: "rehydrate" },
      { t: "answer", pick: 3, how: "ok", at: 6 },
      { t: "sub", v: 5 },
      { t: "answer", pick: 4, how: "stale", at: 5 },
      { t: "purgeKey", org: false, k: 0 },
      { t: "purgeScope", org: true, scope: 1 },
      { t: "page", w: 0, dir: "before" },
      { t: "unsub", v: 0, release: true },
      { t: "purgeKey", org: false, k: 3 },
      { t: "run", pick: 2, how: "ok", at: 1 },
    ]
    await runModel(steps, false, "full")
  }, 120_000)

  // #114: відповідь читання ключа за сигналом із `row_ver` попереду сервера,
  // що стартувала до purge пари каналом (`chanAuth`), прийшла, коли вигляди
  // знову тримають рядок: ні позначки мінімальної версії, ні дочитування
  // після purge. Зменшений контрприклад — кроками, а не насінням: шлях
  // fast-check зсувається з кожною зміною довільних кроків.
  it("replays the min-version answer that started before a pair purge (#114)", async () => {
    const steps: readonly Step[] = [
      { t: "run", pick: 2, how: "conflict", at: 1 },
      {
        t: "signal",
        org: true,
        k: 3,
        op: "update",
        ch: 0,
        ver: 2,
        change: false,
      },
      { t: "answer", pick: 2, how: "stale", at: 6 },
      { t: "answer", pick: 1, how: "missing", at: 2 },
      { t: "return", minAge: 5000 },
      { t: "refresh", v: 4, showNew: true },
      { t: "refresh", v: 6, showNew: true },
      { t: "return", minAge: 1000 },
      {
        t: "signal",
        org: false,
        k: 4,
        op: "update",
        ch: 0,
        ver: 1,
        change: false,
      },
      { t: "time", ms: 1000 },
      { t: "rights", what: "lose", object: 0, scope: 1 },
      { t: "move", k: 1 },
      {
        t: "signal",
        org: false,
        k: 4,
        op: "update",
        ch: 1,
        ver: 1,
        change: false,
      },
      { t: "rehydrate" },
      { t: "answer", pick: 7, how: "stale", at: 3 },
      { t: "gap", k: 1, remove: false },
      { t: "unsub", v: 10, release: false },
      { t: "run", pick: 1, how: "ok", at: 0 },
      { t: "version" },
      { t: "chanAuth", ch: 3 },
      { t: "run", pick: 0, how: "ok", at: 0 },
      { t: "purgeScope", org: true, scope: 1 },
      { t: "rights", what: "regain", object: 2, scope: 0 },
      { t: "answer", pick: 4, how: "stale", at: 0 },
      { t: "update", k: 1, lazy: true, base: 0 },
      { t: "update", k: 1, lazy: false, base: 2 },
      { t: "refresh", v: 9, showNew: false },
      { t: "churn", v: 0, scroll: false },
      { t: "refresh", v: 4, showNew: false },
      { t: "chanAuth", ch: 1 },
      { t: "rights", what: "hold", object: 0, scope: 1 },
      { t: "answer", pick: 1, how: "ok", at: 5 },
      { t: "answer", pick: 6, how: "stale", at: 1 },
      { t: "answer", pick: 2, how: "missing", at: 0 },
      { t: "markViews", v: 10, one: false, needs: true, news: false },
      { t: "answer", pick: 3, how: "ok", at: 6 },
      {
        t: "signal",
        org: true,
        k: 3,
        op: "delete",
        ch: 0,
        ver: 0,
        change: false,
      },
      { t: "run", pick: 0, how: "ok", at: 1 },
      {
        t: "signal",
        org: true,
        k: 4,
        op: "garbage",
        ch: 0,
        ver: 0,
        change: true,
      },
      { t: "rights", what: "lose", object: 0, scope: 1 },
      { t: "sub", v: 4 },
      { t: "churn", v: 12, scroll: true },
      { t: "onMutation", pick: 3, what: "remove" },
      { t: "answer", pick: 0, how: "unavailable", at: 3 },
      { t: "page", w: 1, dir: "before" },
      { t: "answer", pick: 7, how: "missing", at: 2 },
      { t: "hide", org: true, k: 4 },
      { t: "purgeScope", org: true, scope: 0 },
    ]
    await runModel(steps, true, "burial", [], true, true, true)
  }, 120_000)
})

// Дефекти такту планувальника: їхній самотест мусить мати такт із читанням.
const SCHEDULER_DEFECTS: readonly DefectFlag[] = [
  "scheduler-fires-hidden",
  "scheduler-no-pause",
  "scheduler-no-reschedule",
  "scheduler-reads-unavailable",
]

// Дефекти, чий шлях — читання з межею свіжості: інваріанти планувальника
// (межа збіжності) в їхньому самотесті вимкнено, щоб перевірка власного
// шляху спрацьовувала першою, а не ловилась ними.
const WITHOUT_SCHEDULER_CHECKS: readonly DefectFlag[] = ["min-age-all-young"]

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
  "stale-mark-lifts",
  "min-age-ignored",
  "min-age-ignored-sections",
  "min-age-all-young",
  "late-hydrated-not-reread",
  "hydrated-row-not-reread",
  "marker-lifts-newer-mark",
  "scheduler-fires-hidden",
  "scheduler-timer-per-object",
  "scheduler-no-pause",
  "scheduler-no-reschedule",
  "revalidate-no-tail",
  "scheduler-reads-unavailable",
  "sync-pause-no-cause",
  "discard-no-retry",
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
  "absent-row-ignored": /^o3: view \d+ past its bound/,
  "unbounded-seen": /seen \d+ > \d+/,
  "system-reread-via-load": /composition/,
  "hide-lifted-by-older-read": /after hide without a later read/,
  "section-ignores-hide": /not re-read after hide/,
  "recheck-needs-listeners": /not re-read after hide/,
  // Читання між позначкою `removed` і похованням слота відкидається, тож
  // `full` чи вікно закінчують без рядка сервера.
  "bury-removed-current-epoch": /^converge .*(composition|lacks)/,
  // Запис: кожен дефект — своєю перевіркою.
  // Колонка залежить від порядку кроків насіння: збирач пакета зсуває читання
  // на такт, і перший підтверджений рядок зі значенням мутації буває `title`
  // (`u<n>`) чи лінива `notes` (`w<n>`).
  "predict-before-answer": /\.(title = u|notes = w)\d+, server at/,
  "settle-separate-commit": /the run row shown with its mutation pending/,
  "write-back-lifts-hidden": /after hide without a later read/,
  "answer-after-cancel": /a cancelled attempt settled with a row/,
  // Перегідратація: знімок і звірка.
  "hidden-values-in-snapshot": /snapshot: a hidden slot carries values/,
  "hydrate-without-revalidate": /after hydrate: view \d+ .*(server|hidden)/,
  // Липка позначка: збіг `kernelHash` її не знімає.
  "stale-mark-lifts": /not isStale/,
  // Повернення: межа свіжості виглядів.
  "min-age-ignored": /a view younger than the limit (got a read|was re-read)/,
  "min-age-ignored-sections": /a view younger than the limit was re-read/,
  "min-age-all-young": /^o3: view \d+ past its bound/,
  // Пізня підписка гідрованого вигляду (§6.6): рядок знімка без читання.
  "late-hydrated-not-reread": /after hydrate: view \d+ .*(server|hidden)/,
  // Довіра — факт рядка: картка над рядком непідписаного гідрованого списку.
  "hydrated-row-not-reread": /after hydrate: card over a hydration-only row/,
  // Маркер читання, що почалось до `hide`, не знімає його позначки.
  "marker-lifts-newer-mark": /a marker of a read older than the hide/,
  // Планувальник свіжості: кожен дефект — своєю перевіркою.
  // О4: такт на прихованій вкладці шле запит у вікні спокою раніше за наявну
  // перевірку планувальника (вона лишається запасною).
  "scheduler-fires-hidden": /a read in the idle window/,
  "scheduler-timer-per-object": /scheduler timers \d+ > 1/,
  "scheduler-no-pause":
    /inside its failure pause|not re-read within its failure pause/,
  "scheduler-no-reschedule": /scheduler has no timer on a visible tab/,
  "revalidate-no-tail": /left no tail pass/,
  "scheduler-reads-unavailable": /after the discard limit/,
  // `sync()` показує паузу повтору звичайним строком: модель, що бере паузу з
  // `sync()`, бачить вигляд поза польотом і чекає від ядра перечитування.
  "sync-pause-no-cause": /not re-read after hide/,
  // Відкинуте за епохою завантаження без повтору лишає вигляд у `loading`: О3.
  // Межу О2 (читання не пізніше кінця паузи повтору) доводить її самотест: у
  // прогоні модель читає вигляд іншим шляхом (такт), і борг О2 закривається ним.
  "discard-no-retry": /^o3: view \d+ past its bound/,
  // Знімок прав (B5b-2): кожен дефект — своїм шляхом. Без бар'єра читання
  // пари, що стартувало до знімка, пише її рядок уже після нього (`race`).
  "rights-no-barrier": /written past the rights barrier/,
  // Рядки пари, збережені до першого знімка, прохід лишає.
  "rights-first-no-pass": /kept by the rights pass \(first snapshot\)/,
  // Рядки пари, яку забороняв і попередній знімок, прохід заміни лишає.
  "rights-pass-by-diff": /kept by the rights pass \(replacement\)/,
  // Прохід прибирає й дозволену пару об'єкта: склад чи `purged` картки.
  "rights-pass-purges-allowed":
    /the rights pass removed .* of an allowed pair|purged by the rights pass of an allowed pair/,
  // Приймач: сигнал пари, яку `purge` зняв, — читання без сигналу.
  "receiver-purge-keeps-batch": /a signal read without a signal/,
  // Приймач після межі відкинутих: читання за сигналом без шансу.
  "receiver-reads-unavailable":
    /a read started by the receiver after the discard limit/,
  // Приймач не бачить горизонт витіснення: відповідь до purge ставить позначку.
  "receiver-ignores-horizon": /a signal read without a signal/,
  // О2, половина (б): сторінка знімає вимогу, якої доводить лише читання всього вигляду.
  "page-drops-requirement": /composition-unconfirmed disappeared with no proof/,
  // О3: без читання хвилі вигляд лишається зі старим рядком до межі приєднання.
  "rejoin-wave-no-read": /^o3: view \d+ past its bound/,
}

// Насіння самотесту, коли насіння 1 не знаходить дефекту за 10 000 прогонів.
// Надгробок з поточною епохою після П15 (вимога «склад не підтверджено» для
// `full`, вікна й `keys`) здебільшого лікує повторне читання — лишається
// рідший шлях вікна, і насіння 1–12 до нього за 10 000 прогонів не доходять.
const SELF_CHECK_SEEDS: Partial<Record<DefectFlag, number>> = {
  "bury-removed-current-epoch": 13,
  // Контрприклад #374 (прогін 8357 цього насіння).
  "receiver-ignores-horizon": -543971651,
  // Вікно спокою О4 відкрите (вкладка прихована, нічого в польоті) раніше, ніж
  // наявна перевірка планувальника бачить такт.
  "scheduler-fires-hidden": 4,
}

// Явний контрприклад самотесту: мутацію знаходить лише вузька послідовність, яку
// випадковий пошук майже не складає. Вигляд-вікно прихований, хвиля приєднання
// ставить йому вимогу «склад не підтверджено» без польоту, сторінка осідає й
// не мусить її зняти (її знімає лише читання всього вигляду).
const SELF_CHECK_EXAMPLES: Partial<
  Record<DefectFlag, [Step[], boolean, Profile]>
> = {
  "page-drops-requirement": [
    [
      { t: "sub", v: 11 },
      { t: "answer", pick: 0, how: "ok", at: 0 },
      { t: "answer", pick: 0, how: "ok", at: 0 },
      { t: "visible", v: 11, on: false },
      { t: "join", ch: 0, recovered: false },
      { t: "time", ms: 5000 },
      { t: "page", w: 0, dir: "after" },
      { t: "answer", pick: 0, how: "ok", at: 0 },
    ],
    false,
    "full",
  ],
}

// Насіння прогонів з сигналами, коли ним самотест не збігається з простим.
const SIGNAL_SELF_CHECK_SEEDS: Partial<Record<DefectFlag, number>> = {
  "scheduler-fires-hidden": 17,
}

// Дефекти правила втрати доступу (B5b-2): їх ловлять прогони зі знімком прав.
const RIGHTS_DEFECTS: readonly DefectFlag[] = [
  "rights-no-barrier",
  "rights-first-no-pass",
  "rights-pass-by-diff",
  "rights-pass-purges-allowed",
]

// Дефекти приймача сигналів (B5b-3): їх ловлять прогони з сигналами.
const SIGNAL_DEFECTS: readonly DefectFlag[] = [
  "receiver-purge-keeps-batch",
  "receiver-reads-unavailable",
  "receiver-ignores-horizon",
  "page-drops-requirement",
]

describe("core model self-check", () => {
  // О2 не порожній на прогонах самотестів: окремий короткий прогін може не мати
  // вимог, тож лічильник судить усі прогони дефектів разом.
  beforeAll(() => {
    o2Checks = 0
    o3Checks = 0
  })
  afterAll(() => {
    assertEvaluated(o2Checks, "the defect self-check runs")
    assertO3Evaluated(o3Checks, "the defect self-check runs")
  })

  it.each(DEFECTS)(
    "turns red with the defect %s",
    async (flag) => {
      tickReads = 0
      // Стале насіння: самотест відтворюваний, а найдовший шлях до червоного
      // (дефект горизонту) займає кілька тисяч прогонів.
      const checks = !WITHOUT_SCHEDULER_CHECKS.includes(flag)
      const result = await fc.check(property([flag], checks), {
        numRuns: 10_000,
        seed: SELF_CHECK_SEEDS[flag] ?? 1,
        // Достатньо знайти червоний прогін: ужимання контрприкладу лише
        // подовжує самотест.
        endOnFailure: true,
        ...interruptWithin(BUDGET_MS),
      })
      expect(result.failed, `${flag} not caught`).toBe(true)
      expect(result.errorInstance).toBeInstanceOf(ModelFailure)
      // Контроль: той самий контрприклад без дефекту проходить, тож червоний
      // — від дефекту, а не від помилки моделі.
      const [steps, preloaded, profile] = result.counterexample!
      await modelRun(runModel(steps, preloaded, profile, [], checks))
      const caughtBy = CAUGHT_BY[flag]
      if (caughtBy !== undefined)
        expect((result.errorInstance as Error).message).toMatch(caughtBy)
      // Прогони самотесту планувальника мали такти з читанням: інакше його
      // дефекти ловить не те, що вони ламають. Дефекти «таймер на кожне
      // планування» й «без хвоста» ловлять власні перевірки до будь-якого
      // такту: тиків у їхніх прогонах не вимагаємо.
      if (SCHEDULER_DEFECTS.includes(flag))
        expect(tickReads, `${flag}: no tick with a read`).toBeGreaterThan(0)
    },
    BUDGET_MS
  )

  it.each(RIGHTS_DEFECTS)(
    "turns red with the rights defect %s",
    async (flag) => {
      const result = await fc.check(property([flag], true, true), {
        numRuns: 10_000,
        seed: 1,
        endOnFailure: true,
        ...interruptWithin(RIGHTS_BUDGET_MS),
      })
      expect(result.failed, `${flag} not caught`).toBe(true)
      expect(result.errorInstance).toBeInstanceOf(ModelFailure)
      // Контроль: той самий прогін без дефекту зелений.
      const [steps, preloaded, profile] = result.counterexample!
      await modelRun(runModel(steps, preloaded, profile, [], true, true))
      expect((result.errorInstance as Error).message).toMatch(CAUGHT_BY[flag]!)
    },
    RIGHTS_BUDGET_MS
  )

  // Перевірки моделі, які CAUGHT_BY прапорців перенаведено на О3 і О4: кожна
  // має свій явний контрприклад, щоб не лишитися без прапорця, що її червонить.
  it.each([
    {
      flag: "min-age-all-young" as const,
      checks: false,
      message: /a view older than the limit was not re-read/,
      steps: [
        { t: "sub", v: 0 },
        { t: "answer", pick: 0, how: "ok", at: 0 },
        { t: "time", ms: 5000 },
        { t: "return", minAge: 1000 },
        { t: "answer", pick: 0, how: "ok", at: 0 },
      ] as Step[],
    },
    {
      flag: "scheduler-fires-hidden" as const,
      checks: true,
      message: /a read started by the scheduler on a hidden tab/,
      // Запит без відповіді тримає вікно спокою О4 закритим: першою червоніє
      // наявна перевірка кроку.
      steps: [
        { t: "sub", v: 0 },
        { t: "answer", pick: 0, how: "ok", at: 0 },
        { t: "suspend" },
        { t: "sub", v: 1 },
        { t: "time", ms: 5000 },
        { t: "answer", pick: 0, how: "ok", at: 0 },
      ] as Step[],
    },
  ])(
    "keeps the check of $flag pinned by an explicit example",
    async ({ flag, checks, message, steps }) => {
      await expect(
        modelRun(runModel(steps, false, "full", [flag], checks))
      ).rejects.toThrow(message)
      // Контроль: без прапорця той самий прогін зелений.
      await modelRun(runModel(steps, false, "full", [], checks))
    }
  )

  // `retry-pause` — названий стан О3 лише доти, доки пауза скінченна: пауза, що
  // не кінчається в межах часу моделі, червонить О3, а не лишається умовою.
  it("turns O3 red when the retry pause of a discarded load never ends", async () => {
    const answer: Step = { t: "answer", pick: 0, how: "ok", at: 0 }
    const refresh: Step = { t: "refresh", v: 0, showNew: false }
    const steps: Step[] = [
      { t: "sub", v: 0 },
      answer,
      { t: "epoch", which: 1 },
      refresh,
      answer,
      { t: "epoch", which: 2 },
      refresh,
      answer,
      { t: "epoch", which: 1 },
      refresh,
      answer,
    ]
    await expect(
      modelRun(runModel(steps, false, "full", ["retry-sleeps-forever"], true))
    ).rejects.toThrow(/a retry pause did not end within the model time/)
    await modelRun(runModel(steps, false, "full", [], true))
  })

  // Межа стану `section-owner-hidden` (рядок 19 §5.14): ТЧ над схованим
  // власником. Без тримача шапки (крок -372539610) вона лишається станом; коли
  // ключовий вигляд власника з'являється, його читання знімає позначку, і ТЧ
  // сходиться; мутація «читання не знімає позначку» лишає її — О3 червоний.
  it("holds the section over a hidden owner to the bound once a header holder exists", async () => {
    const steps: Step[] = [
      { t: "hideSection", state: "mounted", then: "none", evict: false },
      { t: "answer", pick: 0, how: "stale", at: 0 },
      { t: "answer", pick: 0, how: "stale", at: 0 },
      { t: "preload", v: 0, short: false },
      { t: "hideSection", state: "mounted", then: "none", evict: false },
      { t: "answer", pick: 1, how: "ok", at: 0 },
      { t: "unsub", v: 0, release: false },
      { t: "answer", pick: 2, how: "missing", at: 1 },
      { t: "answer", pick: 0, how: "unavailable", at: 0 },
      { t: "unsub", v: 0, release: false },
      { t: "update", k: 1, lazy: false, base: 0 },
      { t: "rights", what: "hold", object: 0, scope: 1 },
      { t: "sub", v: 1 },
      { t: "answer", pick: 0, how: "ok", at: 0 },
      { t: "move", k: 1 },
      { t: "answer", pick: 0, how: "missing", at: 1 },
      // Тримач шапки K1: вигляд ключів [K1, K2] з власним строком.
      { t: "sub", v: 0 },
      { t: "answer", pick: 0, how: "ok", at: 0 },
    ]
    await expect(
      modelRun(
        runModel(
          steps,
          false,
          "full",
          ["reads-keep-hidden-mark"],
          true,
          true,
          true
        )
      )
    ).rejects.toThrow(/^o3: view \d+ past its bound/)
    // Контроль: без дефекту той самий прогін зелений.
    await modelRun(runModel(steps, false, "full", [], true, true, true))
  })

  // О3 (Р-SK0-9): хвиля приєднання не читає. Профіль з інтервалом набагато
  // більшим за джитер: такт не підміняє хвилю, тож лише хвиля виправляє рядок,
  // який сервер змінив до приєднання.
  it(
    "turns red with the defect rejoin-wave-no-read (a long interval)",
    async () => {
      const flag = "rejoin-wave-no-read"
      // Контрприклад доводить саме хвилю: приєднання прийнято, сервер змінив
      // рядок до нього, і жодне інше читання об'єкта не стартувало між
      // приєднанням і межею О3. Інакше О3 червоний з іншої причини, і пошук іде далі.
      const provesWave = (): boolean => {
        const report = o3Report
        if (report === undefined) return false
        const join = report.joins.find(
          (j) =>
            report.objects.includes(j.object) &&
            j.at + REJOIN_JITTER_MS === report.bound
        )
        return (
          join !== undefined &&
          report.server.some(
            (c) => report.objects.includes(c.object) && c.at <= join.at
          ) &&
          !report.reads.some(
            (r, n) =>
              n >= join.after! &&
              r.at <= report.bound &&
              r.object !== undefined &&
              report.objects.includes(r.object)
          )
        )
      }
      const run = (defects: readonly DefectFlag[]) =>
        fc.asyncProperty(
          fc.array(SIGNAL_STEP, { minLength: 10, maxLength: 80, size: "max" }),
          fc.boolean(),
          fc.constantFrom<Profile>("full", "scroll", "burial"),
          async (steps, preloaded, profile) => {
            o3Report = undefined
            try {
              await modelRun(
                runModel(
                  steps,
                  preloaded,
                  profile,
                  defects,
                  true,
                  true,
                  true,
                  LONG_INTERVAL_MS
                )
              )
            } catch (error) {
              if (
                error instanceof ModelFailure &&
                CAUGHT_BY[flag]!.test(error.message) &&
                !provesWave()
              )
                return
              throw error
            }
          }
        )
      const result = await fc.check(run([flag]), {
        numRuns: 10_000,
        seed: SELF_CHECK_SEEDS[flag] ?? 1,
        endOnFailure: true,
        ...interruptWithin(RIGHTS_BUDGET_MS),
      })
      expect(result.failed, `${flag} not caught`).toBe(true)
      expect(result.errorInstance).toBeInstanceOf(ModelFailure)
      expect((result.errorInstance as Error).message).toMatch(CAUGHT_BY[flag]!)
      // Контроль: той самий прогін без дефекту зелений.
      const [steps, preloaded, profile] = result.counterexample!
      await modelRun(
        runModel(
          steps,
          preloaded,
          profile,
          [],
          true,
          true,
          true,
          LONG_INTERVAL_MS
        )
      )
      // З дефектом він червоний саме хвилею.
      o3Report = undefined
      await expect(
        modelRun(
          runModel(
            steps,
            preloaded,
            profile,
            [flag],
            true,
            true,
            true,
            LONG_INTERVAL_MS
          )
        )
      ).rejects.toBeInstanceOf(ModelFailure)
      expect(provesWave(), "the counterexample does not prove the wave").toBe(
        true
      )
    },
    RIGHTS_BUDGET_MS
  )

  // Дефекти планувальника — і в прогонах з сигналами: пропуск перечитувань
  // від сигналу не затуляє їх (бюджет приймача).
  it.each([...SIGNAL_DEFECTS, ...SCHEDULER_DEFECTS])(
    "turns red with signals and the defect %s",
    async (flag) => {
      tickReads = 0
      const example = SELF_CHECK_EXAMPLES[flag]
      const result = await fc.check(property([flag], true, true, true), {
        numRuns: 10_000,
        ...(example === undefined ? {} : { examples: [example] }),
        seed: SIGNAL_SELF_CHECK_SEEDS[flag] ?? SELF_CHECK_SEEDS[flag] ?? 1,
        endOnFailure: true,
        ...interruptWithin(RIGHTS_BUDGET_MS),
      })
      expect(result.failed, `${flag} not caught`).toBe(true)
      expect(result.errorInstance).toBeInstanceOf(ModelFailure)
      // Контроль: той самий прогін без дефекту зелений.
      const [steps, preloaded, profile] = result.counterexample!
      await modelRun(runModel(steps, preloaded, profile, [], true, true, true))
      expect((result.errorInstance as Error).message).toMatch(CAUGHT_BY[flag]!)
      if (SCHEDULER_DEFECTS.includes(flag))
        expect(tickReads, `${flag}: no tick with a read`).toBeGreaterThan(0)
    },
    RIGHTS_BUDGET_MS
  )
})
