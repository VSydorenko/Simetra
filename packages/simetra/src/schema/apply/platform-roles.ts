import type { SqlParser } from "simetra/compiler"
import { PLATFORM_ROLES, quoteIdent } from "simetra/model"
import type { DbConnection, EngineDiagnostic } from "../engine"
import { applyDiagnostic } from "./diagnostic"
import type { ApplyDatabase, ApplyTransaction } from "./port"

/** Сервер, на якому перевірено роль: ціль чи база тіні. */
export type RoleServer = "target" | "shadow"

/**
 * Форма платформної ролі з каталогу. `members` — рядки `pg_auth_members`
 * (Postgres 16+): `manager` — член сам має `SUPERUSER` чи `CREATEROLE`.
 */
export interface PlatformRoleRow {
  name: string
  attributes: {
    login: boolean
    inherit: boolean
    superuser: boolean
    bypassRls: boolean
    createRole: boolean
    createDb: boolean
    replication: boolean
  }
  /** Ролі, в які входить ця роль. */
  memberOf: string[]
  members: {
    role: string
    admin: boolean
    inherit: boolean
    set: boolean
    manager: boolean
  }[]
}

/**
 * Атрибути в порядку оголошення: перше порушення називається за ним, тож
 * відмова детермінована.
 */
const ATTRIBUTES = [
  "login",
  "inherit",
  "superuser",
  "bypassRls",
  "createRole",
  "createDb",
  "replication",
] as const satisfies readonly (keyof PlatformRoleRow["attributes"])[]

const PLATFORM_ROLE_NAMES: ReadonlySet<string> = new Set(
  Object.values(PLATFORM_ROLES)
)

/** Імена ролей у вузлах `RoleSpec` дерева розбору, на будь-якій глибині. */
function collectRoles(node: unknown, into: Set<string>): void {
  if (Array.isArray(node)) {
    for (const child of node) collectRoles(child, into)
    return
  }
  if (typeof node !== "object" || node === null) return
  for (const [key, child] of Object.entries(node)) {
    if (key === "RoleSpec" && typeof child === "object" && child !== null) {
      const name = (child as { rolename?: unknown }).rolename
      if (typeof name === "string") into.add(name)
    }
    collectRoles(child, into)
  }
}

/**
 * Платформні ролі, які згадує бажаний SQL (Р2a1-2). Дерева всього тексту —
 * рендер моделі й стан застосування, — а не перелік генераторів: стан без
 * «Користувачів» сам вставляє гранти схеми `simetra`, і друге джерело правди
 * розійшлося б із ним мовчки.
 */
