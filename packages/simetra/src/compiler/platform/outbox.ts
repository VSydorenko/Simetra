import {
  PLATFORM_ROLES,
  PROVIDER_API_ROLES,
  SIGNAL_NOTIFY_CHANNEL,
  SIGNAL_OUTBOX,
  SIGNAL_PAYLOAD_MAX_BYTES,
  makeObjectName,
  quoteIdent,
  type DatabaseProvider,
  type PhysicalTable,
} from "simetra/model"
import { qualified, type QualifiedName } from "../contracts"
import { compareStrings } from "../diagnostics"
import { dollarTag } from "../movement-functions"
import { executeGrants, sequenceRevokes } from "../sql/execute-grants"
import type { SqlParser } from "../sql/parse"
import { generatedUnit, type SqlUnit } from "../sql/units"
import { sqlLiteral } from "../stages/model"

const NAME = SIGNAL_OUTBOX.name
const TABLE = qualified(SIGNAL_OUTBOX)
/** Послідовність `id` черги сигналів — друга платформна послідовність поряд з `row_version`. */
const SIGNAL_OUTBOX_SEQUENCE: QualifiedName = {
  schema: SIGNAL_OUTBOX.schema,
  name: `${NAME}_id_seq`,
}
const fn = (name: string): QualifiedName => ({
  schema: SIGNAL_OUTBOX.schema,
  name,
})
const STAMP = fn("signal_outbox_stamp")
const NOTIFY = fn("signal_outbox_notify")
const PRUNE = fn("signal_outbox_prune")

/** Тригери outbox: штамп `id` у `payload` і сповіщення споживача. */
export const SIGNAL_OUTBOX_TRIGGERS = {
  stamp: "simetra_signal_outbox_stamp",
  notify: "simetra_signal_outbox_notify",
} as const

/** Політики споживача Centrifugo (спека профілю `postgres` §5.2). */
export const SIGNAL_OUTBOX_POLICIES = {
  select: "signal_outbox_consumer_select",
  delete: "signal_outbox_consumer_delete",
} as const

/** Ключі запиту публікації Centrifugo, які несе `payload`, — і лише вони. */
const PAYLOAD_KEYS = ["channel", "data", "idempotency_key"] as const

/** Форма топіків П4-B (`channelTopic`): префікс і сегменти з UUID. */
const CHANNEL_PATTERN = "^simetra(-rights|-user)?:[0-9a-f:-]+$"

/**
 * `simetra.signal_outbox` — таблиця знімка з платформним походженням без
 * об'єкта (спека профілю `postgres` §5.1): вона є в кожному проєкті, бо
 * сигнал пише будь-яка команда сигнального об'єкта. Колонки — рівно формат
 * споживача Centrifugo. `id` — identity `ALWAYS`: значення ставить лише база,
 * а вставка в identity-колонку не потребує прав на послідовність, тож роль
 * команд не отримує `USAGE` на неї.
 *
 * Форму `payload` тримає база (`CHECK`), а не довіра до того, хто вставляє:
 * рівно три ключі запиту публікації (інакше рядок міг би додати
 * `skip_history`, `b64data` чи `tags`), канал за формою топіків, `data` —
 * об'єкт, ключ ідемпотентності й `data.id` — сам `id` рядка (його ставить
 * тригер штампа: роль команд свого `id` не бачить), і межа в октетах тексту
 * `payload`, а не в символах. Кожна умова — `IS TRUE`: відсутній ключ дає
 * `NULL`, а `NULL` у `CHECK` пропустив би рядок. RLS — без `FORCE`: власник
 * (`prune`, оператор) політик не потребує.
 */
