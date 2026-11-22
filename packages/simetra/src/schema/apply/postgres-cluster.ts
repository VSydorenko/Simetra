import {
  PROVIDER_API_ROLES,
  PROVIDER_IDENTITY_SOURCES,
  PROVIDER_LOGIN_ROLES,
  PROVIDER_OWNER_ROLES,
  quoteIdent,
} from "simetra/model"
import type { DbConnection, EngineDiagnostic } from "../engine"
import {
  PROVIDER_DATABASE_LOCALES,
  PROVIDER_SHADOW_TEMPLATES,
} from "../engine/provider/presets"
import { applyDiagnostic } from "./diagnostic"
import { CLUSTER_ADVISORY_LOCK } from "./execute"
import {
  allowingLack,
  lackingParents,
  loginSettingSql,
  pairGrant,
  platformRoleRefusals,
  platformRoleSet,
  readPlatformRoles,
  type PlatformLoginRole,
  type PlatformRoleRow,
  type PlatformRoleSet,
} from "./platform-roles"
import type { ApplyDatabase, ApplyTransaction } from "./port"
import { serverVersionRefusal } from "./server"

/**
 * Names that `ensurePostgresCluster` prepares. `roles` builds it from the
 * T0/T2 data of the profile (`postgresClusterSet`); tests build it from tagged
 * names, so no consumer of this module spells a role or a database literally.
 */
export interface PostgresClusterSet {
  /** The role that applies the schema and owns the target database. */
  owner: string
  /** Grant roles and login roles of the platform (`platformRoleSet`). */
  roles: PlatformRoleSet
  /** API request roles: the role of a user session and the anonymous one. */
  request: readonly string[]
  /** The login role of the identity provider; it owns the schema `better_auth`. */
  auth: string
  /** The template database that shadows are copied from. */
  template: string
  /** The target database. */
  database: string
  /**
   * The identity table of the profile (`PROVIDER_IDENTITY_SOURCES`): the owner
   * gets `USAGE` on its schema and `TRIGGER, REFERENCES` on the table only.
   */
  identity: { schema: string; name: string }
}

/**
 * What a call created, what it only found, and what it could not do yet.
 * Roles and databases by name; the identity grants as `<schema>:USAGE` and
 * `<schema>.<table>:TRIGGER` (the latter covers `TRIGGER, REFERENCES`). The
 * table grant is skipped, not refused, while the table does not exist: the
 * Better Auth migration creates it, and a repeat call grants it.
 */
export interface PostgresClusterOutcome {
  created: string[]
  present: string[]
  skipped: string[]
}

/** Result of `ensurePostgresCluster`: nothing was written when it is a refusal. */
export type PostgresClusterResult =
  | { ok: true; value: PostgresClusterOutcome }
  | { ok: false; error: EngineDiagnostic[] }

/**
 * The names of the postgres profile for the target database `database`, taken
 * from the T0/T2 data (spec of the profile §3.1).
 */
export function postgresClusterSet(database: string): PostgresClusterSet {
  const template = PROVIDER_SHADOW_TEMPLATES.postgres
  const [auth] = PROVIDER_LOGIN_ROLES.postgres
  if (template === null || auth === undefined)
    throw new Error("the postgres profile data has no template or auth role")
  const api = PROVIDER_API_ROLES.postgres
  return {
    owner: PROVIDER_OWNER_ROLES.postgres,
    roles: platformRoleSet("postgres"),
    request: [api.user, api.anonymous],
    auth,
    template,
    database,
    identity: PROVIDER_IDENTITY_SOURCES.postgres.table,
  }
}

type Attributes = PlatformRoleRow["attributes"]

/** Атрибути власника застосування (спека профілю §3.1). */
const OWNER_ATTRIBUTES: Attributes = {
  login: true,
  inherit: false,
  superuser: false,
  bypassRls: true,
  createRole: false,
  createDb: true,
  replication: false,
}

/** Атрибути ролі входу провайдера ідентичності (спека профілю §3.1). */
const AUTH_ATTRIBUTES: Attributes = {
  login: true,
  inherit: false,
  superuser: false,
  bypassRls: false,
  createRole: false,
  createDb: false,
  replication: false,
}

/** Атрибути ролей грантів і запиту: без жодного. */
const GRANT_ATTRIBUTES: Attributes = {
  ...AUTH_ATTRIBUTES,
  login: false,
}

// Порядок оголошення: перше порушення називається за ним, тож відмова
// детермінована
const ATTRIBUTE_ORDER = [
  "login",
  "inherit",
  "superuser",
  "bypassRls",
  "createRole",
  "createDb",
  "replication",
] as const satisfies readonly (keyof Attributes)[]

const ATTRIBUTE_SQL: Record<keyof Attributes, string> = {
  login: "LOGIN",
  inherit: "INHERIT",
  superuser: "SUPERUSER",
  bypassRls: "BYPASSRLS",
  createRole: "CREATEROLE",
  createDb: "CREATEDB",
  replication: "REPLICATION",
}

/** Атрибути `CREATE ROLE` з карти: одне джерело і для створення, і для звірки. */
const attributeSql = (attributes: Attributes): string =>
  ATTRIBUTE_ORDER.map((key) =>
    attributes[key] ? ATTRIBUTE_SQL[key] : `NO${ATTRIBUTE_SQL[key]}`
  ).join(" ")

const sorted = (names: Iterable<string>): string[] =>
  [...new Set(names)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))

/**
 * Перше порушення форми власника чи ролі `auth`: рівно свої атрибути, жодного
 * членства (зокрема в `pg_*`) і жодного члена. Решту ролей звіряє гейт ролей
 * платформи.
 */
