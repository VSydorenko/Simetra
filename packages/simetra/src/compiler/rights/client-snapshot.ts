import {
  PLATFORM_SCHEMA,
  RIGHTS_CLIENT_SNAPSHOT_FUNCTION_NAME,
  RIGHTS_DIMENSION_VALUES_MAX,
  type DatabaseProvider,
  type PhysicalSnapshot,
} from "simetra/model"
import { scopeSetCall } from "../access-units"
import { bodyRequires } from "../catalog-command/units"
import { qualified, type Contracts } from "../contracts"
import { compareStrings } from "../diagnostics"
import { CURRENT_USER } from "../membership-functions"
import { dollarTag } from "../movement-functions"
import { executeGrants } from "../sql/execute-grants"
import type { SqlParser } from "../sql/parse"
import type { PlpgsqlParser } from "../sql/plpgsql"
import { generatedUnit, type SqlUnit } from "../sql/units"
import { sqlLiteral } from "../stages/model"
import { RIGHTS_FUNCTIONS, call, hasRightsFunctions } from "./functions"

export interface ClientSnapshotInput {
  contracts: Pick<
    Contracts,
    "access" | "rights" | "roles" | "users" | "membershipSources"
  >
  physical: PhysicalSnapshot
  provider: DatabaseProvider
  module: string
  /** Одиниці інших генераторів: функції, які кличе тіло, — ребра `requires`. */
  units: readonly Pick<SqlUnit, "class" | "identity">[]
  parse: SqlParser
  plpgsql: PlpgsqlParser
}

/**
 * Рядок `rights_mine()` у знімку: колонка `snake_case` функції → поле
 * `camelCase` схеми T0. Порядок — порядок `ORDER BY`: кожен масив
 * упорядковано повним кортежем, тож текст знімка стабільний, а відбиток
 * (`rightsVersion`) від порядку рядків не залежить.
 */
const RIGHTS_FIELDS = [
  ["level", "level"],
  ["levelId", "level_id"],
  ["scope", "scope"],
  ["container", "container"],
  ["object", "object"],
  ["action", "action"],
  ["extent", "extent"],
  ["dimensionId", "dimension_id"],
] as const

/**
 * Генератор `rights_client_snapshot()` (P4-B spec §9.1): факти поточного
 * користувача для клієнта — `{ userId, scopeSets, rights, members,
 * dimensionValues }`. `SECURITY
 * INVOKER`: кличе лише публічні функції фактів, які роль запиту вже
 * виконує, тож нової definer-поверхні немає. Там, де є функції прав.
 */
export function buildClientSnapshotUnits(
  input: ClientSnapshotInput
): SqlUnit[] {
  const { contracts, provider } = input
  if (!hasRightsFunctions(contracts, provider)) return []
  const unit = (sql: string, requires?: SqlUnit["requires"]): SqlUnit => ({
    ...generatedUnit(sql, PLATFORM_SCHEMA, input.parse),
    module: input.module,
    generator: "rightsClientSnapshot",
    ...(requires === undefined ? {} : { requires }),
  })
  const sql = snapshotFunction(contracts)
  const signature = `${qualified(SNAPSHOT_FUNCTION)}()`
  return [
    unit(sql, bodyRequires(sql, input)),
    // `PUBLIC` дав би будь-якій ролі з `USAGE` на `simetra` факти прав
    // викликача; `EXECUTE` — роль запиту користувача й роль команд.
    ...executeGrants(signature, ["user", "command"], provider).map((grant) =>
      unit(grant)
    ),
  ].sort((a, b) => compareStrings(a.identity, b.identity))
}

const SNAPSHOT_FUNCTION = {
  schema: PLATFORM_SCHEMA,
  name: RIGHTS_CLIENT_SNAPSHOT_FUNCTION_NAME,
} as const

/** Множини скоупів: `scopeSetCall` кожного виду з хоч одним скоупленим об'єктом. */
function scopeSetQueries(access: ClientSnapshotInput["contracts"]["access"]) {
  const byKind = new Map<string, string>()
  for (const contract of access) {
    if (contract.scope === undefined) continue
    byKind.set(contract.scope.scopeKindId, scopeSetCall(contract.scope))
  }
  return [...byKind]
    .sort(([a], [b]) => compareStrings(a, b))
    .map(
      ([kindId, set]) =>
        `SELECT ${sqlLiteral(kindId)}::text AS scope_kind, ${set} AS scope`
    )
}

/** Виміри контрактів прав (`access[]` кожного об'єкта), кожен раз. */
function contractDimensions(
  rights: ClientSnapshotInput["contracts"]["rights"]
): string[] {
  const ids = new Set(rights.flatMap((c) => c.access.map((a) => a.dimensionId)))
  return [...ids].sort(compareStrings)
}

