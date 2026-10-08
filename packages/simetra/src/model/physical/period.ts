import { quoteIdent } from "./pg-names"

/** Одиниця усічення періоду; єдине оголошення, решта імпортує тип звідси. */
export type PeriodUnit = "year" | "quarter" | "month" | "day"

/**
 * Єдине джерело усічення моменту до дати в поясі проєкту (спека П2/C3):
 * `timestamptz::date` без `AT TIME ZONE` усікає за поясом сесії, тож межа
 * місяця «пливла» б залежно від клієнта. Вираз незмінний (`IMMUTABLE`) лише
 * з явним поясом-літералом, тому його однаково використовують індекси, ключі
 * похідних таблиць і SQL П3 — ніхто не збирає його вдруге.
 */
export function truncatedPeriodExpression(
  column: string,
  unit: PeriodUnit,
  timezone: string
): string {
  // Літерал екранується так само, як `sqlLiteral` стадії 3: лапка подвоюється.
  const zone = `'${timezone.replaceAll("'", "''")}'`
  return `date_trunc('${unit}', (${quoteIdent(column)} AT TIME ZONE ${zone}))::date`
}