export function clusterRoleViolation(
  found: PlatformRoleRow,
  kind: "owner" | "auth"
): string | undefined {
  const expected = kind === "owner" ? OWNER_ATTRIBUTES : AUTH_ATTRIBUTES
  const attribute = ATTRIBUTE_ORDER.find(
    (key) => found.attributes[key] !== expected[key]
  )
  if (attribute !== undefined) return attribute
  const [parent] = sorted(found.memberOf.map((m) => m.role))
  if (parent !== undefined) return `member-of:${parent}`
  const [holder] = sorted(found.members.map((m) => m.role))
  return holder === undefined ? undefined : `member:${holder}`
}

/**
 * Бази іншого застосунку: ті, до яких роль входу Simetra має явний `CONNECT`
 * (спека профілю §3.1, «Кластер на застосунок»). `PUBLIC` не рахується: службова
 * база, шаблони й тіні мають лише його.
 */
export function explicitConnectDatabases(
  rows: readonly { database: string; grantee: string }[],
  logins: readonly string[],
  database: string
): string[] {
  return sorted(
    rows
      .filter((r) => logins.includes(r.grantee) && r.database !== database)
      .map((r) => r.database)
  )
}

/** Факти схеми `extensions` бази, яку читає сесія суперкористувача. */
export interface ExtensionsSchemaFacts {
  exists: boolean
  ownerSuper: boolean
  /** Отримувачі `CREATE` на схему; `PUBLIC` — з іменем `PUBLIC`. */
  createGrantees: readonly { grantee: string; super: boolean }[]
  /** Об'єкти схеми з власником без `SUPERUSER`. */
  foreign: readonly { kind: string; name: string }[]
  /** Схема, в якій стоїть `plpgsql_check` (де б вона не була). */
  checkSchema: string | undefined
}

/**
 * Причина, з якої схема `extensions` небезпечна для сесії суперкористувача:
 * власник бази міг покласти туди код, який виконається разом із розширенням
 * чи наступним запитом. `undefined` — безпечна або її ще немає.
 */
export function extensionsSchemaViolation(
  facts: ExtensionsSchemaFacts,
  schema = EXTENSIONS_SCHEMA
): string | undefined {
  if (facts.exists) {
    if (!facts.ownerSuper) return "owner-not-superuser"
    const grantee = facts.createGrantees.find((g) => !g.super)
    if (grantee !== undefined) return `create:${grantee.grantee}`
    const [object] = facts.foreign
    if (object !== undefined) return `object:${object.kind}:${object.name}`
  }
  return facts.checkSchema !== undefined && facts.checkSchema !== schema
    ? `plpgsql_check-schema:${facts.checkSchema}`
    : undefined
}

/** Факти схеми `better_auth` і ролі `auth` у цільовій базі. */
export interface AuthSchemaFacts {
  /** Власник схеми `better_auth`; `undefined` — схеми ще немає. */
  schemaOwner: string | undefined
  createDatabase: boolean
  createPublic: boolean
  /** Відношення ролі `auth` поза `better_auth`. */
  strayRelations: readonly { schema: string; name: string }[]
  /** `setconfig` рядка `pg_db_role_setting` ролі для цієї бази; `null` — рядка немає. */
  searchPath: readonly string[] | null
}

const unquoted = (value: string): string =>
  value.replaceAll('"', "").replaceAll(" ", "")

/**
 * Причина, з якої роль `auth` не обмежена схемою `better_auth`:
 * чужий власник схеми, `CREATE` на базу чи `public`, відношення поза схемою
 * або інший `search_path` ролі для цієї бази.
 */
export function authSchemaViolation(
  facts: AuthSchemaFacts,
  auth: string
): string | undefined {
  if (facts.schemaOwner !== undefined && facts.schemaOwner !== auth)
    return `owner:${facts.schemaOwner}`
  if (facts.createDatabase) return "create-database"
  if (facts.createPublic) return "create-public"
  const [stray] = facts.strayRelations
  if (stray !== undefined) return `relation:${stray.schema}.${stray.name}`
  const path = (facts.searchPath ?? []).find(
    (entry) =>
      entry.startsWith("search_path=") &&
      unquoted(entry.slice("search_path=".length)) !== AUTH_SCHEMA
  )
  return path === undefined
    ? undefined
    : `search-path:${path.slice("search_path=".length).replaceAll('"', "")}`
}

/** Рядок `pg_database` шаблону разом з власником. */
export interface TemplateRow {
  owner: string
  ownerSuper: boolean
  isTemplate: boolean
  allowConnections: boolean
}

/** Рядок `pg_database` разом з власником і колляцією бази. */
export interface DatabaseRow extends TemplateRow {
  /** Провайдер локалі за назвою `CREATE DATABASE`: `icu`, `libc`, `builtin`. */
  localeProvider: string
  /** `datlocale`, а для `libc` (там його немає) — `datcollate`. */
  locale: string
  /** `daticurules`: власні правила ICU поверх локалі; `null` — їх немає. */
  icuRules: string | null
}

// Колляція баз, які створює `roles`: одне джерело для `CREATE DATABASE` і
// звірки наявних
const DATABASE_LOCALE = PROVIDER_DATABASE_LOCALES.postgres
const localeName = (provider: string, locale: string) => `${provider} ${locale}`

/**
 * Інша колляція наявної бази, ніж та, з якою `roles` її створив би:
 * `undefined` — збіг. Перестворити базу платформа не може без втрати даних
 * (колляцію бази не змінює `ALTER`), тож це відмова, а не крок. Правила ICU
 * теж міняють порядок: та сама локаль з ними сортує не як колатор клієнта.
 */