export function signalOutboxTable(): PhysicalTable {
  const check = (label: string, expression: string) => ({
    name: makeObjectName(NAME, label, "check"),
    expression,
  })
  const keys = `ARRAY[${PAYLOAD_KEYS.map(sqlLiteral).join(", ")}]`
  return {
    schema: SIGNAL_OUTBOX.schema,
    name: NAME,
    origin: { part: "signalOutbox" },
    rowLevelSecurity: "enabled",
    columns: [
      {
        name: "id",
        type: "bigint",
        notNull: true,
        identity: {
          generation: "always",
          sequence: SIGNAL_OUTBOX_SEQUENCE.name,
        },
        origin: {},
      },
      { name: "method", type: "text", notNull: true, origin: {} },
      { name: "payload", type: "jsonb", notNull: true, origin: {} },
      {
        name: "partition",
        type: "integer",
        notNull: true,
        default: "0",
        origin: {},
      },
      {
        name: "created_at",
        type: "timestamp with time zone",
        notNull: true,
        default: "now()",
        origin: {},
      },
    ],
    primaryKey: {
      name: makeObjectName(NAME, undefined, "pkey"),
      columns: ["id"],
    },
    uniques: [],
    checks: [
      check("method", "method = 'publish'"),
      check("partition", "partition = 0"),
      check(
        "payload",
        "(jsonb_typeof(payload) = 'object'" +
          ` AND payload ?& ${keys}` +
          ` AND payload - ${keys} = '{}'::jsonb` +
          " AND jsonb_typeof(payload -> 'channel') = 'string'" +
          ` AND (payload ->> 'channel') ~ ${sqlLiteral(CHANNEL_PATTERN)}` +
          " AND jsonb_typeof(payload -> 'data') = 'object') IS TRUE"
      ),
      check(
        "id",
        "(jsonb_typeof(payload -> 'idempotency_key') = 'string'" +
          " AND (payload ->> 'idempotency_key') = id::text" +
          " AND jsonb_typeof(payload -> 'data' -> 'id') = 'string'" +
          " AND (payload -> 'data' ->> 'id') = id::text) IS TRUE"
      ),
      check(
        "size",
        `octet_length(payload::text) <= ${SIGNAL_PAYLOAD_MAX_BYTES}`
      ),
    ].sort((a, b) => compareStrings(a.name, b.name)),
    foreignKeys: [],
    indexes: [],
  }
}

/**
 * Об'єкти outbox поза таблицею (спека профілю `postgres` §5.2): тригер
 * штампа `BEFORE INSERT` рівня рядка, `NOTIFY` `AFTER INSERT` рівня
 * оператора (команда з кількома сигналами — одне сповіщення), гранти,
 * політики споживача й `prune`. Гранти: роль команд — лише `INSERT (method,
 * payload)` (політику `INSERT` дає генератор сигналу: без неї RLS вставку
 * відхиляє); споживач — `USAGE` схеми, `SELECT` і `DELETE` з політиками
 * `USING (true)`; `PUBLIC` і ролям API — нічого. Функції тригерів і `prune`
 * — без `EXECUTE` для `PUBLIC` і ролей API: тригер спрацьовує без права
 * виконання, а `prune` кличе власник.
 */
