import type { DefectFlag } from "../defects"
import type { WriteLease } from "../source"
import type { Subset } from "../subsets"
import type { Scope } from "../session"
import type { GenerationToken, ObjectName, ServerRow } from "../types"
import type { FlightKind } from "./flight-kinds"
import { answerOf, JUDGED_CONDITIONS, type JudgedCondition } from "./admission"
import type {
  ReadCause,
  ReadTarget,
  ReadWhy,
  SiteCode,
  TestSite,
} from "./vocabulary"

/*
 * Політ читання і шлюз, що його видає (спека ядра синхронізації §5.3, §5.4,
 * Р-SK1-1…3). Політ — походження SK-0 (причина, ціль, код рядка Додатка Б)
 * плюс запитувач і оренда запису; бренд робить його типом, якого не підміниш
 * літералом. Подію `watchReads` будують із запису реєстру шлюзу за тотожністю
 * польоту, а не з його полів.
 */

declare const FLIGHT: unique symbol

/** Причина, ціль і код рядка: усе, що бачить подія `watchReads`. */
export type ReadRecord = ReadCause & {
  readonly target: ReadTarget
  readonly site: SiteCode | TestSite
  /** Номер спроби цілі «вигляд», з якої йде читання (подія `watchAttempts`). */
  readonly attempt?: number
}

/**
 * Політ читання: запис шлюзу плюс `caller` і `lease` ядра. `caller` — вигляд,
 * що читає (правило першого знімка перечитує саме його); `lease` — оренда
 * запису польоту, яку читання видає на об'єкти частин (§8.4, правило 2). До
 * дроту політ не йде.
 */
export type Flight = ReadRecord & {
  readonly caller?: Subset
  readonly lease?: WriteLease
  /** Вид польоту з таблиці §5.5; ставить шлях, що знає свій вид. */
  readonly kind?: FlightKind
  /** `epochs.now()` у мить допуску (§5.4); `admit` бере її зі стану шлюзу. */
  readonly epoch?: number
  /** Монотонний годинник ядра в мить допуску — лише для строку й пауз. */
  readonly startedAt?: number
  /**
   * Дочірній токен цілі (`gen` вигляду, покоління сторінки чи хвоста), де він
   * є; інакше поле відсутнє, а діє токен сесії.
   */
  readonly token?: GenerationToken
  /**
   * Відмітки purge об'єкта й цілей `include` на старті. Лише там, де `main`
   * їх бере (системне перечитування); для решти purge діє через токен.
   */
  readonly purgeBarrier?: ReadonlyMap<string, number>
  /** Лише `write-confirm`: зворотний виклик запитувача в `commit` осідання. */
  readonly requester?: (outcome: RereadOutcome, scope: Scope) => void
  /** Лише `write-confirm`: межа часу (`REREAD_TIMEOUT_MS`), мс від старту. */
  readonly deadlineMs?: number
  /**
   * Лише `write-confirm`: запитувача вже покликано (Р-SK2-9). Спільне для
   * строку й осідання: пізня відповідь після строку проходить прохід без
   * запитувача.
   */
  readonly done?: { fired: boolean }
} & { readonly [FLIGHT]: true }

/**
 * Наслідок читання ключа після власного запису, який віддається запитувачу:
 * `read` — відповідь пройшла брамою епох (`row` — рядок ключа, `undefined`,
 * коли його немає); `failed` — читання відмовило чи минув строк
 * `REREAD_TIMEOUT_MS`; `discarded` — відповідь з покинутої епохи версій.
 */
export type RereadOutcome =
  | { readonly kind: "read"; readonly row: ServerRow | undefined }
  | { readonly kind: "failed" | "discarded" }

/** Те, що шлях додає до польоту, крім причини, цілі й коду. */
export interface FlightExtras {
  readonly attempt?: number
  readonly caller?: Subset
  readonly lease?: WriteLease
  readonly kind?: FlightKind
  readonly token?: GenerationToken
  readonly purgeBarrier?: ReadonlyMap<string, number>
  readonly requester?: (outcome: RereadOutcome, scope: Scope) => void
  readonly deadlineMs?: number
  readonly done?: { fired: boolean }
}

// Один реєстр: запис — копія полів у мить видачі плюс шлюз, що видав політ
// (`undefined` — тестовий вхід). Політ, зібраний не шлюзом, у реєстрі відсутній
// і подій не дає; політ іншого шлюзу чи тестового входу — не «свій».
const registry = new WeakMap<
  Flight,
  { readonly record: ReadRecord; readonly gate: Gate | undefined }
>()

/** Запис шлюзу про політ; `undefined` — політ видав не шлюз. */
export const recordOf = (flight: Flight): ReadRecord | undefined =>
  registry.get(flight)?.record

