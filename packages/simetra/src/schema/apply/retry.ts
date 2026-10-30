import { ApplyDbError } from "./port"

/**
 * Повторювані SQLSTATE: конфлікт блокувань (`lock_timeout`), взаємне
 * блокування й збій серіалізації. Один перелік для раннера й для SQL
 * перевірок (спека промоції §7.2): валідатори тіл беруть `ACCESS SHARE`
 * на таблиці, які називають тіла, зокрема поза слідом, і чужий замок мусить
 * дійти до раннера повтором спроби, а не помилкою функції.
 */
export const RETRYABLE_SQLSTATES: readonly string[] = [
  "55P03",
  "40P01",
  "40001",
]

/**
 * Повторювана помилка бази: її не перетворюють на діагностику перевірки чи
 * кроку, а прокидають далі як є. Раннер повторює спробу лише на її частині
 * (без збою серіалізації).
 */
export const isRetryable = (error: unknown): boolean =>
  error instanceof ApplyDbError &&
  error.sqlstate !== undefined &&
  RETRYABLE_SQLSTATES.includes(error.sqlstate)
