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

// Запис — копія полів у мить видачі: політ, зібраний не шлюзом, у реєстрі
// відсутній і подій не дає.
const records = new WeakMap<Flight, ReadRecord>()

/** Запис шлюзу про політ; `undefined` — політ видав не шлюз. */
export const recordOf = (flight: Flight): ReadRecord | undefined =>
  records.get(flight)

/** Допуск читання. SK-1 (частина А) допускає все; таблицю умов додає задача 3. */
export interface Gate {
  admit(
    cause: ReadCause,
    target: ReadTarget,
    site: SiteCode,
    extras?: FlightExtras
  ): Flight
  /** Вхід тестів: ті самі польоти, але з кодом `TEST_SITE`. */
  admitTest(
    cause: ReadCause,
    target: ReadTarget,
    site: SiteCode | TestSite,
    extras?: FlightExtras
  ): Flight
}

export function createGate(): Gate {
  const issue: Gate["admitTest"] = (cause, target, site, extras = {}) => {
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
    records.set(flight, record)
    return flight
  }
  return { admit: issue, admitTest: issue }
}