export function outboxUnits(
  module: string,
  provider: DatabaseProvider,
  parse: SqlParser
): SqlUnit[] {
  const unit = (sql: string, requires?: SqlUnit["requires"]): SqlUnit => ({
    ...generatedUnit(sql, SIGNAL_OUTBOX.schema, parse),
    module,
    generator: "signalOutbox",
    ...(requires === undefined ? {} : { requires }),
  })
  const table = `TABLE ${TABLE}`
  const command = quoteIdent(PLATFORM_ROLES.command)
  const consumer = quoteIdent(PLATFORM_ROLES.signalConsumer)
  const apiRoles = Object.values(PROVIDER_API_ROLES[provider]).filter(
    (role): role is string => typeof role === "string"
  )
  const functions = [
    {
      signature: `${qualified(STAMP)}()`,
      sql: plpgsqlFunction(`${qualified(STAMP)}()`, "trigger", [
        "DECLARE",
        "  v_id jsonb := to_jsonb(NEW.id::text);",
        "BEGIN",
        // Лише над об'єктом із `data`-об'єктом: інакше `jsonb_set` упав би
        // помилкою шляху, а не відмовою `CHECK` форми.
        "  IF jsonb_typeof(NEW.payload) = 'object'",
        "    AND jsonb_typeof(NEW.payload -> 'data') = 'object' THEN",
        "    NEW.payload := jsonb_set(",
        "      jsonb_set(NEW.payload, '{idempotency_key}', v_id),",
        "      '{data,id}', v_id",
        "    );",
        "  END IF;",
        "  RETURN NEW;",
        "END",
      ]),
    },
    {
      signature: `${qualified(NOTIFY)}()`,
      sql: plpgsqlFunction(`${qualified(NOTIFY)}()`, "trigger", [
        "BEGIN",
        `  PERFORM pg_notify(${sqlLiteral(SIGNAL_NOTIFY_CHANNEL)}, '0');`,
        "  RETURN NULL;",
        "END",
      ]),
    },
    {
      signature: `${qualified(PRUNE)}(interval)`,
      sql: plpgsqlFunction(
        `${qualified(PRUNE)}(p_older_than interval)`,
        "bigint",
        [
          "DECLARE",
          "  v_count bigint;",
          "BEGIN",
          `  DELETE FROM ${TABLE} WHERE created_at < now() - p_older_than;`,
          "  GET DIAGNOSTICS v_count = ROW_COUNT;",
          "  RETURN v_count;",
          "END",
        ]
      ),
      requires: [{ type: "table" as const, ...SIGNAL_OUTBOX }],
    },
  ]
  const units: SqlUnit[] = [
    ...functions.flatMap(({ signature, sql, requires }) => [
      unit(sql, requires),
      ...executeGrants(signature, [], provider).map((grant) => unit(grant)),
    ]),
    unit(
      `CREATE TRIGGER ${SIGNAL_OUTBOX_TRIGGERS.stamp} BEFORE INSERT ON ${TABLE} ` +
        `FOR EACH ROW EXECUTE FUNCTION ${qualified(STAMP)}();`
    ),
    unit(
      `CREATE TRIGGER ${SIGNAL_OUTBOX_TRIGGERS.notify} AFTER INSERT ON ${TABLE} ` +
        `FOR EACH STATEMENT EXECUTE FUNCTION ${qualified(NOTIFY)}();`
    ),
    unit(`REVOKE ALL ON ${table} FROM PUBLIC;`),
    ...apiRoles.map((role) =>
      unit(`REVOKE ALL ON ${table} FROM ${quoteIdent(role)};`)
    ),
    ...sequenceRevokes(SIGNAL_OUTBOX_SEQUENCE, provider).map((sql) =>
      unit(sql)
    ),
    unit(`GRANT INSERT (method, payload) ON ${table} TO ${command};`),
    unit(
      `GRANT USAGE ON SCHEMA ${quoteIdent(SIGNAL_OUTBOX.schema)} TO ${consumer};`
    ),
    unit(`GRANT SELECT ON ${table} TO ${consumer};`),
    unit(`GRANT DELETE ON ${table} TO ${consumer};`),
    unit(
      `CREATE POLICY ${SIGNAL_OUTBOX_POLICIES.select} ON ${TABLE} ` +
        `FOR SELECT TO ${consumer} USING (true);`
    ),
    unit(
      `CREATE POLICY ${SIGNAL_OUTBOX_POLICIES.delete} ON ${TABLE} ` +
        `FOR DELETE TO ${consumer} USING (true);`
    ),
  ]
  return units.sort((a, b) => compareStrings(a.identity, b.identity))
}

// `SECURITY INVOKER`: тілам не потрібні права власника — штамп і сповіщення
// працюють над `NEW`, а `prune` кличе сам власник.
function plpgsqlFunction(
  signature: string,
  returns: string,
  body: readonly string[]
): string {
  const text = body.join("\n")
  const tag = dollarTag(text)
  return (
    `CREATE OR REPLACE FUNCTION ${signature}\n` +
    `RETURNS ${returns}\n` +
    `LANGUAGE plpgsql SECURITY INVOKER\n` +
    `SET search_path = ''\n` +
    `AS ${tag}\n${text}\n${tag};`
  )
}
