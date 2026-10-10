import { PLATFORM_SCHEMA } from "simetra/model"
import type { QualifiedName } from "../contracts"

/**
 * Функція поточного користувача платформного шару (спека користувачів §7). Одне
 * ім'я на генератор шару, обгортку в згенерованих функціях членства й перевірку
 * голого виклику (С9): перейменування в генераторі інакше мовчки вимкнуло б
 * перевірку, а тести на старе ім'я лишились би зеленими.
 */
export const CURRENT_USER_FUNCTION: QualifiedName = {
  schema: PLATFORM_SCHEMA,
  name: "current_user_id",
}