export function databaseLocaleViolation(
  found: Pick<DatabaseRow, "localeProvider" | "locale" | "icuRules">
): string | undefined {
  const name = localeName(found.localeProvider, found.locale)
  if (
    found.localeProvider !== DATABASE_LOCALE.provider ||
    found.locale !== DATABASE_LOCALE.locale
  )
    return name
  return found.icuRules === null ? undefined : `${name} with ICU rules`
}

/**
 * Стан шаблону: `sealed` — довірений без з'єднання (його вміст міг змінити
 * лише суперкористувач); `unsealed` — перерваний запуск суперкористувача,
 * який доробляють; `unsafe` — шаблон чужий, відкритий чи недосяжний.
 */
export type TemplateState =
  | { state: "absent" | "sealed" | "unsealed" }
  | { state: "unsafe"; reason: string }

export function templateState(found: TemplateRow | undefined): TemplateState {
  if (found === undefined) return { state: "absent" }
  if (!found.ownerSuper)
    return { state: "unsafe", reason: `owner-not-superuser:${found.owner}` }
  if (found.isTemplate)
    return found.allowConnections
      ? { state: "unsafe", reason: "allows-connections" }
      : { state: "sealed" }
  return found.allowConnections
    ? { state: "unsealed" }
    : { state: "unsafe", reason: "closed-not-template" }
}

// Схеми профілю: імена з переліку `PROVIDER_SCHEMAS.postgres` (T0); тест
// тримає збіг. Схема Better Auth — одне джерело з таблицею ідентичності
const EXTENSIONS_SCHEMA = "extensions"
const AUTH_SCHEMA = PROVIDER_IDENTITY_SOURCES.postgres.table.schema
const CHECK_EXTENSION = "plpgsql_check"

/**
 * The session timeouts that every transaction or session of the schema engine
 * resets to 0 (off) before its own work: the target database or role may set
 * any of them, and a limit would kill the cluster lock holder or a long DDL
 * halfway. Both preludes (`CLUSTER_TRANSACTION_PRELUDE` here and the
 * `statement` prelude of the designer `ApplyDatabase`) are built from this one
 * list, so a new timeout is added in one place. `transaction_timeout` needs
 * PostgreSQL 17, the minimum of the postgres profile. The runtime counterpart
 * is `COMMAND_CLAIMS_TEXT` in `packages/simetra/src/server/transaction.ts`,
 * which sets the same four GUCs to a command budget instead of 0.
 */
export const ENGINE_SESSION_TIMEOUTS: readonly string[] = [
  "statement_timeout",
  "lock_timeout",
  "idle_in_transaction_session_timeout",
  "transaction_timeout",
]

/**
 * Прелюдія кожної транзакції `roles`: сесію, роль і шлях пошуку, які база чи
 * роль могли підмінити (`ALTER DATABASE … SET role`, `search_path`), повертають
 * у відомий стан до першого запиту, що кличе функцію чи оператор. Власник
 * бази рівний базі (спека профілю §3.4): без цього підкладена в `public`
 * функція виконалась би від суперкористувача. `idle_in_transaction_session_timeout`
 * скинуто, бо зовнішня службова транзакція тримає `CLUSTER_ADVISORY_LOCK` і
 * простоює, поки фаза запису йде на інших зʼєднаннях: кластерний ліміт простою
 * вбив би її й зняв замок посеред запису. `SET LOCAL` не виходить за транзакцію.
 */
export const CLUSTER_TRANSACTION_PRELUDE: readonly string[] = [
  "SET LOCAL ROLE NONE",
  "SET LOCAL search_path = pg_catalog, pg_temp",
  ...ENGINE_SESSION_TIMEOUTS.map((guc) => `SET LOCAL ${guc} = 0`),
]

/** Відмова, яку знайшла фаза запису: транзакцію відкочують, фазу зупиняють. */
class LateRefusal extends Error {
  constructor(readonly diagnostics: EngineDiagnostic[]) {
    super("roles refused during the write phase")
  }
}

/**
 * Прелюдія й звірка сесії: `current_user = session_user` і `rolsuper`. Без
 * звірки прелюдія не гарантує, що далі код виконується від суперкористувача.
 */
async function enterSession(
  tx: ApplyTransaction
): Promise<EngineDiagnostic[] | undefined> {
  for (const sql of CLUSTER_TRANSACTION_PRELUDE) await tx.query(sql)
  const [session] = await tx.query<{ ok: boolean; database: string }>(
    [
      "SELECT (current_user = session_user) AND COALESCE((SELECT r.rolsuper",
      "  FROM pg_catalog.pg_roles r WHERE r.rolname = session_user), false) AS ok,",
      "  pg_catalog.current_database() AS database",
    ].join("\n")
  )
  return session?.ok === true
    ? undefined
    : [
        applyDiagnostic("roles.superuser-required", "error", {
          database: session?.database ?? "",
        }),
      ]
}

const q = quoteIdent
const literal = (value: string): string => `'${value.replaceAll("'", "''")}'`

// Колляцію задають лише від `template0`: інший шаблон несе свою, і Postgres
// відхилив би несумісну
const CREATE_DATABASE_OPTIONS = [
  `TEMPLATE ${q("template0")}`,
  `LOCALE_PROVIDER ${DATABASE_LOCALE.provider}`,
  `ICU_LOCALE ${literal(DATABASE_LOCALE.locale)}`,
].join(" ")

interface DatabaseFacts {
  extensionsSchema: boolean
  checkInstalled: boolean
  betterAuth: boolean
}

/** Гранти власника на таблицю ідентичності, які вже є в цілі. */
interface IdentityGrantFacts {
  usage: boolean
  /** `undefined` — таблиці ще немає. */
  table: { trigger: boolean; references: boolean } | undefined
}

const qualified = (table: { schema: string; name: string }): string =>
  `${q(table.schema)}.${q(table.name)}`

