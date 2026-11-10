/**
 * Відмови ядра (спека П4 §6.10): `MESSAGE` — код, `DETAIL` — причина чи
 * ключ; даних рядка відмова не несе (Рт4). Єдине джерело для генераторів
 * SQL (T1) і рантайму команд (T3): T3 не імпортує T1.
 */
export const COMMAND_CORE_ERRORS = {
  // Решта `DETAIL` `22023` — фізична колонка, яку T3 перекладає в шлях
  // каталогу; ці причини називають аргумент чи гілку ядра замість колонки.
  invalid: {
    errcode: "22023",
    message: "command.invalid",
    create: "create",
    item: "p_item",
    // Водночас префікс протоколу `tabular.<таблиця>[.<колонка>]`: ТЧ і її
    // колонку `DETAIL` називає під ним.
    tabular: "tabular",
    expectedVersion: "p_expected_version",
    mark: "p_mark",
    predefined: "predefined",
    // Рядок членства творця кореня (спека П4 §6.13): сам аргумент і префікс
    // протоколу `creatorMember.<колонка>`.
    creatorMember: "creatorMember",
  },
  context: {
    errcode: "42501",
    message: "command.context",
    detail: "phase",
    missing: "missing",
    malformed: "malformed",
    unknownAction: "unknown-action",
  },
  forbidden: {
    errcode: "42501",
    message: "command.forbidden",
    noRight: "no-right",
    newCarrier: "new-carrier",
    effect: "effect",
    // Причини запобіжників прав (спека прав §7): відмови на `COMMIT`.
    rightsContext: "rights-context",
    escalation: "escalation",
    deltaDomain: "delta-domain",
    roleInUse: "role-in-use",
    lastFullAccess: "last-full-access",
  },
  conflict: {
    errcode: "P0001",
    message: "command.conflict",
    version: "version",
    exists: "exists",
  },
} as const

/** Тригер ієрархії відмовляє поза `READ COMMITTED` (спека П4 §6.6). */
export const HIERARCHY_ISOLATION_ERROR = {
  errcode: "0A000",
  message: "hierarchy.isolation",
} as const

/**
 * Типи, які ядро віддає текстом, щоб `jsonb` не округлив їх (Рт1): `numeric` і
 * `bigint`, у тому числі з модифікатором та масивом.
 */
const TEXT_ENCODED_TYPE = /^(bigint|numeric)(\(.*\))?(\[\])?$/

export function isTextEncodedType(pgType: string): boolean {
  return TEXT_ENCODED_TYPE.test(pgType)
}

/** Функція поточного користувача схеми платформи. */
export const CURRENT_USER_FUNCTION_NAME = "current_user_id"

/** Функція хеша застосованого знімка (схема — `PLATFORM_SCHEMA`). */
export const APPLIED_SNAPSHOT_HASH_FUNCTION_NAME = "applied_snapshot_hash"

/** Функція епохи версій рядків бази (схема — `PLATFORM_SCHEMA`). */
export const ROW_VERSION_EPOCH_FUNCTION_NAME = "row_version_epoch"

/** UUID without a scope: the channel and the holder key of an unscoped object. */
export const ZERO_UUID = "00000000-0000-0000-0000-000000000000"
