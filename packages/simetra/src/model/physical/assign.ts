import { toSnakeCase } from "../schemas/identity"
import { isSqlReservedWord } from "../schemas/sql-reserved-words"

/**
 * Роль елемента, що її знає правило фізичного імені (спека П2 §3, Р5).
 * `reference` поля — вид цілі `Ref`: одиночне посилання на таблицю отримує
 * `_id`, на перерахування — ні (його значення — мітка, а не ключ), а
 * поліморфному компілятор сам дописує пару `_type`/`_id`.
 */
export type PhysicalNameRole =
  | { role: "object" }
  | { role: "tabularSection"; ownerPhysicalName: string }
  | { role: "field"; reference?: "single" | "enumeration" | "polymorphic" }
  | { role: "label" }
  | { role: "scopeKind" }
  | { role: "column" }

function baseName(logicalName: string, role: PhysicalNameRole): string {
  const snake = toSnakeCase(logicalName)
  switch (role.role) {
    case "tabularSection":
      // ТЧ — окрема таблиця в схемі власника, тож ім'я несе його префікс.
      return `${role.ownerPhysicalName}_${snake}`
    case "scopeKind":
      // Носій скоупу — колонка-ключ кореня.
      return `${snake}_id`
    case "field":
      return role.reference === "single" ? `${snake}_id` : snake
    case "object":
    case "label":
    case "column":
      return snake
  }
}

/**
 * Фізичне ім'я нового елемента — факт моделі, а не CLI. Призначається раз і
 * ніколи не змінюється, тож зарезервоване слово чи зайняте ім'я обходиться
 * суфіксом `_`, доки ім'я не стане вільним: квотування врятувало б SQL, але
 * не читача. `taken` — імена тієї ж області унікальності; їх збирає виклик.
 */
export function assignPhysicalName(
  logicalName: string,
  role: PhysicalNameRole,
  taken: ReadonlySet<string>
): string {
  let name = baseName(logicalName, role)
  while (isSqlReservedWord(name) || taken.has(name)) name += "_"
  return name
}