/**
 * The grants of the owner on the identity table: `USAGE` on its schema,
 * `TRIGGER, REFERENCES` on the table alone (the provision trigger and the
 * foreign key of the model). The single source of
 * this SQL: the `ensurePostgresCluster` write phase and the test helper of a
 * tagged copy database, which `roles` cannot prepare, both run it.
 */
export function identityGrantSql(
  owner: string,
  identity: { schema: string; name: string }
): { usage: string; table: string } {
  return {
    usage: `GRANT USAGE ON SCHEMA ${q(identity.schema)} TO ${q(owner)}`,
    table: `GRANT TRIGGER, REFERENCES ON ${qualified(identity)} TO ${q(owner)}`,
  }
}

/**
 * Гранти власника на схему й таблицю ідентичності; схема вже є. Таблиця — лише
 * звичайна чи секціонована (`relkind` r, p): вид чи послідовність з тим самим
 * іменем рахується відсутньою таблицею.
 */
async function readIdentityGrants(
  tx: ApplyTransaction,
  set: PostgresClusterSet
): Promise<IdentityGrantFacts> {
  const table = qualified(set.identity)
  const [schema] = await tx.query<{ usage: boolean; exists: boolean }>(
    [
      "SELECT pg_catalog.has_schema_privilege($1::text, $2::text, 'USAGE') AS usage,",
      "  EXISTS (SELECT 1 FROM pg_catalog.pg_class c",
      "    WHERE c.oid = pg_catalog.to_regclass($3::text) AND c.relkind IN ('r', 'p')) AS exists",
    ].join("\n"),
    [set.owner, set.identity.schema, table]
  )
  if (schema?.exists !== true)
    return { usage: schema?.usage === true, table: undefined }
  // Окремим запитом: `has_table_privilege` відсутньої таблиці — помилка
  const [grants] = await tx.query<{ trigger: boolean; references: boolean }>(
    [
      "SELECT pg_catalog.has_table_privilege($1::text, $2::text, 'TRIGGER') AS trigger,",
      "  pg_catalog.has_table_privilege($1::text, $2::text, 'REFERENCES') AS references",
    ].join("\n"),
    [set.owner, table]
  )
  return {
    usage: schema.usage,
    table: {
      trigger: grants?.trigger === true,
      references: grants?.references === true,
    },
  }
}

/** Факти схеми `extensions` у базі транзакції. */
async function readExtensionsFacts(
  tx: ApplyTransaction
): Promise<ExtensionsSchemaFacts> {
  const [schema] = await tx.query<{
    ownerSuper: boolean
    createGrantees: { grantee: string; super: boolean }[]
  }>(
    [
      'SELECT o.rolsuper AS "ownerSuper",',
      "  (SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(",
      "      'grantee', COALESCE(g.rolname::text, 'PUBLIC'),",
      "      'super', COALESCE(g.rolsuper, false))",
      "      ORDER BY COALESCE(g.rolname::text, 'PUBLIC')), '[]'::pg_catalog.jsonb)",
      "     FROM pg_catalog.aclexplode(COALESCE(n.nspacl,",
      "       pg_catalog.acldefault('n', n.nspowner))) a",
      "     LEFT JOIN pg_catalog.pg_roles g ON g.oid = a.grantee",
      "    WHERE a.privilege_type = 'CREATE') AS \"createGrantees\"",
      "FROM pg_catalog.pg_namespace n",
      "JOIN pg_catalog.pg_roles o ON o.oid = n.nspowner",
      "WHERE n.nspname = $1::text",
    ].join("\n"),
    [EXTENSIONS_SCHEMA]
  )
  const foreign =
    schema === undefined
      ? []
      : await tx.query<{ kind: string; name: string }>(
          [
            "SELECT x.kind, x.name FROM (",
            "  SELECT 'relation' AS kind, c.relname::text AS name, c.relowner AS owner,",
            "    c.relnamespace AS ns FROM pg_catalog.pg_class c",
            "  UNION ALL SELECT 'function', p.proname::text, p.proowner, p.pronamespace",
            "    FROM pg_catalog.pg_proc p",
            "  UNION ALL SELECT 'type', t.typname::text, t.typowner, t.typnamespace",
            "    FROM pg_catalog.pg_type t",
            "  UNION ALL SELECT 'operator', o.oprname::text, o.oprowner, o.oprnamespace",
            "    FROM pg_catalog.pg_operator o",
            ") x",
            "JOIN pg_catalog.pg_namespace n ON n.oid = x.ns AND n.nspname = $1::text",
            "JOIN pg_catalog.pg_roles r ON r.oid = x.owner",
            "WHERE NOT r.rolsuper",
            "ORDER BY x.kind, x.name LIMIT 5",
          ].join("\n"),
          [EXTENSIONS_SCHEMA]
        )
  const [check] = await tx.query<{ schema: string }>(
    [
      "SELECT n.nspname::text AS schema FROM pg_catalog.pg_extension e",
      "JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace",
      "WHERE e.extname = 'plpgsql_check'",
    ].join("\n")
  )
  return {
    exists: schema !== undefined,
    ownerSuper: schema?.ownerSuper ?? true,
    createGrantees: schema?.createGrantees ?? [],
    foreign,
    checkSchema: check?.schema,
  }
}

