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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
