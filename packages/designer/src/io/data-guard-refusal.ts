import { UsageError } from "./usage-error"

/** Стабільна причина відмови запобіжника: агент читає її, а не текст. */
export type DataGuardDetail = "not-local" | "not-development" | "login-refused"

/**
 * Тексти не називають ні рядка підключення, ні ролі входу: відмова йде
 * агентові й у журнали клієнта. Пізніша версія — П4-F (спека П4 §6.14);
 * назву віхи споживачеві не показуємо.
 */
const MESSAGES: Readonly<Record<DataGuardDetail, string>> = {
  "not-local":
    "Data tools work only with a development database on this machine: the connection string must point to localhost, a 127.x.x.x address, ::1 or a unix socket. Agent access to other databases comes in a later version. Nothing changed.",
  "not-development":
    "The database is not marked as a development database: the database-level setting simetra.environment = 'development' is missing. A superuser sets it on the local development database only. Agent access to other databases comes in a later version. Nothing changed.",
  "login-refused":
    "The connection string must use the runtime login role: a role that is not a superuser, does not bypass row-level security, is neither the migrator nor the provider service role, and may switch to the platform command role. Nothing changed.",
}

/**
 * Відмова запобіжника бази розробника. Окремий легкий модуль: його
 * імпортує `invoke.ts`, і він не мусить тягнути `pg` чи ярус сервера.
 * Запобіжники ловлять випадковий запуск, а не межа безпеки: межа —
 * облікові дані ролі входу рантайму (спека П4 §6.14).
 */
export class DataGuardRefusal extends UsageError {
  override name = "DataGuardRefusal"
  constructor(readonly detail: DataGuardDetail) {
    super(MESSAGES[detail])
  }
}
