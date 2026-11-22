import { describe, expect, it } from "vitest"
import { PINNED_SESSION_SETTINGS } from "simetra/model"
import { pinnedSettingsClause } from "../../src/compiler/sql/head-settings"
import { withRollback } from "./connection"

/**
 * Налаштування, які сесія може поставити (`context` `user` чи `superuser`),
 * але які платформа не закріплює (`PINNED_SESSION_SETTINGS`): кожна група —
 * з причиною, чому від неї не залежить значення, яке голова чи крок даних
 * читає, обчислює чи повертає (спека декларацій функцій §5.8, спека промоції
 * §7.2). Налаштування, що змінює результат вбудованої чи розбір тіла, сюди не
 * йде — воно в набір.
 */
const NOT_PINNED: readonly { reason: string; names: readonly string[] }[] = [
  {
    reason:
      "only a superuser, or a role granted SET on the parameter, sets it: the platform grants that right to no API role, so a client session cannot change it",
    names: [
      "allow_in_place_tablespaces",
      "allow_system_table_mods",
      "backtrace_functions",
      "commit_delay",
      "composite_type_mismatch",
      "compute_query_id",
      "deadlock_timeout",
      "debug_discard_caches",
      "event_triggers",
      "ignore_checksum_failure",
      "jit_dump_bitcode",
      "lc_messages",
      "lo_compat_privileges",
      "log_duration",
      "log_error_verbosity",
      "log_executor_stats",
      "log_lock_waits",
      "log_min_duration_sample",
      "log_min_duration_statement",
      "log_min_error_statement",
      "log_min_messages",
      "log_parameter_max_length",
      "log_parser_stats",
      "log_planner_stats",
      "log_replication_commands",
      "log_statement",
      "log_statement_sample_rate",
      "log_statement_stats",
      "log_temp_files",
      "log_transaction_sample_rate",
      "max_stack_depth",
      "session_replication_role",
      "temp_file_limit",
      "track_activities",
      "track_counts",
      "track_functions",
      "track_io_timing",
      "track_wal_io_timing",
      "update_process_title",
      "wal_compression",
      "wal_consistency_checking",
      "wal_init_zero",
      "wal_recycle",
      "zero_damaged_pages",
    ],
  },
  {
    reason:
      "a planner method or cost: it changes the plan, not the result of a query with a defined result",
    names: [
      "constraint_exclusion",
      "cpu_index_tuple_cost",
      "cpu_operator_cost",
      "cpu_tuple_cost",
      "cursor_tuple_fraction",
      "debug_parallel_query",
      "default_statistics_target",
      "effective_cache_size",
      "enable_async_append",
      "enable_bitmapscan",
      "enable_gathermerge",
      "enable_group_by_reordering",
      "enable_hashagg",
      "enable_hashjoin",
      "enable_incremental_sort",
      "enable_indexonlyscan",
      "enable_indexscan",
      "enable_material",
      "enable_memoize",
      "enable_mergejoin",
      "enable_nestloop",
      "enable_parallel_append",
      "enable_parallel_hash",
      "enable_partition_pruning",
      "enable_partitionwise_aggregate",
      "enable_partitionwise_join",
      "enable_presorted_aggregate",
      "enable_seqscan",
      "enable_sort",
      "enable_tidscan",
      "from_collapse_limit",
      "geqo",
      "geqo_effort",
      "geqo_generations",
      "geqo_pool_size",
      "geqo_seed",
      "geqo_selection_bias",
      "geqo_threshold",
      "jit",
      "jit_above_cost",
      "jit_expressions",
      "jit_inline_above_cost",
      "jit_optimize_above_cost",
      "jit_tuple_deforming",
      "join_collapse_limit",
      "min_parallel_index_scan_size",
      "min_parallel_table_scan_size",
      "parallel_leader_participation",
      "parallel_setup_cost",
      "parallel_tuple_cost",
      "plan_cache_mode",
      "random_page_cost",
      "recursive_worktable_factor",
      "seq_page_cost",
      "max_parallel_workers",
      "max_parallel_workers_per_gather",
      "max_parallel_maintenance_workers",
    ],
  },
  {
    reason:
      "only the order of rows read without ORDER BY: a result with a defined order or a set is the same",
    names: ["synchronize_seqscans"],
  },
  {
    reason:
      "a memory or I/O resource: a query uses more or less of it, or fails loudly, but returns the same values",
    names: [
      "backend_flush_after",
      "effective_io_concurrency",
      "hash_mem_multiplier",
      "io_combine_limit",
      "logical_decoding_work_mem",
      "maintenance_io_concurrency",
      "maintenance_work_mem",
      "temp_buffers",
      "vacuum_buffer_usage_limit",
      "work_mem",
    ],
  },
  {
    reason:
      "a timeout or a lock wait: the statement or session fails loudly, it returns no other value",
    names: [
      "client_connection_check_interval",
      "idle_in_transaction_session_timeout",
      "idle_session_timeout",
      "lock_timeout",
      "statement_timeout",
      "transaction_timeout",
      "tcp_keepalives_count",
      "tcp_keepalives_idle",
      "tcp_keepalives_interval",
      "tcp_user_timeout",
      "wal_sender_timeout",
      "exit_on_error",
      "restrict_nonsystem_relation_kind",
    ],
  },
  {
    reason:
      "logging, tracing or statistics collection: it decides what is reported, not what a query returns",
    names: [
      "application_name",
      "client_min_messages",
      "debug_logical_replication_streaming",
      "debug_pretty_print",
      "debug_print_parse",
      "debug_print_plan",
      "debug_print_rewritten",
      "log_parameter_max_length_on_error",
      "stats_fetch_consistency",
      "trace_notify",
      "trace_sort",
    ],
  },
  {
    reason:
      "applies only to DDL, maintenance or a new object, not to a value read or returned",
    names: [
      "check_function_bodies",
      "createrole_self_grant",
      "default_table_access_method",
      "default_tablespace",
      "default_toast_compression",
      "gin_pending_list_limit",
      "icu_validation_level",
      "password_encryption",
      "scram_iterations",
      "temp_tablespaces",
      "vacuum_cost_delay",
      "vacuum_cost_limit",
      "vacuum_cost_page_dirty",
      "vacuum_cost_page_hit",
      "vacuum_cost_page_miss",
      "vacuum_failsafe_age",
      "vacuum_freeze_min_age",
      "vacuum_freeze_table_age",
      "vacuum_multixact_failsafe_age",
      "vacuum_multixact_freeze_min_age",
      "vacuum_multixact_freeze_table_age",
    ],
  },
  {
    reason:
      "a property of the transaction or of its commit, not of a value; a head only reads",
    names: [
      "default_transaction_deferrable",
      "default_transaction_isolation",
      "default_transaction_read_only",
      "transaction_deferrable",
      "transaction_isolation",
      "transaction_read_only",
      "commit_siblings",
      "synchronous_commit",
      "wal_skip_threshold",
    ],
  },
  {
    reason:
      "acts only at connection start or on the wire: values inside the server are in the database encoding",
    names: ["client_encoding", "local_preload_libraries"],
  },
  {
    reason:
      "a warning only, the string is read the same (standard_conforming_strings is pinned)",
    names: ["escape_string_warning"],
  },
  {
    reason:
      "with standard_conforming_strings pinned to on a backslash in a plain literal is an ordinary character; in E'' it only decides whether \\' is refused",
    names: ["backslash_quote"],
  },
  {
    reason:
      "each consumer sets it by its own rule: the head shell to '', a data step to pg_catalog, pg_temp; the row security of a data step is its own rule too",
    names: ["search_path", "row_security"],
  },
]

