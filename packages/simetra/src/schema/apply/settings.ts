import type { EngineSetting } from "../engine"
import type { ApplyTransaction } from "./port"

/**
 * `run` під налаштуваннями `settings` (рішення 2 плану П3-2b-1): поточні
 * значення читаються, нові ставляться `set_config(…, true)`, після `run`
 * збережені повертаються тим самим способом. Лише в межах транзакції: за
 * пулером сесійне значення осіло б на чужому backend (рішення 14 плану
 * П3-1). Помилка в `run` летить як є — спроба зупиняється, транзакцію
 * відкочено, і повертати нічого.
 */
export async function withLocalSettings<T>(
  tx: ApplyTransaction,
  settings: readonly EngineSetting[],
  run: () => Promise<T>
): Promise<T> {
  if (settings.length === 0) return run()
  const names = settings.map((s) => s.name)
  const saved = await tx.query<{ value: string }>(
    `SELECT pg_catalog.current_setting(s.name) AS value
     FROM pg_catalog.unnest($1::text[]) WITH ORDINALITY AS s(name, i)
     ORDER BY s.i`,
    [names]
  )
  if (saved.length !== names.length)
    throw new Error("current_setting returned a row count other than asked")
  await setLocal(
    tx,
    names,
    settings.map((s) => s.value)
  )
  const result = await run()
  await setLocal(
    tx,
    names,
    saved.map((r) => r.value)
  )
  return result
}

/**
 * Пари одним оператором. `ROWS FROM` з кваліфікованими `unnest` — та сама
 * форма, що `unnest(a, b)`: багатоаргументний `unnest` у `FROM` існує лише
 * некваліфікованим, а ім'я без схеми залежало б від `search_path`, який цей
 * оператор саме й ставить.
 */
async function setLocal(
  tx: ApplyTransaction,
  names: readonly string[],
  values: readonly string[]
): Promise<void> {
  await tx.query(
    `SELECT pg_catalog.set_config(s.name, s.value, true)
     FROM ROWS FROM (pg_catalog.unnest($1::text[]), pg_catalog.unnest($2::text[]))
       AS s(name, value)`,
    [names, values]
  )
}

/**
 * Закріплені налаштування даних: під ними йдуть кроки даних і заміри
 * збереження «до» й «після», тож репетиція й робота рахують вирази й текст
 * значень однаково. Перелік і причини — спека промоції §7.2 «Закріплені
 * налаштування даних»; тест звіряє цей перелік із нею.
 */
export const DATA_SETTINGS: readonly EngineSetting[] = [
  { name: "search_path", value: "pg_catalog, pg_temp" },
  { name: "TimeZone", value: "UTC" },
  { name: "DateStyle", value: "ISO, MDY" },
  { name: "IntervalStyle", value: "postgres" },
  { name: "extra_float_digits", value: "1" },
  { name: "bytea_output", value: "hex" },
  { name: "lc_monetary", value: "C" },
  { name: "timezone_abbreviations", value: "Default" },
  { name: "standard_conforming_strings", value: "on" },
  { name: "array_nulls", value: "on" },
  { name: "transform_null_equals", value: "off" },
  { name: "quote_all_identifiers", value: "off" },
  { name: "xmloption", value: "content" },
  { name: "xmlbinary", value: "base64" },
  { name: "row_security", value: "off" },
]

/**
 * Налаштування кроків копій носіїв (Р2b2-9): лише обхід політик. Закріплені
 * налаштування даних потрібні виразам, а крок копій переносить значення в
 * колонку того самого типу; тригери на таблиці при цьому не вимкнені, тож
 * їхні тіла мусять іти під `search_path` транзакції.
 */
export const CARRIER_STEP_SETTINGS: readonly EngineSetting[] = [
  { name: "row_security", value: "off" },
]

/**
 * Налаштування ревалідації тіл (рішення 2, 3): при вимкненій валідації
 * валідатор мови нічого не перевіряє, а шлях — сесійний шлях цілі, записаний
 * планом під `planHash`. Закріплений `pg_catalog, pg_temp` зробив би
 * некваліфіковані імена тіл помилками і до кроків, і після — сліпа зона.
 */
export function revalidationSettings(searchPath: string): EngineSetting[] {
  return [
    { name: "check_function_bodies", value: "on" },
    { name: "search_path", value: searchPath },
  ]
}

/** Шлях пошуку сесії цілі: його план записує для ревалідації. */
export async function readSessionSearchPath(
  tx: ApplyTransaction
): Promise<string> {
  const [row] = await tx.query<{ path: string }>(
    "SELECT pg_catalog.current_setting('search_path') AS path"
  )
  if (row === undefined) throw new Error("current_setting returned no row")
  return row.path
}
