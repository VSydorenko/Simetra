import { PLATFORM_SCHEMA } from "../schemas/pg-schema"

/**
 * Відмови сховища файлів (рішення Р11 ПГ-5): закритий перелік за зразком
 * `COMMAND_CORE_ERRORS`. `errcode` власний, не збігається з `22023`, `42501`
 * чи `P0001`, тож `mapDatabaseError` розпізнає їх за парою код + повідомлення
 * і дає `command.rejected` з причиною `storage.<причина>`, а не
 * `command.internal`. Єдине джерело для SQL (T1) і рантайму (T3).
 */
export const STORAGE_ERRORS = {
  errcode: "SF001",
  message: "storage.rejected",
  // Значення `DETAIL`.
  attachMissing: "attach-missing",
  attachInvalid: "attach-invalid",
  quotaExceeded: "quota-exceeded",
} as const

/** Причини відмов сховища: `DETAIL` разом з префіксом `storage.` у `reason`. */
export const STORAGE_REASONS = [
  STORAGE_ERRORS.attachMissing,
  STORAGE_ERRORS.attachInvalid,
  STORAGE_ERRORS.quotaExceeded,
] as const

/**
 * Ключ байтів файлу в бакеті: `o/<UUID об'єкта каталогу>/<id рядка>`. Він
 * виводиться й ніде не зберігається; лише UUID, тож ключ не несе імен і
 * символів, які S3 тлумачить окремо.
 */
export function fileObjectKey(objectId: string, rowId: string): string {
  if (!UUID.test(objectId) || !UUID.test(rowId)) {
    throw new Error("fileObjectKey takes two UUIDs")
  }
  return `o/${objectId}/${rowId}`
}

/** Чи рядок — рівно ключ файлу `o/<uuid>/<uuid>` (без обходів і маркера). */
export function isFileObjectKey(key: string): boolean {
  const m = /^o\/([^/]+)\/([^/]+)$/.exec(key)
  return m !== null && UUID.test(m[1]!) && UUID.test(m[2]!)
}

/** Чи рядок — рівно префікс об'єкта `o/<uuid>/`. */
export function isFileObjectPrefix(prefix: string): boolean {
  const m = /^o\/([^/]+)\/$/.exec(prefix)
  return m !== null && UUID.test(m[1]!)
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * Таблиці сховища файлів у схемі `simetra` (спека профілю postgres §8): облік
 * обсягу, межа, запис вкладення, а також прив'язка бази до бакета — та стан
 * застосування (`PLATFORM_STATE_TABLES`). Ролям API й команд грантів на них
 * немає — їх читають і пишуть лише definer-функції.
 */
export const STORAGE_TABLES = {
  usage: { schema: PLATFORM_SCHEMA, name: "storage_usage" },
  quota: { schema: PLATFORM_SCHEMA, name: "storage_quota" },
  pending: { schema: PLATFORM_SCHEMA, name: "storage_pending" },
  instance: { schema: PLATFORM_SCHEMA, name: "storage_instance" },
} as const

/**
 * Функції сховища файлів у схемі `simetra` (спека профілю postgres §8.2).
 * `EXECUTE` `headroom` — роль запиту користувача, решти — лише `simetra_files`.
 */
export const STORAGE_FUNCTIONS = {
  attach: "file_attach",
  headroom: "storage_headroom",
  rowsExist: "storage_rows_exist",
  rowPage: "storage_row_page",
  pendingLeft: "storage_pending_left",
  pendingSweep: "storage_pending_sweep",
  instanceId: "storage_instance_id",
} as const
