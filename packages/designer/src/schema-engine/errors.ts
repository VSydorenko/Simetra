/**
 * Помилки адаптера, які межа підключення (`io/database.ts`) розпізнає за
 * класом. Окремий модуль без `pg` і pg-delta: межу імпортує кожен виклик
 * CLI, а двигун вантажиться лише інструментом бази.
 */

/** Тінь на сервері іншої мажорної версії: каталоги двох версій не порівнюються. */
export class ShadowServerMismatchError extends Error {
  override name = "ShadowServerMismatchError"
}

/** Роль підключення не має `CREATEDB` на сервері, де мала б з'явитися тінь. */
export class ShadowCreateRefusedError extends Error {
  override name = "ShadowCreateRefusedError"
  constructor(
    /** Тінь мала бути на окремому сервері `--shadow-url-env`, а не поруч із ціллю. */
    readonly onShadowBase: boolean
  ) {
    super("the connecting role lacks CREATEDB")
  }
}

/**
 * Збій на окремому сервері тіні: причина — у `cause`, а межа описує її
 * адресою сервера тіні, а не цілі.
 */
export class ShadowServerError extends Error {
  override name = "ShadowServerError"
  constructor(cause: unknown) {
    super("the shadow server failed", { cause })
  }
}
