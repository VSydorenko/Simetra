import {
  PLATFORM_SCHEMA,
  makeObjectName,
  type PhysicalTable,
} from "simetra/model"
import type { ParsedObject } from "../stages/files"

/** Ім'я таблиці зв'язку «провайдер + subject → користувач» у схемі платформи. */
export const IDENTITIES_TABLE = "identities"

/**
 * `simetra.identities` — похідна таблиця довідника «Користувачі» (спека
 * користувачів §4, спека П2 §8.3), як підсумки регістра: її форма не
 * описується метаданими, а виводиться з наявності довідника. Ключ — пара
 * (провайдер, subject): одна зовнішня ідентичність — рівно один користувач;
 * `UNIQUE (user_id, provider)` — один обліковий запис провайдера на
 * користувача, і він же покриває FK, тож окремого індексу немає. FK
 * відкладений до кінця транзакції: провізія вставляє ідентичність першою.
 * Персональних даних немає — лише ключі. Таблиця закрита для ролей API
 * відсутністю грантів, а не RLS: її читають лише функції платформи.
 */
export function identitiesTable(
  users: ParsedObject,
  usersTable: PhysicalTable
): PhysicalTable {
  const name = IDENTITIES_TABLE
  // Схема платформи зарезервована, тож інших імен у ній немає й імена
  // обмежень — канонічні імена Postgres без обходу колізій.
  const constraint = (columns: readonly string[], label: string) =>
    makeObjectName(name, columns.join("_"), label)
  return {
    schema: PLATFORM_SCHEMA,
    name,
    origin: { objectId: users.id ?? "", part: "identities" },
    rowLevelSecurity: "off",
    columns: [
      { name: "provider", type: "text", notNull: true, origin: {} },
      { name: "subject", type: "text", notNull: true, origin: {} },
      { name: "user_id", type: "uuid", notNull: true, origin: {} },
    ],
    primaryKey: {
      name: makeObjectName(name, undefined, "pkey"),
      columns: ["provider", "subject"],
    },
    uniques: [
      {
        name: constraint(["user_id", "provider"], "key"),
        columns: ["user_id", "provider"],
        nullsNotDistinct: false,
      },
    ],
    checks: [],
    foreignKeys: [
      {
        name: constraint(["user_id"], "fkey"),
        columns: ["user_id"],
        references: {
          schema: usersTable.schema,
          table: usersTable.name,
          columns: [...(usersTable.primaryKey?.columns ?? [])],
        },
        onDelete: "noAction",
        onUpdate: "noAction",
        deferrable: "initiallyDeferred",
      },
    ],
    indexes: [],
  }
}
