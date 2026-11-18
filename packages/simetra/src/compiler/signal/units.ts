import {
  PLATFORM_ROLES,
  PLATFORM_SCHEMA,
  SIGNAL_MERGE_MODE,
  SIGNAL_MODE_SETTING,
  SIGNAL_OUTBOX,
  TOPIC_UUID_PATTERN,
  ZERO_UUID,
  quoteIdent,
  type DatabaseProvider,
  type PhysicalSnapshot,
} from "simetra/model"
import { isSignalObject, scopeSetCall } from "../access-units"
import { bodyRequires } from "../catalog-command/units"
import { mainTableOf, qualified, type Contracts } from "../contracts"
import { compareStrings } from "../diagnostics"
import { CURRENT_USER } from "../membership-functions"
import { dollarTag } from "../movement-functions"
import { hasRightsFunctions, uuidLiteral, call } from "../rights/functions"
import {
  renderCondition,
  rowFreeGrants,
  type RightsCondition,
} from "../rights/predicates"
import { executeGrants } from "../sql/execute-grants"
import type { SqlParser } from "../sql/parse"
import type { PlpgsqlParser } from "../sql/plpgsql"
import { generatedUnit, type SqlUnit } from "../sql/units"
import { sqlLiteral } from "../stages/model"
import { SIGNAL_FUNCTIONS } from "./names"

/** The outbox `INSERT` policy of the command role (P4-B spec §8.2). */
export const SIGNAL_INSERT_POLICY = "signal_outbox_command_insert"

/**
 * Канал змін — рівно три сегменти UUID нижнього регістру, як у `parseTopic`.
 * Канали прав і користувача (`simetra-rights:`, `simetra-user:`) шаблон не
 * бере: у B2 обидва режими їм відмовляють (Р1 плану B2, B6 їх відкриє).
 */
const CHANGES_TOPIC = `^simetra:(${TOPIC_UUID_PATTERN}):(${TOPIC_UUID_PATTERN}):(${TOPIC_UUID_PATTERN})$`

/** Операції сигналу зміни рядка (схема відправки П4-B §8.1). */
const CHANGE_OPS = ["create", "update", "markDeletion", "delete"] as const

export interface SignalInput {
  contracts: Pick<
    Contracts,
    "access" | "membership" | "rights" | "roles" | "users" | "membershipSources"
  >
  physical: PhysicalSnapshot
  provider: DatabaseProvider
  module: string
  /** Одиниці інших генераторів: функції, які кличе тіло, — ребра `requires`. */
  units: readonly Pick<SqlUnit, "class" | "identity">[]
  parse: SqlParser
  plpgsql: PlpgsqlParser
}

/** Факти сигнального об'єкта для гілки авторизації каналу. */
interface SignalFacts {
  objectId: string
  /** Вид скоупу; нескоуплений — `ZERO_UUID`, як у каналі. */
  kindId: string
  /** Множина скоупів межі тенанта; нескоуплений — немає. */
  scopeSet?: string
  publicRead: boolean
  /** Безрядкова форма права `read`; без функцій прав чи дії — порожньо. */
  readGrants: RightsCondition[]
  /** Колонка єдиного ключа UUID основної таблиці. */
  keyColumn: string
}

/**
 * Генератор `signal` (P4-B spec §8.2, §8.3): відправка `signal` і
 * `signal_invalidate`, оракул каналу `signal_topic_allowed`, правило форми
 * `signal_payload_allowed` і політика `INSERT` outbox для ролі команд. Лише
 * там, де є функції прав, як ядро команд: без ядра сигналів не шле ніхто, а
 * RLS outbox без політики відхиляє будь-яку вставку ролі команд
 * (fail-closed).
 */
