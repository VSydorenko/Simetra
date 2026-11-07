import { isDate } from "../schemas/value-type"

/*
 * Внутрішній модуль T0 (не реекспортується з `index`): правило моменту дроту
 * спільне для кодека (`wire.ts`) і входу команди (`values.ts`).
 */

// Обидві форми джерел: `T` (JSON PostgREST) і пробіл (текст Postgres); зсув
// `±hh`, `±hh:mm`, `±hhmm`, `±hh:mm:ss` (історичні пояси Postgres). Секунди
// необов'язкові: так їх приймає вхід команди, а `encodeRow` нормалізує його
// значення тим самим розбором.
const DATE_TIME_WIRE =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(?:Z|([+-])(\d{2})(?::?(\d{2})(?::?(\d{2}))?)?)$/

const pad = (value: number, width: number) => String(value).padStart(width, "0")

/**
 * A moment as fixed-width UTC with microseconds (`YYYY-MM-DDTHH:MM:SS.ffffffZ`);
 * `undefined` when the text is not a moment of years 1–9999 in UTC.
 */
// Лексикографічний порядок рядків = часовий. Розбір рядка, а не `Date`: той
// губить мікросекунди. Дріб від зсуву не залежить (зсув — цілі секунди), тож
// `Date` рахує лише цілі секунди, а дріб переноситься рядком. Одне правило
// для дроту й для входу команди: вхід, який декодер не прочитав би з бази,
// відхиляється ще до неї.
export function normalDateTime(value: string): string | undefined {
  const match = DATE_TIME_WIRE.exec(value)
  if (match === null || !isDate(`${match[1]}-${match[2]}-${match[3]}`)) {
    return undefined
  }
  const [year, month, day, hours, minutes, seconds] = match
    .slice(1, 7)
    .map((part) => Number(part ?? 0)) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ]
  const fraction = match[7] ?? ""
  // `timestamptz` зберігає мікросекунди: довший дріб — не значення бази.
  if (hours > 23 || minutes > 59 || seconds > 59 || fraction.length > 6) {
    return undefined
  }
  const sign = match[8] === "-" ? -1 : 1
  const [zoneHours, zoneMinutes, zoneSeconds] = [
    match[9],
    match[10],
    match[11],
  ].map((part) => Number(part ?? 0)) as [number, number, number]
  const date = new Date(0)
  // `setUTCFullYear`, а не `Date.UTC`: той читає роки 0–99 як 1900+.
  date.setUTCFullYear(year, month - 1, day)
  date.setUTCHours(
    hours - sign * zoneHours,
    minutes - sign * zoneMinutes,
    seconds - sign * zoneSeconds
  )
  const utcYear = date.getUTCFullYear()
  if (utcYear < 1 || utcYear > 9999) return undefined
  return (
    `${pad(utcYear, 4)}-${pad(date.getUTCMonth() + 1, 2)}-` +
    `${pad(date.getUTCDate(), 2)}T${pad(date.getUTCHours(), 2)}:` +
    `${pad(date.getUTCMinutes(), 2)}:${pad(date.getUTCSeconds(), 2)}.` +
    `${fraction.padEnd(6, "0")}Z`
  )
}
