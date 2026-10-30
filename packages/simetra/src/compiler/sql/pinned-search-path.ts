import {
  alterTouchesSearchPath,
  hasEffectiveEmptySearchPath,
} from "./closed-forms"
import type { SqlUnit } from "./units"

/**
 * Інваріант конвеєра: кожна згенерована функція має ефективний
 * `SET search_path = ''`, і жодна згенерована одиниця не змінює й не скидає
 * його окремим `ALTER FUNCTION`. Тіла генераторів кваліфікують імена,
 * розраховуючи на порожній шлях; функція без нього розв'язала б ім'я за
 * шляхом сесії, тобто в схемі, яку може підмінити той, хто кличе. Один
 * інваріант на виході ловить нове місце рендеру, що забуло опцію, замість
 * точкових тестів кожного генератора. SQL застосунку (без `generator`) судить
 * гейт закритих форм, а не цей інваріант: там порушення — діагностика, не
 * дефект платформи. Тому й `ALTER FUNCTION` застосунку тут не враховується.
 */
export function assertPinnedSearchPath(
  units: readonly Pick<
    SqlUnit,
    "class" | "identity" | "schema" | "name" | "tree" | "generator"
  >[]
): void {
  const generated = units.filter((unit) => unit.generator !== undefined)
  for (const unit of generated) {
    if (alterTouchesSearchPath(unit.tree)) {
      throw new Error(
        `internal: generated ${unit.identity} changes search_path of a function`
      )
    }
    const isFunction =
      (unit.tree as { CreateFunctionStmt?: unknown }).CreateFunctionStmt !==
      undefined
    if (isFunction && !hasEffectiveEmptySearchPath(unit, generated)) {
      throw new Error(
        `internal: generated function ${unit.identity} without SET search_path = ''`
      )
    }
  }
}
