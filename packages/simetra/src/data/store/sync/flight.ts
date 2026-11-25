import type { WriteLease } from "../source"
import type { Subset } from "../subsets"
import type { ReadCause, ReadTarget, SiteCode, TestSite } from "./vocabulary"

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
} & { readonly [FLIGHT]: true }

/** Те, що шлях додає до польоту, крім причини, цілі й коду. */
export interface FlightExtras {
  readonly attempt?: number
  readonly caller?: Subset
  readonly lease?: WriteLease
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

/**
 * Допуск читання. SK-1 (частина А) допускає все; таблицю умов додає задача 3.
 * `issued` — політ видав цей шлюз: літерал, політ іншої сесії чи тестового
 * входу читання ядра відмовляє (Р-SK1-2).
 */
export interface Gate {
  admit(
    cause: ReadCause,
    target: ReadTarget,
    site: SiteCode,
    extras?: FlightExtras
  ): Flight
  issued(flight: Flight): boolean
}

function issue(
  gate: Gate | undefined,
  cause: ReadCause,
  target: ReadTarget,
  site: SiteCode | TestSite,
  extras: FlightExtras
): Flight {
  const { attempt, caller, lease } = extras
  const record: ReadRecord = {
    ...cause,
    target,
    site,
    ...(attempt === undefined ? {} : { attempt }),
  }
  const flight = {
    ...record,
    ...(caller === undefined ? {} : { caller }),
    ...(lease === undefined ? {} : { lease }),
  } as Flight
  registry.set(flight, { record, gate })
  return flight
}

export function createGate(): Gate {
  const gate: Gate = {
    admit: (cause, target, site, extras = {}) =>
      issue(gate, cause, target, site, extras),
    issued: (flight) => registry.get(flight)?.gate === gate,
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
