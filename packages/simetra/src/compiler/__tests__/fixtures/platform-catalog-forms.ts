import type { CatalogTable } from "simetra/model"

/**
 * Форми каталогу платформних одиниць і таблиці outbox, записані з живого
 * `engine.extract` (тінь після `renderDesiredState` порожнього проєкту й
 * фікстури довідника з механікою та ключем) на обох профілях: `postgres` і
 * `supabase` дали дослівно той самий текст. Кожна форма — пара до виходу
 * генератора тієї самої ідентичності; правило нормалізації
 * `platformRecogniser` з'являється лише з такою парою (план #286, Р5).
 * Записувача в репозиторії немає: що форми лишаються формами живого
 * каталогу, перевіряє живий тест И8 на обох профілях (задача 4 плану #286 —
 * прийом з нуля після apply фікстур корпусу дає точний набір одиниць теки).
 */

/** Ідентичність → текст одиниці каталогу. */
export const CATALOG_UNIT_FORMS: Readonly<Record<string, string>> = {
  "function:simetra.signal_outbox_notify()":
    "CREATE OR REPLACE FUNCTION simetra.signal_outbox_notify()\n RETURNS trigger\n LANGUAGE plpgsql\n SET search_path TO ''\nAS $function$\nBEGIN\n  PERFORM pg_notify('simetra_signal_outbox', '0');\n  RETURN NULL;\nEND\n$function$",
  "function:simetra.rich_text_is_empty(jsonb)":
    "CREATE OR REPLACE FUNCTION simetra.rich_text_is_empty(p_value jsonb)\n RETURNS boolean\n LANGUAGE sql\n IMMUTABLE PARALLEL SAFE STRICT\n SET search_path TO ''\nAS $function$\nSELECT NOT pg_catalog.jsonb_path_exists(p_value, 'strict $.** ? ((@.type == \"text\" && @.text like_regex \"[^\\u0009\\u000A\\u000B\\u000C\\u000D\\u0020\\u00A0\\u1680\\u2000\\u2001\\u2002\\u2003\\u2004\\u2005\\u2006\\u2007\\u2008\\u2009\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]\"))'::pg_catalog.jsonpath)\n$function$",
  "function:simetra.touch()":
    "CREATE OR REPLACE FUNCTION simetra.touch()\n RETURNS trigger\n LANGUAGE plpgsql\n SECURITY DEFINER\n SET search_path TO ''\nAS $function$\nBEGIN\n  IF TG_OP = 'INSERT' THEN\n    NEW.version := nextval('simetra.row_version');\n  ELSE\n    NEW.version := GREATEST(nextval('simetra.row_version'), OLD.version + 1);\n  END IF;\n  NEW.updated_at := now();\n  IF current_setting('synchronous_commit') IN ('off', 'local') THEN\n    PERFORM set_config('synchronous_commit', 'on', true);\n  END IF;\n  PERFORM set_config('simetra.row_version_' || TG_RELID::text, NEW.version::text, true);\n  RETURN NEW;\nEND\n$function$",
  "function:simetra.key_immutable()":
    "CREATE OR REPLACE FUNCTION simetra.key_immutable()\n RETURNS trigger\n LANGUAGE plpgsql\n SET search_path TO ''\nAS $function$\nBEGIN\n  RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'command.forbidden', DETAIL = 'effect', TABLE = TG_TABLE_NAME, COLUMN = TG_ARGV[0];\n  RETURN NULL;\nEND\n$function$",
  "sequence:simetra.row_version":
    'CREATE SEQUENCE "simetra"."row_version" AS bigint INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1 NO CYCLE',
  "policy:simetra.signal_outbox.signal_outbox_consumer_select":
    'CREATE POLICY "signal_outbox_consumer_select" ON "simetra"."signal_outbox" FOR SELECT TO "simetra_signal_consumer" USING (true)',
  "trigger:app.item.item_simetra_touch":
    "CREATE TRIGGER item_simetra_touch BEFORE INSERT OR UPDATE ON app.item FOR EACH ROW EXECUTE FUNCTION simetra.touch()",
  "trigger:app.item.item_simetra_key":
    "CREATE TRIGGER item_simetra_key BEFORE UPDATE ON app.item FOR EACH ROW WHEN ((new.id IS DISTINCT FROM old.id)) EXECUTE FUNCTION simetra.key_immutable('id')",
  "grant:grant:table:simetra.signal_outbox:simetra_command:insert(method)":
    "GRANT INSERT (method) ON TABLE simetra.signal_outbox TO simetra_command",
  "grant:grant:table:simetra.signal_outbox:simetra_command:insert(payload)":
    "GRANT INSERT (payload) ON TABLE simetra.signal_outbox TO simetra_command",
  "grant:grant:table:simetra.signal_outbox:simetra_signal_consumer:delete,select":
    "GRANT DELETE, SELECT ON TABLE simetra.signal_outbox TO simetra_signal_consumer",
  'grant:revoke:function:simetra.signal_outbox_prune("interval"):public:execute':
    "REVOKE EXECUTE ON FUNCTION simetra.signal_outbox_prune(interval) FROM PUBLIC",
}

/** `simetra.signal_outbox` у моделі каталогу extract. */
export const CATALOG_OUTBOX_TABLE: CatalogTable = {
  schema: "simetra",
  name: "signal_outbox",
  rowLevelSecurity: "enabled",
  columns: [
    {
      name: "id",
      type: "bigint",
      notNull: true,
      identity: {
        generation: "always",
        sequence: "signal_outbox_id_seq",
      },
    },
    {
      name: "method",
      type: "text",
      notNull: true,
    },
    {
      name: "payload",
      type: "jsonb",
      notNull: true,
    },
    {
      name: "partition",
      type: "integer",
      notNull: true,
      default: "0",
    },
    {
      name: "created_at",
      type: "timestamp with time zone",
      notNull: true,
      default: "now()",
    },
  ],
  uniques: [],
  checks: [
    {
      name: "signal_outbox_id_check",
      expression:
        "(((jsonb_typeof((payload -> 'idempotency_key'::text)) = 'string'::text) AND ((payload ->> 'idempotency_key'::text) = (id)::text) AND (jsonb_typeof(((payload -> 'data'::text) -> 'id'::text)) = 'string'::text) AND (((payload -> 'data'::text) ->> 'id'::text) = (id)::text)) IS TRUE)",
    },
    {
      name: "signal_outbox_method_check",
      expression: "(method = 'publish'::text)",
    },
    {
      name: "signal_outbox_partition_check",
      expression: "(partition = 0)",
    },
    {
      name: "signal_outbox_payload_check",
      expression:
        "(((jsonb_typeof(payload) = 'object'::text) AND (payload ?& ARRAY['channel'::text, 'data'::text, 'idempotency_key'::text]) AND ((payload - ARRAY['channel'::text, 'data'::text, 'idempotency_key'::text]) = '{}'::jsonb) AND (jsonb_typeof((payload -> 'channel'::text)) = 'string'::text) AND ((payload ->> 'channel'::text) ~ '^simetra(-rights|-user)?:[0-9a-f:-]+$'::text) AND (jsonb_typeof((payload -> 'data'::text)) = 'object'::text)) IS TRUE)",
    },
    {
      name: "signal_outbox_size_check",
      expression: "(octet_length((payload)::text) <= 1024)",
    },
  ],
  foreignKeys: [],
  indexes: [],
  primaryKey: {
    name: "signal_outbox_pkey",
    columns: ["id"],
  },
}