export function buildSignalUnits(input: SignalInput): SqlUnit[] {
  const { contracts, provider } = input
  if (!hasRightsFunctions(contracts, provider)) return []
  const facts = signalFacts(input)
  const unit = (sql: string, requires?: SqlUnit["requires"]): SqlUnit => ({
    ...generatedUnit(sql, PLATFORM_SCHEMA, input.parse),
    module: input.module,
    generator: "signal",
    ...(requires === undefined ? {} : { requires }),
  })
  const topic = topicAllowedFunction(facts)
  const topicUnit = unit(topic, bodyRequires(topic, input))
  const payload = payloadAllowedFunction(facts)
  const payloadUnit = unit(
    payload,
    bodyRequires(payload, { ...input, units: [...input.units, topicUnit] })
  )
  const topicSignature = `${qualified(SIGNAL_FUNCTIONS.topicAllowed)}(text, boolean)`
  const payloadSignature = `${qualified(SIGNAL_FUNCTIONS.payloadAllowed)}(jsonb)`
  // Відправка: форму не перевіряє (Р15) — її судить політика `INSERT`, тож
  // `EXECUTE` лише ролі команд (П4-B §14.3): інша роль дала б тій самій
  // політиці вставку від себе.
  const senders = [
    {
      signature: `${qualified(SIGNAL_FUNCTIONS.signal)}(uuid, uuid, uuid, jsonb, bigint, text)`,
      sql: signalFunction(),
    },
    {
      signature: `${qualified(SIGNAL_FUNCTIONS.invalidate)}(uuid, uuid, uuid)`,
      sql: invalidateFunction(),
    },
  ].flatMap(({ signature, sql }) => [
    unit(sql, bodyRequires(sql, input)),
    ...executeGrants(signature, ["command"], provider).map((grant) =>
      unit(grant)
    ),
  ])
  return [
    ...senders,
    topicUnit,
    // Р10: `PUBLIC` дав би будь-якій ролі з `USAGE` на `simetra` оракул прав;
    // `EXECUTE` — роль, що вставляє в outbox, і роль, що видає токени.
    ...executeGrants(topicSignature, ["user", "command"], provider).map(
      (grant) => unit(grant)
    ),
    payloadUnit,
    // Р15: інакше правило форми стало б другим входом в оракул.
    ...executeGrants(payloadSignature, ["command"], provider).map((grant) =>
      unit(grant)
    ),
    unit(
      `CREATE POLICY ${SIGNAL_INSERT_POLICY} ON ${qualified(SIGNAL_OUTBOX)} ` +
        `FOR INSERT TO ${quoteIdent(PLATFORM_ROLES.command)} ` +
        `WITH CHECK (${qualified(SIGNAL_FUNCTIONS.payloadAllowed)}(payload));`
    ),
  ].sort((a, b) => compareStrings(a.identity, b.identity))
}

function signalFacts(input: SignalInput): SignalFacts[] {
  const { contracts, physical, provider } = input
  const model = { physical, contracts, project: { database: { provider } } }
  const rightsById = new Map(contracts.rights.map((r) => [r.objectId, r]))
  return contracts.access
    .flatMap((access): SignalFacts[] => {
      const main = mainTableOf(physical, access.objectId)
      if (
        main === undefined ||
        main.schema !== access.table.schema ||
        main.name !== access.table.name ||
        !isSignalObject(model, access.objectId)
      )
        return []
      const rights = rightsById.get(access.objectId)
      const readable = rights?.actions.some((a) => a.action === "read") === true
      return [
        {
          objectId: access.objectId,
          kindId: access.scope?.scopeKindId ?? ZERO_UUID,
          ...(access.scope === undefined
            ? {}
            : { scopeSet: scopeSetCall(access.scope) }),
          publicRead: access.publicRead.length > 0,
          readGrants:
            rights !== undefined && readable
              ? rowFreeGrants(rights, "read", main)
              : [],
          // `isSignalObject` уже довів: ключ — одна колонка `uuid`.
          keyColumn: main.primaryKey!.columns[0]!,
        },
      ]
    })
    .sort((a, b) => compareStrings(a.objectId, b.objectId))
}

/** Умова права без рядка: скоуп каналу замість колонки скоупу рядка. */
function renderGrant(condition: RightsCondition): string {
  return condition.kind === "column"
    ? `v_scope = ANY (ARRAY(SELECT ${call(condition.set.fn, condition.set.args)}))`
    : renderCondition(condition)
}

/** Скоуп каналу в межі тенанта писаря чи читача (`scopeSetCall`). */
function inScope(fact: SignalFacts): string {
  return fact.scopeSet === undefined
    ? `v_scope = ${uuidLiteral(ZERO_UUID)}`
    : `v_scope = ANY (ARRAY(SELECT ${fact.scopeSet}))`
}

/**
 * Відправка (P4-B spec §8.3): лише скоуп. Право читання писаря не
 * судиться: писар лише з контейнерною роллю має право запису без права
 * каналу, і його сигнал мовчки зник би для всіх.
 */
function sendCondition(fact: SignalFacts): string {
  return inScope(fact)
}

/**
 * Підписка (P4-B spec §8.3): скоуп **і** безрядкове право `read`. Лише
 * контейнерне право канал не відкриває: роль на одному контейнері інакше
 * бачила б id і версії рядків усіх контейнерів скоупу. `publicRead` —
 * будь-який дійсний користувач.
 */
function subscribeCondition(fact: SignalFacts): string {
  if (fact.publicRead) {
    return fact.scopeSet === undefined ? inScope(fact) : "true"
  }
  if (fact.readGrants.length === 0) return "false"
  return `${inScope(fact)} AND (${fact.readGrants.map(renderGrant).join(" OR ")})`
}