/** Факти схеми `better_auth` і ролі `auth`; роль може ще не існувати. */
async function readAuthFacts(
  tx: ApplyTransaction,
  auth: string
): Promise<AuthSchemaFacts> {
  const [schema] = await tx.query<{ schemaOwner: string }>(
    [
      'SELECT o.rolname::text AS "schemaOwner" FROM pg_catalog.pg_namespace n',
      "JOIN pg_catalog.pg_roles o ON o.oid = n.nspowner",
      "WHERE n.nspname = $1::text",
    ].join("\n"),
    [AUTH_SCHEMA]
  )
  const [role] = await tx.query<{
    oid: string
    createDatabase: boolean
    createPublic: boolean
  }>(
    [
      "SELECT a.oid::text AS oid,",
      "  pg_catalog.has_database_privilege(a.oid, pg_catalog.current_database(), 'CREATE') AS \"createDatabase\",",
      "  COALESCE((SELECT pg_catalog.has_schema_privilege(a.oid, n.oid, 'CREATE')",
      "    FROM pg_catalog.pg_namespace n WHERE n.nspname = 'public'), false)",
      '    AS "createPublic"',
      "FROM pg_catalog.pg_roles a WHERE a.rolname = $1::text",
    ].join("\n"),
    [auth]
  )
  if (role === undefined)
    return {
      schemaOwner: schema?.schemaOwner,
      createDatabase: false,
      createPublic: false,
      strayRelations: [],
      searchPath: null,
    }
  // Таблиці й індекси TOAST лежать у `pg_toast` з власником основної таблиці:
  // вони належать таблиці `better_auth`, а не стороннім об'єктам; створити
  // там власний об'єкт не можна
  const strayRelations = await tx.query<{ schema: string; name: string }>(
    [
      "SELECT n.nspname::text AS schema, c.relname::text AS name",
      "FROM pg_catalog.pg_class c",
      "JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace",
      "WHERE c.relowner = $1::pg_catalog.oid AND n.nspname <> $2::text",
      "  AND n.nspname <> 'pg_toast'",
      "ORDER BY 1, 2 LIMIT 5",
    ].join("\n"),
    [role.oid, AUTH_SCHEMA]
  )
  const [setting] = await tx.query<{ setconfig: string[] }>(
    [
      "SELECT s.setconfig FROM pg_catalog.pg_db_role_setting s",
      "WHERE s.setrole = $1::pg_catalog.oid",
      "  AND s.setdatabase = (SELECT d.oid FROM pg_catalog.pg_database d",
      "    WHERE d.datname = pg_catalog.current_database())",
    ].join("\n"),
    [role.oid]
  )
  return {
    schemaOwner: schema?.schemaOwner,
    createDatabase: role.createDatabase,
    createPublic: role.createPublic,
    strayRelations,
    searchPath: setting?.setconfig ?? null,
  }
}

/** Рядки `pg_database` цілі й шаблону разом з власником і колляцією. */
async function readDatabases(
  tx: ApplyTransaction,
  names: readonly string[]
): Promise<Map<string, DatabaseRow>> {
  // `Pick` дає тип без оголошення інтерфейсу: порт вимагає `Record<string, unknown>`
  const rows = await tx.query<
    { name: string } & Pick<DatabaseRow, keyof DatabaseRow>
  >(
    [
      'SELECT d.datname::text AS name, o.rolname::text AS owner, o.rolsuper AS "ownerSuper",',
      '  d.datistemplate AS "isTemplate", d.datallowconn AS "allowConnections",',
      "  CASE d.datlocprovider WHEN 'i' THEN 'icu' WHEN 'c' THEN 'libc'",
      "    WHEN 'b' THEN 'builtin' ELSE d.datlocprovider::text END",
      '    AS "localeProvider",',
      "  COALESCE(d.datlocale, d.datcollate)::text AS locale,",
      '  d.daticurules::text AS "icuRules"',
      "FROM pg_catalog.pg_database d JOIN pg_catalog.pg_roles o ON o.oid = d.datdba",
      "WHERE d.datname = ANY($1::text[])",
    ].join("\n"),
    [[...names]]
  )
  return new Map(rows.map((r) => [r.name, r]))
}

/** Знімок фази читання, за яким діє фаза запису. */
interface Snapshot {
  roles: ReadonlySet<string>
  database: boolean
  template: "absent" | "sealed" | "unsealed"
  target: DatabaseFacts | undefined
  /** `undefined` — схеми `better_auth` у цілі ще немає. */
  identityGrants: IdentityGrantFacts | undefined
  templateFacts: DatabaseFacts | undefined
}

/** Ролі входу Simetra: рантайм-ролі набору і `auth`. */
const simetraLogins = (set: PostgresClusterSet): string[] => [
  ...set.roles.login.map((l) => l.name),
  set.auth,
]

/** Створювані ролі за порядком створення: спершу ті, у які входять ролі входу. */
function plannedRoles(set: PostgresClusterSet): {
  name: string
  create: string[]
}[] {
  const noLogin = (name: string) => ({
    name,
    create: [`CREATE ROLE ${q(name)} ${attributeSql(GRANT_ATTRIBUTES)}`],
  })
  const login = (l: PlatformLoginRole) => ({
    name: l.name,
    create: [
      `CREATE ROLE ${q(l.name)} ${attributeSql({ ...GRANT_ATTRIBUTES, login: true })}`,
      // INHERIT FALSE явно: з PG16 типове значення членства бере атрибут
      // ролі, а пара мусить бути саме `INHERIT FALSE, SET TRUE`
      ...l.memberOf.map(
        (parent) =>
          `GRANT ${q(parent)} TO ${q(l.name)} WITH INHERIT FALSE, SET TRUE`
      ),
      ...loginSettingSql(l),
    ],
  })
  return [
    {
      name: set.owner,
      create: [`CREATE ROLE ${q(set.owner)} ${attributeSql(OWNER_ATTRIBUTES)}`],
    },
    {
      name: set.auth,
      create: [`CREATE ROLE ${q(set.auth)} ${attributeSql(AUTH_ATTRIBUTES)}`],
    },
    ...set.roles.names.map(noLogin),
    ...set.request.map(noLogin),
    ...set.roles.login.map(login),
  ]
}