export function requiredPlatformRoles(
  desiredSql: string,
  parse: SqlParser
): string[] {
  const parsed = parse(desiredSql)
  if (!parsed.ok)
    throw new Error(`the desired SQL does not parse: ${parsed.message}`)
  const roles = new Set<string>()
  for (const { stmt } of parsed.statements) collectRoles(stmt, roles)
  return [...roles]
    .filter((name) => PLATFORM_ROLE_NAMES.has(name))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

/**
 * Форми названих ролей одним запитом. Рядок членства на кожного грантора
 * окремо: будь-який з них з `INHERIT` чи `SET` уже дає члену права ролі.
 */
export async function readPlatformRoles(
  tx: ApplyTransaction,
  names: readonly string[]
): Promise<PlatformRoleRow[]> {
  return tx.query<PlatformRoleRow & Record<string, unknown>>(
    [
      "SELECT r.rolname AS name,",
      "  jsonb_build_object('login', r.rolcanlogin, 'inherit', r.rolinherit,",
      "    'superuser', r.rolsuper, 'bypassRls', r.rolbypassrls,",
      "    'createRole', r.rolcreaterole, 'createDb', r.rolcreatedb,",
      "    'replication', r.rolreplication) AS attributes,",
      "  (SELECT COALESCE(jsonb_agg(DISTINCT g.rolname), '[]'::jsonb)",
      "     FROM pg_catalog.pg_auth_members m",
      "     JOIN pg_catalog.pg_roles g ON g.oid = m.roleid",
      '    WHERE m.member = r.oid) AS "memberOf",',
      "  (SELECT COALESCE(jsonb_agg(jsonb_build_object('role', u.rolname,",
      "       'admin', m.admin_option, 'inherit', m.inherit_option,",
      "       'set', m.set_option, 'manager', u.rolsuper OR u.rolcreaterole)",
      "       ORDER BY u.rolname), '[]'::jsonb)",
      "     FROM pg_catalog.pg_auth_members m",
      "     JOIN pg_catalog.pg_roles u ON u.oid = m.member",
      "    WHERE m.roleid = r.oid) AS members",
      "FROM pg_catalog.pg_roles r",
      "WHERE r.rolname = ANY($1::text[])",
      "ORDER BY r.rolname",
    ].join("\n"),
    [[...names]]
  )
}

/**
 * Перше порушення безпечної форми (Р2a1-2): роль середовища без жодного
 * атрибута, ні в що не входить, а член може лише керувати нею. Член з
 * `ADMIN`, що сам має `SUPERUSER` чи `CREATEROLE`, нічого не здобуває —
 * такий грант Postgres 16+ дає творцеві.
 */
function violation(found: PlatformRoleRow): string | undefined {
  const attribute = ATTRIBUTES.find((a) => found.attributes[a])
  if (attribute !== undefined) return attribute
  const [parent] = [...found.memberOf].sort()
  if (parent !== undefined) return `member-of:${parent}`
  const holder = found.members.find(
    (m) => m.inherit || m.set || (m.admin && !m.manager)
  )
  return holder === undefined ? undefined : `member:${holder.role}`
}

/** Відмови плану щодо потрібних ролей одного сервера. */
export function platformRoleRefusals(
  required: readonly string[],
  found: readonly PlatformRoleRow[],
  server: RoleServer
): EngineDiagnostic[] {
  return required.flatMap((role) => {
    const row = found.find((r) => r.name === role)
    if (row === undefined)
      return [
        applyDiagnostic("plan.platform-role-missing", "error", {
          role,
          server,
        }),
      ]
    const broken = violation(row)
    return broken === undefined
      ? []
      : [
          applyDiagnostic("plan.platform-role-shape", "error", {
            role,
            server,
            violation: broken,
          }),
        ]
  })
}

/**
 * Спільна передперевірка плану, звірки й репетиції (Р2a1-2): потрібні ролі
 * мають бути на цілі й на `shadowBase` — до будь-якої тіні, бо тінь
 * завантажує бажаний SQL з грантами цим ролям і впала б сирою помилкою. Без
 * `shadowBase` тінь — у кластері цілі, і перевірки цілі досить.
 */
export async function checkPlatformRoles(
  dbs: ApplyDatabase,
  target: DbConnection,
  shadowBase: DbConnection | undefined,
  desiredSql: string,
  parse: SqlParser
): Promise<{ refusal?: EngineDiagnostic[] }> {
  const required = requiredPlatformRoles(desiredSql, parse)
  if (required.length === 0) return {}
  const servers: { server: RoleServer; db: DbConnection }[] = [
    { server: "target", db: target },
    ...(shadowBase === undefined
      ? []
      : [{ server: "shadow" as const, db: shadowBase }]),
  ]
  const refusal: EngineDiagnostic[] = []
  for (const { server, db } of servers) {
    const found = await dbs.transaction(db, "rollback", (tx) =>
      readPlatformRoles(tx, required)
    )
    refusal.push(...platformRoleRefusals(required, found, server))
  }
  return refusal.length > 0 ? { refusal } : {}
}

/**
 * Створює відсутні платформні ролі як `NOLOGIN NOINHERIT` (Р2a1-3). Спершу
 * на всіх серверах лише читає — право ролі сесії й форму наявних ролей, —
 * і пише лише без жодної відмови: інакше ціль лишилася б із роллю, а тінь
 * без неї. Право потрібне лише там, де роль відсутня. Ціль і `shadowBase`
 * можуть бути одним кластером, а ролі кластерні: роль, створена на першому
 * сервері, на другому вже `present`.
 */
export async function ensurePlatformRoles(
  dbs: ApplyDatabase,
  servers: readonly { server: RoleServer; db: DbConnection }[],
  names: readonly string[]
): Promise<
  | { server: RoleServer; name: string; outcome: "created" | "present" }[]
  | { refusal: EngineDiagnostic[] }
> {
  const refusal: EngineDiagnostic[] = []
  for (const { server, db } of servers) {
    const { allowed, found } = await dbs.transaction(
      db,
      "rollback",
      async (tx) => {
        const [self] = await tx.query<{ allowed: boolean }>(
          "SELECT rolcreaterole OR rolsuper AS allowed FROM pg_catalog.pg_roles WHERE rolname = current_user"
        )
        return {
          allowed: self?.allowed === true,
          found: await readPlatformRoles(tx, names),
        }
      }
    )
    refusal.push(
      ...platformRoleRefusals(names, found, server).filter(
        (d) => d.code !== "plan.platform-role-missing"
      )
    )
    if (!allowed)
      refusal.push(
        ...names
          .filter((name) => !found.some((r) => r.name === name))
          .map((role) =>
            applyDiagnostic("roles.create-role-denied", "error", {
              role,
              server,
            })
          )
      )
  }
  if (refusal.length > 0) return { refusal }

  const outcomes: {
    server: RoleServer
    name: string
    outcome: "created" | "present"
  }[] = []
  for (const { server, db } of servers) {
    await dbs.transaction(db, "commit", async (tx) => {
      // Налаштування сесії чи кластера (`'set, inherit'`) дало б творцеві
      // членство з INHERIT/SET, і власний результат не пройшов би
      // `plan.platform-role-shape`; порожнє — рівно ADMIN
      await tx.query("SET LOCAL createrole_self_grant = ''")
      for (const name of names) {
        const [present] = await readPlatformRoles(tx, [name])
        if (present === undefined)
          await tx.query(`CREATE ROLE ${quoteIdent(name)} NOLOGIN NOINHERIT`)
        outcomes.push({
          server,
          name,
          outcome: present === undefined ? "created" : "present",
        })
      }
    })
  }
  return outcomes
}