/**
 * `simetra.signal_topic_allowed(p_topic, p_send)` — оракул каналу
 * (P4-B spec §8.3). `SECURITY DEFINER`: функції множин і прав кличе від
 * власника, а роль, що питає, обмежує `EXECUTE` (Р10). Гілка — лише для
 * сигнального об'єкта; несигнальний, чужий формат і канали прав — `false`.
 */
function topicAllowedFunction(facts: readonly SignalFacts[]): string {
  const branches = facts.map(
    (fact) =>
      `    WHEN ${uuidLiteral(fact.objectId)} THEN v_kind = ${uuidLiteral(fact.kindId)} AND CASE WHEN p_send THEN ${sendCondition(fact)} ELSE ${subscribeCondition(fact)} END`
  )
  const decision =
    branches.length === 0
      ? ["  RETURN false;"]
      : [
          "  RETURN COALESCE(CASE v_parts[3]::uuid",
          ...branches,
          "    ELSE false",
          "  END, false);",
        ]
  return plpgsqlFunction(
    `${qualified(SIGNAL_FUNCTIONS.topicAllowed)}(p_topic text, p_send boolean)`,
    "SECURITY DEFINER",
    [
      "DECLARE",
      "  v_parts text[];",
      "  v_kind uuid;",
      "  v_scope uuid;",
      "BEGIN",
      `  IF ${CURRENT_USER} IS NULL THEN`,
      "    RETURN false;",
      "  END IF;",
      `  v_parts := regexp_match(p_topic, ${sqlLiteral(CHANGES_TOPIC)});`,
      "  IF v_parts IS NULL THEN",
      "    RETURN false;",
      "  END IF;",
      "  v_kind := v_parts[1]::uuid;",
      "  v_scope := v_parts[2]::uuid;",
      ...decision,
      "END",
    ]
  )
}

/**
 * `simetra.signal_payload_allowed(p_payload)` — умова політики `INSERT`
 * outbox (P4-B spec §8.3, Р15): канал за оракулом у режимі відправки, точна
 * форма `data` за `op`, `object` = об'єкт топіка, рівно один ключ з ім'ям
 * колонки ключа об'єкта й UUID. Правило форми — лише тут. `id` у `data`
 * ставить тригер штампа до перевірки політики, а звіряє з рядком `CHECK`
 * таблиці, тож тут він не судиться. `SECURITY INVOKER`: імена колонок —
 * сталі компіляції, прав власника не треба.
 */
function payloadAllowedFunction(facts: readonly SignalFacts[]): string {
  const keyColumn =
    facts.length === 0
      ? "NULL"
      : [
          "CASE v_parts[3]::uuid",
          ...facts.map(
            (fact) =>
              `WHEN ${uuidLiteral(fact.objectId)} THEN ${sqlLiteral(fact.keyColumn)}`
          ),
          "END",
        ].join(" ")
  const exact = (keys: readonly string[]) => {
    const array = `ARRAY[${[...keys].sort(compareStrings).map(sqlLiteral).join(", ")}]`
    return `v_data ?& ${array} AND v_data - ${array} = '{}'::jsonb`
  }
  return plpgsqlFunction(
    `${qualified(SIGNAL_FUNCTIONS.payloadAllowed)}(p_payload jsonb)`,
    "SECURITY INVOKER",
    [
      "DECLARE",
      "  v_parts text[];",
      "  v_data jsonb;",
      "  v_keys jsonb;",
      "  v_key text;",
      "BEGIN",
      "  IF jsonb_typeof(p_payload -> 'channel') IS DISTINCT FROM 'string'",
      "    OR jsonb_typeof(p_payload -> 'data') IS DISTINCT FROM 'object' THEN",
      "    RETURN false;",
      "  END IF;",
      `  IF ${qualified(SIGNAL_FUNCTIONS.topicAllowed)}(p_payload ->> 'channel', true) IS NOT TRUE THEN`,
      "    RETURN false;",
      "  END IF;",
      `  v_parts := regexp_match(p_payload ->> 'channel', ${sqlLiteral(CHANGES_TOPIC)});`,
      "  v_data := (p_payload -> 'data') - 'id';",
      "  IF jsonb_typeof(v_data -> 'object') IS DISTINCT FROM 'string'",
      "    OR (v_data ->> 'object') IS DISTINCT FROM v_parts[3]",
      "    OR jsonb_typeof(v_data -> 'op') IS DISTINCT FROM 'string' THEN",
      "    RETURN false;",
      "  END IF;",
      "  IF (v_data ->> 'op') = 'invalidate' THEN",
      `    RETURN ${exact(["object", "op"])};`,
      "  END IF;",
      `  IF (v_data ->> 'op') <> ALL (ARRAY[${CHANGE_OPS.map(sqlLiteral).join(", ")}])`,
      `    OR NOT (${exact(["keys", "object", "op", "row_ver"])}) THEN`,
      "    RETURN false;",
      "  END IF;",
      // Версія — ціле додатне число з послідовності (П4-B §7.4).
      "  IF jsonb_typeof(v_data -> 'row_ver') IS DISTINCT FROM 'number'",
      "    OR (v_data ->> 'row_ver')::numeric < 1",
      "    OR (v_data ->> 'row_ver')::numeric % 1 <> 0 THEN",
      "    RETURN false;",
      "  END IF;",
      "  v_keys := v_data -> 'keys';",
      `  v_key := ${keyColumn};`,
      // Два окремі правила: рівно один ключ і саме колонка ключа об'єкта з
      // UUID — інакше сигнал ніс би значення інших полів рядка (§8.1).
      "  IF jsonb_typeof(v_keys) IS DISTINCT FROM 'object'",
      "    OR (SELECT count(*) FROM jsonb_object_keys(v_keys)) <> 1 THEN",
      "    RETURN false;",
      "  END IF;",
      "  RETURN jsonb_typeof(v_keys -> v_key) IS NOT DISTINCT FROM 'string'",
      `    AND (v_keys ->> v_key) ~ ${sqlLiteral(`^${TOPIC_UUID_PATTERN}$`)};`,
      "END",
    ]
  )
}