/**
 * Фаза читання (жодного запису). Усі транзакції — з прелюдією; з базою,
 * вміст якої міг змінити не суперкористувач, що не запечатана, з'єднання
 * відкривається лише після перевірки її власника.
 */
async function readPhase(
  dbs: ApplyDatabase,
  conns: ClusterConnections,
  set: PostgresClusterSet,
  maintenance: ApplyTransaction
): Promise<
  { ok: true; snapshot: Snapshot } | { ok: false; error: EngineDiagnostic[] }
> {
  const refusal: EngineDiagnostic[] = []

  // 2. Форма наявних ролей
  const planned = plannedRoles(set)
  const gated = [...set.roles.login, ...(set.roles.checkLogin ?? [])]
  const found = await readPlatformRoles(
    maintenance,
    planned.map((r) => r.name),
    set.request
  )
  const roles = new Set(found.map((r) => r.name))
  const shape = (role: string, violation: string): EngineDiagnostic =>
    applyDiagnostic("plan.platform-role-shape", "error", {
      role,
      server: "target",
      violation,
    })
  for (const [name, kind] of [
    [set.owner, "owner"],
    [set.auth, "auth"],
  ] as const) {
    const row = found.find((r) => r.name === name)
    const violation = row && clusterRoleViolation(row, kind)
    if (violation !== undefined) refusal.push(shape(name, violation))
  }
  const platform = [
    ...set.roles.names,
    ...set.request,
    ...gated.map((l) => l.name),
  ].filter((name) => roles.has(name))
  // Брак обов'язкового членства наявної ролі входу не відмова: фаза запису
  // доповнює його парою §6.2 (як `ensurePlatformRoles`); зайвий батько, інша
  // форма членства й інші атрибути лишаються відмовою.
  refusal.push(
    ...platformRoleRefusals(
      platform,
      found,
      "target",
      gated.map(allowingLack),
      set.request
    )
  )

  // 3. Наявна база і шаблон
  const databases = await readDatabases(maintenance, [
    set.database,
    set.template,
  ])
  const targetRow = databases.get(set.database)
  if (targetRow !== undefined && targetRow.owner !== set.owner)
    refusal.push(
      applyDiagnostic("roles.database-owner", "error", {
        database: set.database,
        expected: set.owner,
        actual: targetRow.owner,
      })
    )
  // Колляцію звіряють і в цілі, і в шаблоні: тінь і копія доказу беруть її
  // з шаблону, і план на іншій колляції розійшовся б з ціллю
  for (const [name, kind] of [
    [set.database, "database"],
    [set.template, "template"],
  ] as const) {
    const row = databases.get(name)
    const actual = row && databaseLocaleViolation(row)
    if (actual !== undefined)
      refusal.push(
        applyDiagnostic("roles.database-locale", "error", {
          database: name,
          kind,
          expected: localeName(
            DATABASE_LOCALE.provider,
            DATABASE_LOCALE.locale
          ),
          actual,
        })
      )
  }
  const template = templateState(databases.get(set.template))
  if (template.state === "unsafe")
    refusal.push(
      applyDiagnostic("roles.unsafe-template", "error", {
        database: set.template,
        reason: template.reason,
      })
    )

  // 4. Явний CONNECT ролі входу Simetra до іншої бази
  const grants = await maintenance.query<{ database: string; grantee: string }>(
    [
      "SELECT d.datname::text AS database, g.rolname::text AS grantee",
      "FROM pg_catalog.pg_database d",
      "CROSS JOIN LATERAL pg_catalog.aclexplode(d.datacl) a",
      "JOIN pg_catalog.pg_roles g ON g.oid = a.grantee",
      "WHERE d.datacl IS NOT NULL AND a.grantee <> 0",
      "  AND a.privilege_type = 'CONNECT' AND g.rolname = ANY($1::text[])",
      "  AND d.datname <> $2::text",
      "ORDER BY 1, 2",
    ].join("\n"),
    [simetraLogins(set), set.database]
  )
  const shared = explicitConnectDatabases(
    grants,
    simetraLogins(set),
    set.database
  )
  if (shared.length > 0)
    refusal.push(
      applyDiagnostic("roles.shared-cluster", "error", {
        databases: shared.join(", "),
      })
    )

  // 5-7. Цільова база й незапечатаний шаблон: з'єднання лише з довіреним
  // власником і лише там, де воно потрібне
  const unsafe = (
    database: string,
    schema: string,
    reason: string
  ): EngineDiagnostic =>
    applyDiagnostic("roles.unsafe-schema", "error", {
      database,
      schema,
      reason,
    })
  const inspect = async <T>(
    conn: DbConnection,
    fn: (tx: ApplyTransaction) => Promise<T>
  ): Promise<T | EngineDiagnostic[]> =>
    dbs.transaction(conn, "rollback", async (tx) => {
      const denied = await enterSession(tx)
      return denied ?? (await fn(tx))
    })
  const isRefusal = (value: unknown): value is EngineDiagnostic[] =>
    Array.isArray(value)

  let target: DatabaseFacts | undefined
  let identityGrants: IdentityGrantFacts | undefined
  if (targetRow !== undefined && targetRow.owner === set.owner) {
    const read = await inspect(conns.target, async (tx) => {
      const ext = await readExtensionsFacts(tx)
      const auth = await readAuthFacts(tx, set.auth)
      // Схеми ще немає — обидва гранти дасть фаза запису після її створення
      const grants =
        auth.schemaOwner === undefined
          ? undefined
          : await readIdentityGrants(tx, set)
      return { ext, auth, grants }
    })
    if (isRefusal(read)) refusal.push(...read)
    else {
      const reason = extensionsSchemaViolation(read.ext)
      if (reason !== undefined)
        refusal.push(unsafe(set.database, EXTENSIONS_SCHEMA, reason))
      const authReason = authSchemaViolation(read.auth, set.auth)
      if (authReason !== undefined)
        refusal.push(unsafe(set.database, AUTH_SCHEMA, authReason))
      target = {
        extensionsSchema: read.ext.exists,
        checkInstalled: read.ext.checkSchema !== undefined,
        betterAuth: read.auth.schemaOwner !== undefined,
      }
      identityGrants = read.grants
    }
  }
  let templateFacts: DatabaseFacts | undefined
  if (template.state === "unsealed") {
    const read = await inspect(conns.template, async (tx) => ({
      ext: await readExtensionsFacts(tx),
      betterAuth:
        (
          await tx.query(
            "SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname = $1::text",
            [AUTH_SCHEMA]
          )
        ).length > 0,
    }))
    if (isRefusal(read)) refusal.push(...read)
    else {
      const reason = extensionsSchemaViolation(read.ext)
      if (reason !== undefined)
        refusal.push(unsafe(set.template, EXTENSIONS_SCHEMA, reason))
      if (read.betterAuth)
        refusal.push(
          applyDiagnostic("roles.unsafe-template", "error", {
            database: set.template,
            reason: "contains-better-auth",
          })
        )
      templateFacts = {
        extensionsSchema: read.ext.exists,
        checkInstalled: read.ext.checkSchema !== undefined,
        betterAuth: false,
      }
    }
  }
  if (refusal.length > 0) return { ok: false, error: refusal }
  return {
    ok: true,
    snapshot: {
      roles,
      database: targetRow !== undefined,
      template: template.state === "unsafe" ? "absent" : template.state,
      target,
      identityGrants,
      templateFacts,
    },
  }
}