declare const PERMIT: unique symbol

/**
 * Дозвіл шлюзу: рішення «читати», ухвалене в мить, де шлях вирішує читати.
 * Політ він видає там, де шлях уже має запитувача, оренду й номер спроби
 * (рішення архітекторки 25.11): між ними немає `await`, і дозвіл ніде не
 * зберігається. Одноразовий: друге `flight()` кидає.
 */
export interface Permit {
  readonly [PERMIT]: true
  /** Причина й рядок інвентаря: їх бачать спроба (`watchAttempts`) і повтор. */
  readonly why: ReadWhy
  readonly target: ReadTarget
  flight(extras?: FlightExtras): Flight
}

/** Відповідь шлюзу (§5.3): дозвіл, «відкладено» чи «відмовлено» з умовою. */
export type Admission =
  | Permit
  | { readonly deferred: JudgedCondition }
  | { readonly refused: JudgedCondition }

export const isPermit = (admission: Admission): admission is Permit =>
  "flight" in admission

/**
 * Стан умов, які судить шлюз; шлюз отримує його функціями при створенні
 * (§5.1). `closed` — токен сесії недійсний, закрито чи закривається
 * (Р-SK1-5), а не знімок `closedSnapshot`; `tabHidden` — стан `visible` ядра,
 * один для ядра, приймача й вимоги складу (Р-SK1-8). Умова без функції не
 * настає.
 */
export interface GateState {
  readonly token: () => GenerationToken
  readonly staleObject?: (object: ObjectName) => boolean
  readonly discardBound?: () => boolean
  readonly tabHidden?: () => boolean
  /** `epochs.now()` сесії: `admit` ставить її в політ як епоху старту. */
  readonly epoch?: () => number
  /** Монотонний годинник ядра: `admit` ставить його як час старту. */
  readonly now?: () => number
  /** Прапорці самотесту (`defects.ts`): мутація шляху сягає й рішення шлюзу. */
  readonly defects?: ReadonlySet<DefectFlag>
}

// Мутації «читання після межі відкинутих» вимикають і перевірку шляху, і
// відповідь шлюзу — але лише для кодів свого шляху: прапорець, що відкрив би
// межу всім, ловився б чужою перевіркою (рішення архітекторки 25.11).
const DISCARD_DEFECTS: readonly (readonly [DefectFlag, readonly SiteCode[]])[] =
  [
    ["scheduler-reads-unavailable", ["R1", "R2", "R3"]],
    ["receiver-reads-unavailable", ["K1", "K2", "R8", "R9"]],
  ]

// Мутація «такт на прихованій вкладці» (`scheduler-fires-hidden`) вимикає
// видимість планувальника — і відповідь шлюзу, але лише для кодів, які читає
// такт (R1, R3 — `runDue`, R2 — звірка, R4 — `fireWave`): інакше прапорець
// не мав би читання, що його червонить (рішення архітекторки 25.11).
const HIDDEN_DEFECTS: readonly (readonly [DefectFlag, readonly SiteCode[]])[] =
  [["scheduler-fires-hidden", ["R1", "R2", "R3", "R4"]]]

/** Прапорець самотесту відкриває умову для цього коду. */
const opened = (
  state: GateState,
  scoped: readonly (readonly [DefectFlag, readonly SiteCode[]])[],
  site: SiteCode
) =>
  scoped.some(
    ([flag, codes]) => state.defects?.has(flag) === true && codes.includes(site)
  )

/**
 * Шлюз допуску. `admit` судить таблицю допуску (`admission.ts`); `issued` —
 * політ видав цей шлюз: літерал, політ іншої сесії чи тестового входу
 * читання ядра відмовляє (Р-SK1-2).
 */
export interface Gate {
  admit(cause: ReadCause, target: ReadTarget, site: SiteCode): Admission
  issued(flight: Flight): boolean
  /**
   * Запит умови `stale-object` поза `admit` (Р-SK1-9): пізня відмова частин
   * уже допущеного польоту (`dispatch`, збирач, джерело, Р-SK1-6) і таймери,
   * що не ставлять строку несумісному об'єкту. Той самий предикат, що судить
   * `admit`.
   */
  staleObject(object: ObjectName): boolean
  /**
   * Запит умови `discard-bound` для таймерів (Р-SK1-9): строк планувальника й
   * такт не ставлять читань після межі відкинутих. Той самий предикат, що
   * судить `admit`.
   */
  discardBound(): boolean
  /**
   * Наслідок осідання за межею (Р-SK1-7): після запису відповіді шлях обирає
   * «`EPOCH_UNAVAILABLE` чи повтор», а строки й збір сигналів гаснуть. Не
   * допуск і не таймер — окремий символ, щоб страж відрізняв його. Той самий
   * предикат, що судить `admit`.
   */
  settledPastBound(): boolean
  /**
   * Запит умови `tab-hidden` поза `admit` (Р-SK1-8, Р-SK1-9): таймери
   * (планувальник, строк знімка прав), діагностика, публічні ознаки
   * (`needsRefresh`, `core.visible`) та іменовані перевірки, що стережуть
   * не-читальні ефекти на прихованій вкладці. Той самий предикат, що судить
   * `admit`.
   */
  tabHidden(): boolean
}

