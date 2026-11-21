import type { QualifiedName } from "../contracts"
import { generatedTableFunctionName } from "./generated-names"

// Листовий модуль, як `guard-names.ts`: імена потрібні генератору сигналів
// прав і реєстру платформних тригерів, а реєстр не тягне генератора.

/** Подія тригера сигналу прав: окремий тригер на кожну, бо таблиці переходу. */
export type RightsSignalOperation = "INSERT" | "UPDATE" | "DELETE"

const FUNCTION_LABEL = "simetra_rights_signal"

/** Функція сигналу прав таблиці фактів — одна на всі її тригери. */
export function rightsSignalFunctionName(table: QualifiedName): QualifiedName {
  return {
    schema: table.schema,
    name: generatedTableFunctionName(table.name, FUNCTION_LABEL),
  }
}

/**
 * Тригери сигналу прав таблиці фактів (спека П4-B §8.2) за подіями. Тригери
 * операторні й `AFTER`, тож із рядковими `BEFORE` платформи не
 * перемежовуються й спільного префікса групи не потребують.
 */
export function rightsSignalTriggerNames(
  table: QualifiedName
): readonly { operation: RightsSignalOperation; trigger: string }[] {
  return (["INSERT", "UPDATE", "DELETE"] as const).map((operation) => ({
    operation,
    trigger: generatedTableFunctionName(
      table.name,
      `${FUNCTION_LABEL}_${operation.toLowerCase()}`
    ),
  }))
}
