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
 * Збій створення тіні чи підключення до неї з причиною, якої адаптер не
 * розпізнав: причина — у `cause`. Межа описує її адресою сервера, де мала
 * з'явитися тінь, і називає вимогу тіні до режиму з'єднання (спека designer
 * §3.2).
 */
export class ShadowServerError extends Error {
  override name = "ShadowServerError"
  constructor(
    cause: unknown,
    /** Сервер — окремий `--shadow-url-env`, а не сервер цілі. */
    readonly onShadowBase: boolean
  ) {
    super("the shadow could not be created or reached", { cause })
  }
}

/** Шаблон тіні профілю відсутній або не запечатаний суперкористувачем: його готує `simetra roles`. */
export class ShadowTemplateMissingError extends Error {
  override name = "ShadowTemplateMissingError"
  constructor(readonly template: string) {
    super(`the shadow template database "${template}" is missing or not sealed`)
  }
}

/** Профіль `postgres` будує тіні з шаблону кластера цілі й окремого сервера тіней не має. */
export class ShadowBaseUnsupportedError extends Error {
  override name = "ShadowBaseUnsupportedError"
  constructor() {
    super("a separate shadow server is not supported with the postgres profile")
  }
}