/**
 * Набір закріплених налаштувань (`PINNED_SESSION_SETTINGS`) проти
 * `pg_settings` закріпленої версії Postgres: налаштування, яке додав новий
 * мажор, — червоний тест, а не мовчазна залежність результату від сесії.
 */
describe("pinned session settings", () => {
  it("cover every setting a session can set, or name the reason", async () => {
    const live = await withRollback(async (client) => {
      const { rows } = await client.query<{ name: string }>(
        `SELECT name FROM pg_catalog.pg_settings
         WHERE context IN ('user', 'superuser')
         ORDER BY name`
      )
      return rows.map((row) => row.name)
    })
    const pinned = PINNED_SESSION_SETTINGS.map((s) => s.name)
    const excluded = NOT_PINNED.flatMap((group) => group.names)
    expect({
      uncovered: live.filter(
        (n) => !pinned.includes(n) && !excluded.includes(n)
      ),
      // Ім'я, якого немає в каталозі, — опечатка або налаштування, яке
      // прибрав мажор.
      stale: [...pinned, ...excluded].filter((n) => !live.includes(n)),
      both: pinned.filter((n) => excluded.includes(n)),
      duplicate: excluded.filter((n, i) => excluded.indexOf(n) !== i),
    }).toEqual({ uncovered: [], stale: [], both: [], duplicate: [] })
  })

  it("are accepted by CREATE FUNCTION and stored in proconfig as the judge compares them", async () => {
    const config = await withRollback(async (client) => {
      await client.query(
        `CREATE FUNCTION pg_temp.head_settings_probe() RETURNS SETOF uuid
           LANGUAGE sql STABLE SET search_path = '' ${pinnedSettingsClause()}
           AS $$ SELECT NULL::uuid WHERE false $$`
      )
      const { rows } = await client.query<{ proconfig: string[] }>(
        `SELECT proconfig FROM pg_catalog.pg_proc
         WHERE proname = 'head_settings_probe'
           AND pronamespace = pg_catalog.pg_my_temp_schema()`
      )
      return rows[0]?.proconfig ?? []
    })
    expect(config).toEqual([
      'search_path=""',
      ...PINNED_SESSION_SETTINGS.map(({ name, value }) => `${name}=${value}`),
    ])
  })
})
