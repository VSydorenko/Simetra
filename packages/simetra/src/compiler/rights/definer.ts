import { quoteIdent } from "simetra/model"
import type { QualifiedName } from "../contracts"
import { dollarTag } from "../movement-functions"

/**
 * Тригерна функція `SECURITY DEFINER` платформи (Р2a2-8, Р2b1-8, Р-A1-8):
 * порожній `search_path` і кваліфіковані імена в тілі не лишають простору для
 * підміни імен. `rowSecurity: "off"` — для тіла, що читає таблиці під RLS
 * власника: там політика дала б гучну помилку замість тихої відповіді. Чому
 * кожна функція — `DEFINER`, пояснює її генератор.
 */
export function definerTrigger(
  fn: QualifiedName,
  text: string,
  options: { rowSecurity?: "off" } = {}
): string {
  const tag = dollarTag(text)
  return (
    `CREATE OR REPLACE FUNCTION ${quoteIdent(fn.schema)}.${quoteIdent(fn.name)}()\n` +
    `RETURNS trigger\n` +
    `LANGUAGE plpgsql SECURITY DEFINER\n` +
    `SET search_path = ''\n` +
    (options.rowSecurity === "off" ? `SET row_security = off\n` : "") +
    `AS ${tag}\n${text}\n${tag};`
  )
}
