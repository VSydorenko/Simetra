import {
  COMMAND_CORE_ERRORS,
  COMMAND_SETTING,
  PLATFORM_SCHEMA,
  quoteIdent,
} from "simetra/model"
import { qualified, type QualifiedName, type RoleContract } from "../contracts"
import { CURRENT_USER } from "../membership-functions"
import { dollarTag } from "../movement-functions"
import { sqlLiteral } from "../stages/model"
import { SNAPSHOT_TABLES } from "./actor-snapshot"
import {
  INPUT_COLUMNS,
  ROOT_CREATOR_REASON,
  ROOT_MARKER_TABLE,
} from "./admin-tables"
import { COMMAND_FUNCTIONS } from "./command-units"
import { generatedTableFunctionName } from "./generated-names"
import { refusal } from "./guard-units"

const q = quoteIdent

/**
 * Функція гранту творцю кореня виду скоупу (спека П4 §6.13):
 * `simetra.<вид скоупу>_root_creator`. Ім'я — від фізичного імені виду: воно
 * присвоюється раз і не змінюється з перейменуванням виду.
 */
export function rootCreatorFunctionName(kind: {
  physicalName: string
}): QualifiedName {
  return {
    schema: PLATFORM_SCHEMA,
    name: generatedTableFunctionName(kind.physicalName, "root_creator"),
  }
}

/** Таблиця довідника, мітка об'єкта й дія контексту його вставки. */
interface Inserted {
  table: QualifiedName
  kindLabel: string
  action: string
  key: string
  scope: string
}

/** Факти функції гранту одного виду скоупу; їх збирає генератор ядра. */
export interface RootCreatorFacts {
  kindId: string
  fn: QualifiedName
  /** Мітка кореня й дія `create` кореня (контекст ядра). */
  root: { kindLabel: string; action: string }
  /** Роль `rootCreator` рівня скоупу виду. */
  role: Pick<RoleContract, "roleId" | "fullAccess">
  membership: Inserted & {
    user: string
    /** `<членство>_simetra_member_check` довідника членства (Р-A6-12). */
    check: QualifiedName
    /**
     * Колонки вставки зі списку компіляції (ті самі, що в гілці створення
     * `<членство>_save`) і значення за замовчуванням для відсутнього ключа.
     */
    columns: { name: string; default: string }[]
  }
  assignments: Inserted & { subject: string; archetype: string }
}

/**
 * Привілейований шлях створення тенанта (спека П4 §6.13, спека прав §7):
 * `SECURITY DEFINER`, бо творець ще не має прав у новому скоупі, а рядки
 * членства й призначення мусять з'явитися в тій самій транзакції. Кроки й
 * відмови — дослівно за спекою; кожна відмова — `rights-context`. Без
 * динамічного SQL: колонки, мітки й id — сталі компіляції. `row_security =
 * off`: власник таблиць RLS обходить, а якби ні — перевірка (3) мовчки не
 * побачила б рядків; так вона падає гучно (fail-closed). Вставки йдуть під
 * власним контекстом фази кожної таблиці, бо тригер ефектів судить кореневий
 * рядок дією контексту; на виході відновлюється контекст кореня.
 */
