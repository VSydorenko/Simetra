// Модуль без імпортів: його читає й генератор `scripts/builtin-functions.ts`
// під голим `node`, який не розв'язує псевдоніми пакета.

/**
 * Клас вбудованих функцій `pg_catalog`, яких немає в дозвільному переліку
 * `BUILTIN_FUNCTIONS` (Р2c1-20): точні імена й префікси імен. Виключається
 * ціле ім'я: перевантаження компілятор не розрізняє.
 */
export interface BuiltinExclusion {
  reason: string
  names: readonly string[]
  prefixes: readonly string[]
  /**
   * Клас, чиї імена виводить із каталогу генератор (`REGCLASS_BUILTINS`
   * згенерованого переліку), а не перелічує рука.
   */
  derived?: "regclassParameter"
}

/**
 * Імена вбудованих initdb, у яких хоч один аргумент (зокрема `OUT`) має тип
 * `regclass`. Один запит для генератора й DB-тесту: клас — не ручний
 * перелік, тож нова така функція нового мажора виключається сама.
 */
export const REGCLASS_PARAMETER_QUERY = `SELECT proname AS name
FROM pg_proc
WHERE pronamespace = 'pg_catalog'::regnamespace AND oid < 16384
  AND ('regclass'::regtype = ANY (proargtypes::oid[])
    OR 'regclass'::regtype = ANY (coalesce(proallargtypes, '{}')))
GROUP BY proname`

// Текст, який функція виконає, статично не відомий, тож її виклик —
// зміна сесії невідомою формою (`dynamicText`, Р2c1-32), а в голові —
// виконання довільного SQL повз судження її тіла.
const SQL_TEXT: BuiltinExclusion = {
  reason: "executes SQL text",
  names: ["ts_stat", "ts_rewrite"],
  prefixes: [
    "query_to_xml",
    "cursor_to_xml",
    "table_to_xml",
    "schema_to_xml",
    "database_to_xml",
  ],
}

export const BUILTIN_EXCLUSIONS: readonly BuiltinExclusion[] = [
  SQL_TEXT,
  // Налаштування сесії ставить лише платформа (Р2b1-19): `set_config`
  // голови підмінив би контекст команди чи claims посеред оператора.
  { reason: "writes a session setting", names: ["set_config"], prefixes: [] },
  // Сесійний замок переживає транзакцію в сесії пулу й тримає чужі команди;
  // транзакційні (`pg_advisory_xact_lock*`) знімаються разом із командою.
  {
    reason: "takes a session-level advisory lock",
    names: [],
    prefixes: [
      "pg_advisory_lock",
      "pg_advisory_unlock",
      "pg_try_advisory_lock",
    ],
  },
  // Файли сервера (конфігурація, керуючий файл, підсумки WAL), журнали,
  // каталог даних і пам'ять сервера — поза межею даних застосунку.
  {
    reason: "reads server files or server state",
    names: [
      "pg_stat_file",
      "pg_current_logfile",
      "pg_hba_file_rules",
      "pg_ident_file_mappings",
      "pg_show_all_file_settings",
      "pg_available_wal_summaries",
      "pg_wal_summary_contents",
      "pg_config",
      "pg_get_shmem_allocations",
      "pg_get_backend_memory_contexts",
    ],
    prefixes: ["pg_read_", "pg_ls_", "pg_control_"],
  },
  // Large objects — сховище поза таблицями: ні RLS, ні механіка його не
  // бачать, а `lo_import`/`lo_export` ще й читають і пишуть файли сервера.
  {
    reason: "reads or writes large objects",
    names: ["loread", "lowrite"],
    prefixes: ["lo_"],
  },
  // Керування сервером, іншими сесіями, WAL і реплікацією — адміністрування,
  // а не логіка застосунку.
  {
    reason: "administers the server or replication",
    names: [
      "pg_terminate_backend",
      "pg_cancel_backend",
      "pg_reload_conf",
      "pg_rotate_logfile",
      "pg_promote",
      "pg_log_backend_memory_contexts",
      "pg_switch_wal",
      "pg_backup_start",
      "pg_backup_stop",
      "pg_import_system_collations",
      "pg_extension_config_dump",
      "pg_drop_replication_slot",
      "pg_sync_replication_slots",
      "pg_get_replication_slots",
      "pg_show_replication_origin_status",
      "pg_log_standby_snapshot",
      "pg_get_wal_replay_pause_state",
      "pg_is_wal_replay_paused",
      "pg_last_xact_replay_timestamp",
      "pg_get_wal_summarizer_state",
      "pg_stop_making_pinned_objects",
      "pg_nextoid",
    ],
    prefixes: [
      "pg_stat_reset",
      "pg_replication_",
      "pg_create_",
      "pg_copy_",
      "pg_logical_",
      "pg_wal_replay_",
      "pg_last_wal_",
      "binary_upgrade_",
    ],
  },
  // Сон тримає команду й замки; послідовність змінюється поза транзакцією,
  // тож її відкат команди не повертає.
  {
    reason: "sleeps or changes a sequence",
    names: ["setval", "nextval", "currval", "lastval"],
    prefixes: ["pg_sleep"],
  },
  // Сповіщення, знімок для інших сесій, стан чужих сесій (замки й хто кого
  // блокує), знімок і скидання статистики сесії, позиція й файли WAL, стан
  // індексів — ефекти й читання поза рядками даних, яких права не судять.
  {
    reason: "touches state outside data rows or other sessions",
    names: [
      "pg_notify",
      "pg_export_snapshot",
      "pg_lock_status",
      "pg_blocking_pids",
      "pg_safe_snapshot_blocking_pids",
      "pg_isolation_test_session_is_blocked",
      "pg_stat_clear_snapshot",
      "pg_stat_force_next_flush",
      "pg_current_wal_lsn",
      "pg_current_wal_insert_lsn",
      "pg_current_wal_flush_lsn",
    ],
    prefixes: [
      "pg_stat_get_",
      "pg_backend_",
      "brin_",
      "gin_clean_",
      "pg_walfile_name",
    ],
  },
  // Аргумент `regclass` називає відношення текстом
  // (`pg_relation_size('auth.users')`): збирач відношень його не бачить, тож
  // така функція діяла б на таблицю повз судження відношень.
  {
    reason: "acts on a relation named by a regclass argument",
    names: [],
    prefixes: [],
    derived: "regclassParameter",
  },
  // Ввід значення за текстовим іменем типу виконує CHECK домену, тобто
  // вираз, якого голова не називає.
  {
    reason: "parses input of a type named by text",
    names: [],
    prefixes: ["pg_input_"],
  },
]