function issue(
  gate: Gate | undefined,
  cause: ReadCause,
  target: ReadTarget,
  site: SiteCode | TestSite,
  extras: FlightExtras,
  start: { readonly epoch?: number; readonly startedAt?: number } = {}
): Flight {
  const { attempt, caller, lease, ...rest } = extras
  const record: ReadRecord = {
    ...cause,
    target,
    site,
    ...(attempt === undefined ? {} : { attempt }),
  }
  // Політ — незмінне значення: поля після видачі не підміниш.
  const flight = Object.freeze({
    ...record,
    ...(caller === undefined ? {} : { caller }),
    ...(lease === undefined ? {} : { lease }),
    // Поля, яких шлях не дав, у польоті відсутні, а не `undefined`.
    ...Object.fromEntries(
      Object.entries(rest).filter(([, value]) => value !== undefined)
    ),
    ...(start.epoch === undefined ? {} : { epoch: start.epoch }),
    ...(start.startedAt === undefined ? {} : { startedAt: start.startedAt }),
  }) as Flight
  registry.set(flight, { record: Object.freeze(record), gate })
  return flight
}

/** Чи настала умова зараз: функція стану, якої немає, — умова не настає. */
function holds(
  state: GateState,
  condition: JudgedCondition,
  target: ReadTarget,
  site: SiteCode
): boolean {
  switch (condition) {
    case "closed":
      return !state.token().valid
    case "stale-object":
      return (
        target.kind !== "service" && state.staleObject?.(target.object) === true
      )
    case "discard-bound":
      return (
        state.discardBound?.() === true && !opened(state, DISCARD_DEFECTS, site)
      )
    case "tab-hidden":
      return (
        state.tabHidden?.() === true && !opened(state, HIDDEN_DEFECTS, site)
      )
  }
}

export function createGate(state: GateState): Gate {
  const gate: Gate = {
    admit(cause, target, site) {
      // Умови в порядку переліку §5.3: `closed` — перша, тож закрита сесія
      // відмовляє незалежно від решти.
      for (const condition of JUDGED_CONDITIONS) {
        if (!holds(state, condition, target, site)) continue
        const answer = answerOf(cause, target.kind, site, condition)
        if (answer === "refuse") return { refused: condition }
        if (answer === "defer") return { deferred: condition }
      }
      let used = false
      return {
        why: { ...cause, site },
        target,
        flight(extras = {}) {
          if (used) throw new Error("a permit issues one flight")
          used = true
          // Епоха й час беруться в мить видачі, де шлях уже вирішив читати:
          // повтор дії проходить `admit` знову й бере нові (§5.4).
          return issue(gate, cause, target, site, extras, {
            ...(state.epoch ? { epoch: state.epoch() } : {}),
            ...(state.now ? { startedAt: state.now() } : {}),
          })
        },
      } as Permit
    },
    issued: (flight) => registry.get(flight)?.gate === gate,
    staleObject: (object) => state.staleObject?.(object) === true,
    discardBound: () => state.discardBound?.() === true,
    settledPastBound: () => state.discardBound?.() === true,
    tabHidden: () => state.tabHidden?.() === true,
  }
  return gate
}

/**
 * Вхід тестів (`testing/`): політ прямого виклику джерела, кодом `TEST_SITE`
 * чи будь-яким кодом інвентаря. Його не видавав шлюз жодної сесії, тож `read`
 * ядра такий політ відмовляє; джерело ж подію за ним дає.
 */
export const issueTestFlight = (
  cause: ReadCause,
  target: ReadTarget,
  site: SiteCode | TestSite,
  extras: FlightExtras = {}
): Flight => issue(undefined, cause, target, site, extras)

/**
 * Політ без запису шлюзу: літерал з правдивими причиною, ціллю й кодом.
 * Лише для мутації самотесту «читання повз шлюз» (`defects.ts`): подія
 * `watchReads` такого польоту не бачить.
 */
export const forgeFlight = (
  cause: ReadCause,
  target: ReadTarget,
  site: SiteCode,
  extras: FlightExtras = {}
): Flight => ({ ...cause, target, site, ...extras }) as Flight