export function rootCreatorFunction(facts: RootCreatorFacts): string {
  const refuse = refusal(COMMAND_CORE_ERRORS.forbidden.rightsContext)
  const ifRefuse = (condition: string) => [
    `IF ${condition} THEN`,
    `  ${refuse}`,
    "END IF;",
  ]
  const kind = `${sqlLiteral(facts.kindId)}::uuid`
  const archetype = `${sqlLiteral(facts.role.roleId)}::uuid`
  const T = SNAPSHOT_TABLES
  const { membership: m, assignments: a } = facts
  const context = (action: string, label: string, root: string) =>
    `PERFORM set_config(${sqlLiteral(COMMAND_SETTING)}, jsonb_build_object('action', ${sqlLiteral(action)}, 'object', ${sqlLiteral(label)}, 'root', ${root})::text, true);`
  const forced: Record<string, string> = {
    [m.key]: "p_member_id",
    [m.scope]: "p_root",
    [m.user]: CURRENT_USER,
  }
  const memberColumns = [
    ...new Set([m.key, m.scope, m.user, ...m.columns.map((c) => c.name)]),
  ]
  const memberValue = (column: string) =>
    forced[column] ??
    `CASE WHEN p_member ? ${sqlLiteral(column)} THEN v_in.${q(column)} ELSE ${m.columns.find((c) => c.name === column)!.default} END`
  // Рядок входу `typed` — та сама проєкція, що в живого входу призначення
  // довідника рівня скоупу (`catalogAssignments` + `typedCte`): пряма роль,
  // без контейнера й кастомної ролі.
  const typed: Record<(typeof INPUT_COLUMNS.typed)[number][0], string> = {
    storage: "'scope'",
    storage_id: kind,
    scope_kind_id: kind,
    scope: "p_root",
    container: "NULL",
    custom_role: "NULL",
    archetype,
    level: "'scope'",
    level_id: kind,
  }
  const typedColumns = INPUT_COLUMNS.typed.map(([name]) => name)
  const header = (fact: string) =>
    `NOT EXISTS (SELECT 1 FROM ${qualified(T.header)} h WHERE h.xid = txid_current() AND h.fact = ${sqlLiteral(fact)} AND h.actor = ${CURRENT_USER})`
  const lines = [
    // (1) Контекст створення саме цього кореня. Безвиняткове читання: без
    // контексту відмова — та сама `rights-context`, а не `command.context`.
    `SELECT c.action, c.object, c.root INTO v_action, v_object, v_root FROM ${qualified(COMMAND_FUNCTIONS.current)}() c;`,
    ...ifRefuse(
      `v_action IS DISTINCT FROM ${sqlLiteral(facts.root.action)} OR v_object IS DISTINCT FROM ${sqlLiteral(facts.root.kindLabel)} OR v_root IS DISTINCT FROM p_root`
    ),
    // (2) Маркер «корінь вставлено в цій транзакції цим актором» (Р-A6-23).
    `DELETE FROM ${qualified(ROOT_MARKER_TABLE)} m WHERE m.xid = txid_current() AND m.scope_kind_id = ${kind} AND m.root = p_root AND m.actor = ${CURRENT_USER};`,
    "GET DIAGNOSTICS v_count = ROW_COUNT;",
    ...ifRefuse("v_count = 0"),
    // (3) Скоуп ще без жодного учасника й призначення.
    ...ifRefuse(
      `EXISTS (SELECT 1 FROM ${qualified(m.table)} r WHERE r.${q(m.scope)} = p_root) OR EXISTS (SELECT 1 FROM ${qualified(a.table)} r WHERE r.${q(a.scope)} = p_root)`
    ),
    // (4) Рядок членства творця: лише колонки вставки, примушені ключ, скоуп і
    // користувач. Вхід уже перевірило INVOKER-ядро, але прямий виклик сирим
    // SQL під `simetra_command` його оминає — тож та сама перевірка рядка
    // членства ще раз (захист у глибину, як Р-A6-23). Від власника з
    // `row_security = off` вона означає «ціль існує й у тому самому скоупі», не
    // видимість — як в інструменті обслуговування (Р-A6-12). Примушені ключі
    // функція ігнорує (їх пише вона сама), тож перевірка їх не бачить.
    ...ifRefuse(
      `${qualified(m.check)}(p_member - ARRAY[${Object.keys(forced).map(sqlLiteral).join(", ")}]::text[], p_root) IS NOT NULL`
    ),
    `v_context := current_setting(${sqlLiteral(COMMAND_SETTING)}, true);`,
    context(m.action, m.kindLabel, "p_member_id"),
    `v_in := jsonb_populate_record(NULL::${qualified(m.table)}, p_member);`,
    `INSERT INTO ${qualified(m.table)} (${memberColumns.map(q).join(", ")}) VALUES (${memberColumns.map(memberValue).join(", ")});`,
    // (5) Знімок актора взято (тригер знімка членства щойно чи раніше).
    ...ifRefuse(`${header("rights")} OR ${header("scopes")}`),
    // (6) Кеш прав початку ще порожній: інакше він не мав би прав творця.
    ...ifRefuse(
      `EXISTS (SELECT 1 FROM ${qualified(T.start)} s WHERE s.xid = txid_current())`
    ),
    // (7) Входи знімка: призначення `rootCreator` рівно в новому скоупі.
    "v_assignment := gen_random_uuid();",
    `INSERT INTO ${qualified(T.typed)} (xid, ${typedColumns.join(", ")}, provenance, assignment) VALUES (txid_current(), ${typedColumns.map((c) => typed[c]).join(", ")}, ${sqlLiteral(ROOT_CREATOR_REASON)}, v_assignment);`,
    ...(facts.role.fullAccess
      ? [
          `INSERT INTO ${qualified(T.holders)} (xid, level, level_id, scope) VALUES (txid_current(), 'scope', ${kind}, p_root);`,
        ]
      : []),
    `INSERT INTO ${qualified(T.scopes)} (xid, scope_kind_id, scope, member, catalog) VALUES (txid_current(), ${kind}, p_root, p_member_id, true);`,
    // (8) Призначення архетипу учаснику-творцю.
    context(a.action, a.kindLabel, "v_assignment"),
    `INSERT INTO ${qualified(a.table)} (${[a.key, a.scope, a.subject, a.archetype].map(q).join(", ")}) VALUES (v_assignment, p_root, p_member_id, ${archetype});`,
    // (9) Контекст кореня — як до виклику.
    `PERFORM set_config(${sqlLiteral(COMMAND_SETTING)}, v_context, true);`,
  ]
  const body = [
    "DECLARE",
    "  v_action text;",
    "  v_object text;",
    "  v_root uuid;",
    "  v_count bigint;",
    "  v_context text;",
    "  v_in record;",
    "  v_assignment uuid;",
    "BEGIN",
    ...lines.map((line) => `  ${line}`),
    "END",
  ].join("\n")
  const tag = dollarTag(body)
  return (
    `CREATE OR REPLACE FUNCTION ${qualified(facts.fn)}(p_root uuid, p_member_id uuid, p_member jsonb)\n` +
    `RETURNS void\n` +
    `LANGUAGE plpgsql VOLATILE SECURITY DEFINER\n` +
    `SET search_path = ''\n` +
    `SET row_security = off\n` +
    `AS ${tag}\n${body}\n${tag};`
  )
}
