export const READ_ONLY_FLAG = "--read-only"
export const ALLOW_DATABASE_WRITE_FLAG = "--allow-database-write"
export const ALLOW_DATA_WRITE_FLAG = "--allow-data-write"
export const ALLOW_RIGHTS_WRITE_FLAG = "--allow-rights-write"

/** Типова змінна середовища з рядком підключення; ім'я фіксується при запуску. */
export const DEFAULT_DATABASE_URL_ENV = "SIMETRA_DATABASE_URL"

/**
 * Єдине джерело тексту «як увімкнути запис»: його бачить і клієнт MCP в
 * `instructions`, і агент у відмові на запис у режимі лише читання.
 * `launchArgs` — справжній argv запуску сервера без node і скрипта, тобто
 * лише ХВІСТ `args` у конфігу клієнта: лаунчер (`pnpm exec simetra …`,
 * `npx …`, обгортка) додає свої аргументи попереду. Тому підказка каже
 * «прибери прапорець» і показує хвіст до й після, а не видає його за повний
 * `"args"` — буквальна заміна зламала б конфіг.
 */
export function readOnlyHint(
  launchArgs: readonly string[] = ["simetra", "mcp", READ_ONLY_FLAG]
): string {
  const before = launchArgs.includes(READ_ONLY_FLAG)
    ? launchArgs
    : [...launchArgs, READ_ONLY_FLAG]
  const after = before.filter((a) => a !== READ_ONLY_FLAG)
  return [
    `This server runs with ${READ_ONLY_FLAG}: tools that write are disabled.`,
    `To enable them, remove ${READ_ONLY_FLAG} from this server's args in the MCP client config and restart it:`,
    `args ending in ${JSON.stringify(before)} become ${JSON.stringify(after)}.`,
  ].join(" ")
}

/**
 * Підказка відмови `apply` без прапорця запису в базу і її ж речення в
 * `instructions`. Як і `readOnlyHint`, показує лише хвіст `args`: прапорець
 * додається, а не замінює конфіг. Вмикає його людина, а не агент: запис у
 * базу поза git, тож рішення — при запуску сервера.
 */
export function databaseWriteHint(
  launchArgs: readonly string[] = ["simetra", "mcp"],
  o: { refusal?: boolean; tools?: string } = {}
): string {
  const before = launchArgs.filter((a) => a !== ALLOW_DATABASE_WRITE_FLAG)
  const after = [...before, ALLOW_DATABASE_WRITE_FLAG]
  return [
    `This server runs without ${ALLOW_DATABASE_WRITE_FLAG}: ${o.tools ?? "apply"} cannot write to the database.`,
    `Only the owner may enable it: add ${ALLOW_DATABASE_WRITE_FLAG} to this server's args in the MCP client config and restart it:`,
    `args ending in ${JSON.stringify(before)} become ${JSON.stringify(after)}.`,
    // «Nothing changed.» — фраза відмови; в `instructions` вона хибно
    // читалася б як підсумок дії, тож туди йде варіант без неї
    ...(o.refusal === false ? [] : ["Nothing changed."]),
  ].join(" ")
}

/**
 * Називає лише змінну, ніколи її значення: рядок підключення несе
 * користувача й пароль, а відмова йде агентові й у журнали клієнта.
 * Середовище команди задає сам викликач перед наступним запуском, а
 * середовище MCP-сервера фіксується при його старті — звідси дві поради.
 */
export function noDatabaseHint(
  envName: string,
  channel: "cli" | "mcp"
): string {
  const how =
    channel === "cli"
      ? `Export the environment variable ${envName} with the connection string of the target database, or name another variable with --database-url-env.`
      : `Set the environment variable ${envName} to the connection string of the target database in this server's environment and restart the server.`
  return [
    `This tool needs a database connection, and ${channel === "cli" ? "none is configured" : "the server has none"}.`,
    how,
    "Nothing changed.",
  ].join(" ")
}

/**
 * Підказка відмови запису даних без прапорця і її речення в `instructions`.
 * Окремий прапорець від запису в базу: засів тестових даних не дає права
 * змінювати схему, і навпаки. Форма — як `databaseWriteHint`: хвіст `args`
 * до й після.
 */
export function dataWriteHint(
  launchArgs: readonly string[] = ["simetra", "mcp"],
  o: { refusal?: boolean; tools?: string } = {}
): string {
  const before = launchArgs.filter((a) => a !== ALLOW_DATA_WRITE_FLAG)
  const after = [...before, ALLOW_DATA_WRITE_FLAG]
  return [
    `This server runs without ${ALLOW_DATA_WRITE_FLAG}: ${o.tools ?? "data-command"} cannot change application data.`,
    `Only the owner may enable it: add ${ALLOW_DATA_WRITE_FLAG} to this server's args in the MCP client config and restart it:`,
    `args ending in ${JSON.stringify(before)} become ${JSON.stringify(after)}.`,
    ...(o.refusal === false ? [] : ["Nothing changed."]),
  ].join(" ")
}

/**
 * Відмова запису прав без прапорця. Довідники прав (і створення кореня
 * скоупу, творець якого отримує роль) змінюють, хто що може, тож їх вмикає
 * людина окремим прапорцем навіть там, де запис даних уже дозволено. CLI
 * радить прапорець команди, MCP — прапорець запуску сервера.
 */
export function rightsWriteHint(
  launchArgs: readonly string[] = ["simetra", "mcp"],
  channel: "cli" | "mcp" = "mcp"
): string {
  const what =
    "This operation changes rights: it writes a rights catalog (roles or role assignments) or creates a scope root whose creator receives a role."
  if (channel === "cli")
    return [
      what,
      `Run the command again with ${ALLOW_RIGHTS_WRITE_FLAG} if you mean to change rights.`,
      "Nothing changed.",
    ].join(" ")
  const before = launchArgs.filter((a) => a !== ALLOW_RIGHTS_WRITE_FLAG)
  const after = [...before, ALLOW_RIGHTS_WRITE_FLAG]
  return [
    what,
    `This server runs without ${ALLOW_RIGHTS_WRITE_FLAG}. Only the owner may enable it: add ${ALLOW_RIGHTS_WRITE_FLAG} to this server's args in the MCP client config and restart it:`,
    `args ending in ${JSON.stringify(before)} become ${JSON.stringify(after)}.`,
    "Nothing changed.",
  ].join(" ")
}

/**
 * Відмова без ресурсу даних. Як і `noDatabaseHint`, називає лише змінну,
 * ніколи її значення. Типової змінної немає: доступ від імені користувача —
 * явне рішення людини (`--data-url-env` і `--as`), тож без імені підказка
 * називає обидва прапорці, а з іменем — порожню змінну.
 */
export function noDataHint(
  envName: string | undefined,
  channel: "cli" | "mcp"
): string {
  const flags =
    "--data-url-env <name of the environment variable with the connection string of the runtime login role> and --as <user uuid>"
  let how: string
  if (envName === undefined)
    how =
      channel === "cli"
        ? `Pass ${flags}.`
        : `Add ${flags} to this server's args in the MCP client config and restart it.`
  else
    how =
      channel === "cli"
        ? `The environment variable ${envName} is empty: export it with the connection string of the development database.`
        : `The environment variable ${envName} is empty: set it to the connection string of the development database in this server's environment and restart the server.`
  return [
    `This tool needs access to the development database data, and ${channel === "cli" ? "none is configured" : "the server has none"}.`,
    how,
    "Nothing changed.",
  ].join(" ")
}