/**
 * Кроки схеми `extensions` у базі транзакції: схема суперкористувача, `USAGE`
 * власнику, повторна перевірка безпосередньо перед `CREATE EXTENSION`.
 * Повторна — бо між фазами власник міг положити в схему код; відмова
 * відкочує транзакцію.
 */
async function prepareExtensions(
  tx: ApplyTransaction,
  set: PostgresClusterSet,
  database: string,
  facts: DatabaseFacts | undefined
): Promise<void> {
  // Об'єкт, що з'явився між фазами, дає помилку оператора, а не пропуск
  if (!facts?.extensionsSchema)
    await tx.query(`CREATE SCHEMA ${q(EXTENSIONS_SCHEMA)}`)
  await tx.query(
    `GRANT USAGE ON SCHEMA ${q(EXTENSIONS_SCHEMA)} TO ${q(set.owner)}`
  )
  if (facts?.checkInstalled) return
  const reason = extensionsSchemaViolation(await readExtensionsFacts(tx))
  if (reason !== undefined)
    throw new LateRefusal([
      applyDiagnostic("roles.unsafe-schema", "error", {
        database,
        schema: EXTENSIONS_SCHEMA,
        reason,
      }),
    ])
  await tx.query(
    `CREATE EXTENSION ${q(CHECK_EXTENSION)} SCHEMA ${q(EXTENSIONS_SCHEMA)}`
  )
}

/** Транзакція запису: прелюдія, звірка сесії, тіло; відмова — відкат. */
async function write<T>(
  dbs: ApplyDatabase,
  conn: DbConnection,
  fn: (tx: ApplyTransaction) => Promise<T>
): Promise<T> {
  return dbs.transaction(conn, "commit", async (tx) => {
    const denied = await enterSession(tx)
    if (denied !== undefined) throw new LateRefusal(denied)
    return fn(tx)
  })
}

/**
 * Фаза запису (лише без відмов читання) за знімком: наявне пропускається, а
 * чого не було, створюється без `IF NOT EXISTS`. Кожен запис комітиться до
 * наступного кроку, що від нього залежить, бо інше з'єднання незакомічених
 * ролей і баз не бачить.
 */