// Голова читає лише відношення, які називає дерево (Р2c1-18), а ці вбудовані
// називають відношення текстом (`has_table_privilege('auth.users', …)`,
// `to_regclass('x.y')`): збирач відношень такого імені не бачить. Поза
// головою вони лишаються в переліку — подання й політики прийнятих баз їх
// уживають, а видно з них лише метадані (відомі обмеження плану). Ручний
// перелік з рев'ю: аргумент типу `text` каталог за роллю не розрізняє.
/**
 * Builtins that name a relation by a text argument: refused in heads only.
 */
export const HEAD_EXCLUDED_BUILTINS: readonly string[] = [
  "has_any_column_privilege",
  "has_column_privilege",
  "has_sequence_privilege",
  "has_table_privilege",
  "pg_get_object_address",
  "pg_get_serial_sequence",
  "pg_get_viewdef",
  "regclass",
  "regclassin",
  "to_regclass",
]

/**
 * Імена класу `regclassParameter`: генератор — свіжі з каталогу, решта —
 * `REGCLASS_BUILTINS` згенерованого переліку. Модуль без імпортів, тож
 * імена приходять параметром.
 */
const matches = (
  exclusion: BuiltinExclusion,
  name: string,
  regclass: ReadonlySet<string>
): boolean =>
  exclusion.names.includes(name) ||
  exclusion.prefixes.some((prefix) => name.startsWith(prefix)) ||
  (exclusion.derived === "regclassParameter" && regclass.has(name))

/**
 * Чи виключає ім'я вбудованої функції хоч один клас `BUILTIN_EXCLUSIONS`;
 * `regclass` — імена вбудованих з аргументом `regclass`.
 */
export function excludedBuiltin(
  name: string,
  regclass: ReadonlySet<string>
): boolean {
  return BUILTIN_EXCLUSIONS.some((exclusion) =>
    matches(exclusion, name, regclass)
  )
}

/** Чи виконує вбудована функція з цим ім'ям текст SQL (Р2c1-32). */
export function executesSqlText(name: string): boolean {
  return matches(SQL_TEXT, name, new Set())
}