/**
 * Мої значення кожного виміру контрактів (`rights_dimension_values`): різні,
 * без `NULL`, упорядковані. Понад межу — перші `RIGHTS_DIMENSION_VALUES_MAX`,
 * `truncated` і `digest` повного набору (значення через кому), тож зміна
 * значення за межею змінює відбиток, а розмір знімка має межу.
 */
function dimensionValuesQuery(dimensions: readonly string[]): string {
  if (dimensions.length === 0) return "'[]'::jsonb"
  const max = RIGHTS_DIMENSION_VALUES_MAX
  const list = dimensions.map((id) => `(${sqlLiteral(id)}::uuid)`).join(", ")
  return [
    "COALESCE((SELECT jsonb_agg(",
    "      CASE WHEN v.total > " + max,
    "        THEN jsonb_build_object('dimension', d.dimension, 'values', v.head, 'truncated', true, 'digest', v.digest)",
    "        ELSE jsonb_build_object('dimension', d.dimension, 'values', v.head) END",
    "      ORDER BY d.dimension)",
    `    FROM (VALUES ${list}) d(dimension)`,
    "    CROSS JOIN LATERAL (",
    "      SELECT count(*) AS total,",
    `        COALESCE(jsonb_agg(x.value ORDER BY x.value) FILTER (WHERE x.n <= ${max}), '[]'::jsonb) AS head,`,
    "        encode(sha256(convert_to(string_agg(x.value::text, ',' ORDER BY x.value), 'UTF8')), 'hex') AS digest",
    "      FROM (SELECT f.value, row_number() OVER (ORDER BY f.value) AS n",
    `        FROM (SELECT DISTINCT t.value FROM ${call(RIGHTS_FUNCTIONS.dimensionValues, ["d.dimension"])} AS t(value)`,
    "          WHERE t.value IS NOT NULL) f) x) v), '[]'::jsonb)",
  ].join("\n")
}

/** Мої скоупи (`rights_my_scopes()`): вид, скоуп і мій учасник. */
const MEMBERS = [
  "COALESCE((SELECT jsonb_agg(",
  "      jsonb_build_object('scopeKind', s.scope_kind_id, 'scope', s.scope, 'member', s.member)",
  "      ORDER BY s.scope_kind_id, s.scope, s.member)",
  `    FROM ${call(RIGHTS_FUNCTIONS.myScopes)} s), '[]'::jsonb)`,
].join("\n")

function snapshotFunction(contracts: ClientSnapshotInput["contracts"]): string {
  const sets = scopeSetQueries(contracts.access)
  const scopeSets =
    sets.length === 0
      ? "'[]'::jsonb"
      : [
          "COALESCE((SELECT jsonb_agg(",
          "      jsonb_build_object('scopeKind', s.scope_kind, 'scope', s.scope)",
          "      ORDER BY s.scope_kind, s.scope)",
          `    FROM (SELECT DISTINCT scope_kind, scope FROM (${sets.join(" UNION ALL ")}) u) s), '[]'::jsonb)`,
        ].join("\n")
  const row = RIGHTS_FIELDS.map(
    ([field, column]) => `'${field}', m.${column}`
  ).join(", ")
  const order = RIGHTS_FIELDS.map(([, column]) => `m.${column}`).join(", ")
  const body = [
    "DECLARE",
    "  v_user uuid;",
    "BEGIN",
    `  v_user := ${CURRENT_USER};`,
    "  IF v_user IS NULL THEN",
    "    RETURN jsonb_build_object('userId', NULL, 'scopeSets', '[]'::jsonb, 'rights', '[]'::jsonb, 'members', '[]'::jsonb, 'dimensionValues', '[]'::jsonb);",
    "  END IF;",
    "  RETURN jsonb_build_object(",
    "    'userId', v_user,",
    `    'scopeSets', ${scopeSets},`,
    `    'rights', COALESCE((SELECT jsonb_agg(jsonb_build_object(${row}) ORDER BY ${order})`,
    `      FROM ${call(RIGHTS_FUNCTIONS.mine)} m), '[]'::jsonb),`,
    `    'members', ${MEMBERS},`,
    `    'dimensionValues', ${dimensionValuesQuery(contractDimensions(contracts.rights))});`,
    "END",
  ].join("\n")
  const tag = dollarTag(body)
  return (
    `CREATE OR REPLACE FUNCTION ${qualified(SNAPSHOT_FUNCTION)}()\n` +
    `RETURNS jsonb\n` +
    `LANGUAGE plpgsql STABLE SECURITY INVOKER\n` +
    `SET search_path = ''\n` +
    `AS ${tag}\n${body}\n${tag};`
  )
}