async function writePhase(
  dbs: ApplyDatabase,
  conns: ClusterConnections,
  set: PostgresClusterSet,
  snapshot: Snapshot
): Promise<PostgresClusterOutcome> {
  const created: string[] = []
  const present: string[] = []
  const skipped: string[] = []
  const planned = plannedRoles(set)

  // 1. Ролі кластера
  const missing = planned.filter((r) => !snapshot.roles.has(r.name))
  for (const r of planned) if (snapshot.roles.has(r.name)) present.push(r.name)
  await write(dbs, conns.maintenance, async (tx) => {
    // Налаштування сесії чи кластера дало б творцеві членство з INHERIT/SET;
    // для суперкористувача членства немає, але значення знімаємо явно
    await tx.query("SET LOCAL createrole_self_grant = ''")
    for (const r of missing) {
      for (const sql of r.create) await tx.query(sql)
      created.push(r.name)
    }
    // Наявна роль входу без нового батька профілю: доповнення парою §6.2
    for (const l of set.roles.login) {
      if (!snapshot.roles.has(l.name)) continue
      const row = (await readPlatformRoles(tx, [l.name], set.request)).find(
        (r) => r.name === l.name
      )
      for (const parent of row === undefined ? [] : lackingParents(l, row)) {
        await tx.query(pairGrant(parent, l.name))
        created.push(`${l.name}:${parent}`)
      }
    }
    // Налаштування ролі `auth` — другий шар після опції з'єднання пулу;
    // ідемпотентне, тож і для наявної ролі
    await tx.query(
      `ALTER ROLE ${q(set.auth)} SET search_path = ${q(AUTH_SCHEMA)}`
    )
  })

  // 2. База цілі
  if (snapshot.database) present.push(set.database)
  else {
    await dbs.statement(
      conns.maintenance,
      `CREATE DATABASE ${q(set.database)} OWNER ${q(set.owner)} ${CREATE_DATABASE_OPTIONS}`
    )
    created.push(set.database)
  }

  // 3. Ціль
  await write(dbs, conns.target, async (tx) => {
    await tx.query(
      `REVOKE CONNECT, TEMPORARY ON DATABASE ${q(set.database)} FROM PUBLIC`
    )
    await tx.query(
      `GRANT CONNECT ON DATABASE ${q(set.database)} TO ${simetraLogins(set).map(q).join(", ")}`
    )
    await prepareExtensions(tx, set, set.database, snapshot.target)
    if (!snapshot.target?.betterAuth)
      await tx.query(
        `CREATE SCHEMA ${q(AUTH_SCHEMA)} AUTHORIZATION ${q(set.auth)}`
      )
    await tx.query(
      `ALTER ROLE ${q(set.auth)} IN DATABASE ${q(set.database)} SET search_path = ${q(AUTH_SCHEMA)}`
    )
    // Гранти власнику лише на схему й одну таблицю ідентичності:
    // тригер провізії й зовнішній ключ моделі. Без `ALTER DEFAULT
    // PRIVILEGES` — інші таблиці Better Auth власнику не відкриваються
    const grants = snapshot.identityGrants
    const grantSql = identityGrantSql(set.owner, set.identity)
    const usage = `${set.identity.schema}:USAGE`
    if (grants?.usage === true) present.push(usage)
    else {
      await tx.query(grantSql.usage)
      created.push(usage)
    }
    const trigger = `${set.identity.schema}.${set.identity.name}:TRIGGER`
    // Таблиці ще немає — її створить міграція Better Auth, і грант дасть
    // повторний `roles`; це не відмова
    if (grants?.table === undefined) skipped.push(trigger)
    else if (grants.table.trigger && grants.table.references)
      present.push(trigger)
    else {
      await tx.query(grantSql.table)
      created.push(trigger)
    }
  })

  // 4. Шаблон
  if (snapshot.template === "sealed") present.push(set.template)
  else {
    if (snapshot.template === "absent") {
      await dbs.statement(
        conns.maintenance,
        `CREATE DATABASE ${q(set.template)} ${CREATE_DATABASE_OPTIONS}`
      )
      created.push(set.template)
    } else present.push(set.template)
    // Відкликання і для шаблону з перерваного запуску (ідемпотентно): до
    // позначки шаблон не має бути відкритий для PUBLIC
    await write(dbs, conns.maintenance, (tx) =>
      tx
        .query(
          `REVOKE CONNECT, TEMPORARY ON DATABASE ${q(set.template)} FROM PUBLIC`
        )
        .then(() => undefined)
    )
    await write(dbs, conns.template, (tx) =>
      prepareExtensions(tx, set, set.template, snapshot.templateFacts)
    )
    await dbs.statement(
      conns.maintenance,
      `ALTER DATABASE ${q(set.template)} WITH IS_TEMPLATE true ALLOW_CONNECTIONS false`
    )
    // Сесії шаблону заважали б `CREATE DATABASE … TEMPLATE`: тінь створюють,
    // коли в шаблоні немає інших підключень
    await write(dbs, conns.maintenance, (tx) =>
      tx
        .query(
          [
            "SELECT pg_catalog.pg_terminate_backend(a.pid)",
            "FROM pg_catalog.pg_stat_activity a",
            "WHERE a.datname = $1::text AND a.pid <> pg_catalog.pg_backend_pid()",
          ].join("\n"),
          [set.template]
        )
        .then(() => undefined)
    )
  }
  return { created, present, skipped }
}

/** З'єднання підготовки кластера: службова база, ціль, шаблон. */
export interface ClusterConnections {
  maintenance: DbConnection
  target: DbConnection
  /** Відкривається лише для незапечатаного шаблону. */
  template: DbConnection
}

/**
 * Готує кластер профілю `postgres` (спека профілю §3.4): ролі §3.1, цільову
 * базу з власником, схеми `extensions` і `better_auth`, `plpgsql_check`,
 * запечатаний шаблон тіней. Дві фази під одним advisory lock службової бази.
 * Фаза читання нічого не пише й збирає всі відмови; фаза запису не відмовляє
 * вибірково (окрім повторної перевірки `extensions` перед
 * `CREATE EXTENSION`) і діє за знімком читання. Повторний виклик нічого не
 * створює.
 */
export async function ensurePostgresCluster(
  dbs: ApplyDatabase,
  conns: ClusterConnections,
  set: PostgresClusterSet
): Promise<PostgresClusterResult> {
  try {
    // Зовнішня транзакція лише тримає замок і читає: вона не комітить, а
    // кожен запис фази запису йде власною транзакцією чи оператором
    return await dbs.transaction(
      conns.maintenance,
      "rollback",
      async (maintenance): Promise<PostgresClusterResult> => {
        const denied = await enterSession(maintenance)
        if (denied !== undefined) return { ok: false, error: denied }
        // До фази читання: `datlocale` є лише з Postgres 17, і старіший
        // сервер дав би сирий `42703` замість зрозумілої відмови
        const unsupported = await serverVersionRefusal(maintenance)
        if (unsupported !== undefined)
          return { ok: false, error: [unsupported] }
        await maintenance.query(
          `SELECT pg_catalog.pg_advisory_xact_lock(${CLUSTER_ADVISORY_LOCK})`
        )
        const read = await readPhase(dbs, conns, set, maintenance)
        if (!read.ok) return read
        return {
          ok: true,
          value: await writePhase(dbs, conns, set, read.snapshot),
        }
      }
    )
  } catch (error) {
    if (error instanceof LateRefusal)
      return { ok: false, error: error.diagnostics }
    throw error
  }
}