/**
 * Канал змін `channelTopic` (T0) у SQL: `uuid::text` — нижній регістр, як
 * вимагає `parseTopic`.
 */
const CHANNEL =
  "'simetra:' || p_scope_kind::text || ':' || p_scope::text || ':' || p_object::text"

/** Вставка сигналу в outbox: `id` і ключ ідемпотентності ставить тригер штампа. */
function outboxInsert(data: string): string {
  return (
    `  INSERT INTO ${qualified(SIGNAL_OUTBOX)} (method, payload) VALUES ('publish', ` +
    `jsonb_build_object('channel', ${CHANNEL}, 'data', ${data}));`
  )
}

/**
 * `simetra.signal(…)` (P4-B spec §8.2): рядок outbox зміни рядка в
 * транзакції команди. Режим злиття гасить сигнал лише точним значенням
 * (§8.2: «режим відкритий за замовчуванням»): будь-яке інше значення, як і
 * відсутнє налаштування, лишає сигнал на фазу. `SECURITY INVOKER`: вставку
 * судить політика outbox ролі команд, а не права власника.
 */
function signalFunction(): string {
  return plpgsqlFunction(
    `${qualified(SIGNAL_FUNCTIONS.signal)}(p_object uuid, p_scope_kind uuid, p_scope uuid, p_keys jsonb, p_version bigint, p_operation text)`,
    "SECURITY INVOKER",
    [
      "BEGIN",
      `  IF current_setting(${sqlLiteral(SIGNAL_MODE_SETTING)}, true) = ${sqlLiteral(SIGNAL_MERGE_MODE)} THEN`,
      "    RETURN;",
      "  END IF;",
      outboxInsert(
        "jsonb_build_object('object', p_object, 'op', p_operation, 'keys', p_keys, 'row_ver', p_version)"
      ),
      "END",
    ],
    { returns: "void", volatility: "VOLATILE" }
  )
}

/**
 * `simetra.signal_invalidate(…)` (P4-B spec §8.2): `invalidate` пари
 * (скоуп, об'єкт). Його кличе T3 саме в режимі злиття, тож режиму не
 * перевіряє.
 */
function invalidateFunction(): string {
  return plpgsqlFunction(
    `${qualified(SIGNAL_FUNCTIONS.invalidate)}(p_object uuid, p_scope_kind uuid, p_scope uuid)`,
    "SECURITY INVOKER",
    [
      "BEGIN",
      outboxInsert(
        "jsonb_build_object('object', p_object, 'op', 'invalidate')"
      ),
      "END",
    ],
    { returns: "void", volatility: "VOLATILE" }
  )
}

function plpgsqlFunction(
  signature: string,
  security: "SECURITY DEFINER" | "SECURITY INVOKER",
  body: readonly string[],
  head: { returns: "boolean" | "void"; volatility: "STABLE" | "VOLATILE" } = {
    returns: "boolean",
    volatility: "STABLE",
  }
): string {
  const text = body.join("\n")
  const tag = dollarTag(text)
  return (
    `CREATE OR REPLACE FUNCTION ${signature}\n` +
    `RETURNS ${head.returns}\n` +
    `LANGUAGE plpgsql ${head.volatility} ${security}\n` +
    `SET search_path = ''\n` +
    `AS ${tag}\n${text}\n${tag};`
  )
}
