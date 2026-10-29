import type { SqlParser } from "simetra/compiler"
import {
  LOGIN_ROLE_REQUEST_PURPOSES,
  PLATFORM_LOGIN_ROLES,
  PLATFORM_ROLES,
  PROVIDER_API_ROLES,
  quoteIdent,
  type DatabaseProvider,
} from "simetra/model"
import type { DbConnection, EngineDiagnostic } from "../engine"
import { applyDiagnostic } from "./diagnostic"
import { ApplyDbError, type ApplyDatabase, type ApplyTransaction } from "./port"

/** Сервер, на якому перевірено роль: ціль чи база тіні. */
export type RoleServer = "target" | "shadow"

/**
 * Форма платформної ролі з каталогу. `memberOf` і `members` — рядки
 * `pg_auth_members` (Postgres 16+), по одному на кожного grantor: будь-який
 * з них з `INHERIT` чи `SET` уже дає члену права ролі. `manager` — член сам
 * має `SUPERUSER` чи `CREATEROLE`.
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
  memberOf: {
    role: string
    grantor: string
    admin: boolean
    inherit: boolean
    set: boolean
  }[]
  members: {
    role: string
    admin: boolean
    inherit: boolean
    set: boolean
    manager: boolean
  }[]
}

/** Роль входу платформи і батьки, в які вона входить парою `INHERIT FALSE, SET TRUE`. */
export interface PlatformLoginRole {
  name: string
  memberOf: readonly string[]
}

/**
 * Що створює й звіряє `roles` (Р-A1-4): ролі грантів `names` — на кожному
 * сервері; роль входу — лише на цілі, бо бажаний SQL її не згадує, тож тіні
 * вона не потрібна.
 */
export interface PlatformRoleSet {
  names: readonly string[]
  login?: PlatformLoginRole
}

/** Результат одного створення чи звірки. */
export interface PlatformRoleOutcome {
  server: RoleServer
  name: string
  outcome: "created" | "present"
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

const DEFAULT_LOGIN_NAMES: readonly string[] =
  Object.values(PLATFORM_LOGIN_ROLES)

/** Ролі запиту, членом яких роль входу може бути за профілем будь-якого провайдера. */
const REQUEST_ROLES: readonly string[] = (
  Object.keys(LOGIN_ROLE_REQUEST_PURPOSES) as DatabaseProvider[]
).flatMap((provider) =>
  LOGIN_ROLE_REQUEST_PURPOSES[provider].map(
    (purpose) => PROVIDER_API_ROLES[provider][purpose]
  )
)

const sortedNames = (names: Iterable<string>): string[] =>
  [...new Set(names)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))

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
  return sortedNames([...roles].filter((name) => PLATFORM_ROLE_NAMES.has(name)))
}

/** Форми названих ролей одним запитом. */
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
      "  (SELECT COALESCE(jsonb_agg(jsonb_build_object('role', g.rolname,",
      "       'grantor', o.rolname, 'admin', m.admin_option,",
      "       'inherit', m.inherit_option, 'set', m.set_option)",
      "       ORDER BY g.rolname, o.rolname), '[]'::jsonb)",
      "     FROM pg_catalog.pg_auth_members m",
      "     JOIN pg_catalog.pg_roles g ON g.oid = m.roleid",
      "     JOIN pg_catalog.pg_roles o ON o.oid = m.grantor",
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

/** Член, що може лише керувати роллю: лише `ADMIN`, і сам має `SUPERUSER` чи `CREATEROLE`. */
const managesOnly = (m: PlatformRoleRow["members"][number]): boolean =>
  m.admin && m.manager && !m.inherit && !m.set

/** Рядок пари §6.2: роль входу бере права лише через `SET ROLE`. */
const isPair = (m: {
  admin: boolean
  inherit: boolean
  set: boolean
}): boolean => !m.admin && !m.inherit && m.set

/**
 * Порушення ролі входу за фіксованим порядком (Р-A1-3). `allowed` — батьки,
 * які роль може мати; `expected` — ті, які вона мусить мати (лише повна
 * звірка `roles`: брак членства безпеки не послаблює). Атрибут `NOINHERIT`
 * з PG16 лише задає типове значення членства, тож перевіряється кожен рядок
 * кожного grantor.
 */
function loginViolation(
  found: PlatformRoleRow,
  allowed: ReadonlySet<string>,
  expected: readonly string[]
): string | undefined {
  const attribute = ATTRIBUTES.find(
    (a) => found.attributes[a] !== (a === "login")
  )
  if (attribute !== undefined) return attribute
  const parents = sortedNames(found.memberOf.map((m) => m.role))
  const extra = parents.find((p) => !allowed.has(p))
  if (extra !== undefined) return `member-of:${extra}`
  const missing = sortedNames(expected).find((p) => !parents.includes(p))
  if (missing !== undefined) return `membership-missing:${missing}`
  const option = parents.find((p) =>
    found.memberOf.some((m) => m.role === p && !isPair(m))
  )
  if (option !== undefined) return `membership-option:${option}`
  const holder = found.members.find((m) => !managesOnly(m))
  return holder === undefined ? undefined : `member:${holder.role}`
}

/**
 * Перше порушення безпечної форми ролі грантів (Р2a1-2): без жодного
 * атрибута, ні в що не входить, а член може лише керувати нею. Член з
 * `ADMIN`, що сам має `SUPERUSER` чи `CREATEROLE`, нічого не здобуває —
 * такий грант Postgres 16+ дає творцеві. Єдиний виняток (Р-A1-3) — роль
 * входу платформи з формою пари в кожному рядку; він закритий за
 * замовчуванням: рядок ролі входу мусить бути в `found` і мати безпечну
 * форму, інакше `GRANT simetra_runtime TO x` дав би `x` ланцюг `SET` до
 * ролі грантів повз гейт.
 */
function grantRoleViolations(
  found: PlatformRoleRow,
  rows: readonly PlatformRoleRow[],
  loginNames: readonly string[],
  allowedParents: ReadonlySet<string>,
  checkedLogins: ReadonlySet<string>
): { role: string; violation: string }[] {
  const role = found.name
  const attribute = ATTRIBUTES.find((a) => found.attributes[a])
  if (attribute !== undefined) return [{ role, violation: attribute }]
  const [parent] = sortedNames(found.memberOf.map((m) => m.role))
  if (parent !== undefined) return [{ role, violation: `member-of:${parent}` }]
  const logins: { role: string; violation: string }[] = []
  for (const name of sortedNames(found.members.map((m) => m.role))) {
    const own = found.members.filter((m) => m.role === name)
    if (own.every(managesOnly)) continue
    const login = rows.find((r) => r.name === name)
    if (!loginNames.includes(name) || !own.every(isPair) || login === undefined)
      return [{ role, violation: `member:${name}` }]
    if (checkedLogins.has(name)) continue
    const broken = loginViolation(login, allowedParents, [])
    if (broken !== undefined) logins.push({ role: name, violation: broken })
  }
  return logins
}

/**
 * Відмови плану щодо потрібних ролей одного сервера. `loginNames` — ролі
 * входу, чия пара з роллю грантів допустима (типово — ролі входу
 * платформи; тест на тегованих іменах передає свої). `login` — повна
 * звірка ролі входу, коли вона серед `required` (лише `roles`).
 */
export function platformRoleRefusals(
  required: readonly string[],
  found: readonly PlatformRoleRow[],
  server: RoleServer,
  loginNames: readonly string[] = DEFAULT_LOGIN_NAMES,
  login?: PlatformLoginRole
): EngineDiagnostic[] {
  const allowedParents = new Set([
    ...required,
    ...REQUEST_ROLES,
    ...(login?.memberOf ?? []),
  ])
  const checkedLogins = new Set(
    login !== undefined && required.includes(login.name) ? [login.name] : []
  )
  const seen = new Set<string>()
  return required.flatMap((role) => {
    const row = found.find((r) => r.name === role)
    if (row === undefined)
      return [
        applyDiagnostic("plan.platform-role-missing", "error", {
          role,
          server,
        }),
      ]
    const broken =
      login !== undefined && role === login.name
        ? (() => {
            const violation = loginViolation(
              row,
              new Set(login.memberOf),
              login.memberOf
            )
            return violation === undefined ? [] : [{ role, violation }]
          })()
        : grantRoleViolations(
            row,
            found,
            loginNames,
            allowedParents,
            checkedLogins
          )
    return broken
      .filter((b) => {
        // Роль входу в кількох ролях грантів звітується один раз
        const key = `${b.role}\u0000${b.violation}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      .map((b) =>
        applyDiagnostic("plan.platform-role-shape", "error", {
          role: b.role,
          server,
          violation: b.violation,
        })
      )
  })
}

/**
 * Гейт форми ролей одного сервера: читає потрібні ролі разом з ролями
 * входу — без їхніх рядків виняток пари був би сліпим — і звіряє.
 */
export async function platformRoleGate(
  tx: ApplyTransaction,
  required: readonly string[],
  loginNames: readonly string[],
  server: RoleServer,
  login?: PlatformLoginRole
): Promise<EngineDiagnostic[]> {
  return platformRoleRefusals(
    required,
    await readPlatformRoles(tx, [...required, ...loginNames]),
    server,
    loginNames,
    login
  )
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
    refusal.push(
      ...(await dbs.transaction(db, "rollback", (tx) =>
        platformRoleGate(tx, required, DEFAULT_LOGIN_NAMES, server)
      ))
    )
  }
  return refusal.length > 0 ? { refusal } : {}
}

/**
 * Ролі, які створює `roles` (Р-A1-4). Без провайдера (немає файлу проєкту)
 * роль входу не створюється й не звіряється: без членства в ролі запиту її
 * потім ніхто б не виправив — наявну `roles` лише звіряє.
 */
export function platformRoleSet(provider?: DatabaseProvider): PlatformRoleSet {
  const names = Object.values(PLATFORM_ROLES)
  if (provider === undefined) return { names }
  return {
    names,
    login: {
      name: PLATFORM_LOGIN_ROLES.runtime,
      memberOf: [
        PLATFORM_ROLES.command,
        ...LOGIN_ROLE_REQUEST_PURPOSES[provider].map(
          (purpose) => PROVIDER_API_ROLES[provider][purpose]
        ),
      ],
    },
  }
}

/**
 * Право сесії видати членство в кожному батьку ролі входу. Відсутній
 * батько, якого цей виклик створить, перевірки не потребує: творець
 * отримує на нього `ADMIN` сам.
 */
async function missingAdmin(
  tx: ApplyTransaction,
  login: PlatformLoginRole,
  names: readonly string[],
  server: RoleServer
): Promise<EngineDiagnostic[]> {
  const rows = await tx.query<{
    role: string
    present: boolean
    admin: boolean
  }>(
    [
      "SELECT p.role, r.oid IS NOT NULL AS present,",
      "  COALESCE(pg_catalog.pg_has_role(current_user, r.oid, 'MEMBER WITH ADMIN OPTION'), false) AS admin",
      "FROM unnest($1::text[]) AS p(role)",
      "LEFT JOIN pg_catalog.pg_roles r ON r.rolname = p.role",
    ].join("\n"),
    [[...login.memberOf]]
  )
  return login.memberOf
    .filter((parent) => {
      const found = rows.find((r) => r.role === parent)
      if (found?.present !== true) return !names.includes(parent)
      return !found.admin
    })
    .map((role) =>
      applyDiagnostic("roles.admin-option-missing", "error", { role, server })
    )
}

/**
 * Створює відсутні платформні ролі (Р2a1-3, Р-A1-4). Спершу на всіх серверах
 * лише читає — право ролі сесії й форму наявних ролей, — і пише лише без
 * жодної відмови: інакше ціль лишилася б із роллю, а тінь без неї. Право
 * потрібне лише там, де роль відсутня. Ціль і `shadowBase` можуть бути
 * одним кластером, а ролі кластерні: роль, створена на першому сервері, на
 * другому вже `present`. Брак `ADMIN` на батьку ролі входу зупиняє лише
 * роль входу: ролі грантів потрібні `plan` кожного проєкту, а роль входу
 * без членства в ролі запиту мовчки змінила б шлях читання.
 */
export async function ensurePlatformRoles(
  dbs: ApplyDatabase,
  servers: readonly { server: RoleServer; db: DbConnection }[],
  roles: PlatformRoleSet
): Promise<{ created: PlatformRoleOutcome[]; refusal?: EngineDiagnostic[] }> {
  const { names, login } = roles
  const loginNames = login === undefined ? DEFAULT_LOGIN_NAMES : [login.name]
  const refusal: EngineDiagnostic[] = []
  const adminRefusal: EngineDiagnostic[] = []
  for (const { server, db } of servers) {
    const read = await dbs.transaction(db, "rollback", async (tx) => {
      const [self] = await tx.query<{ allowed: boolean }>(
        "SELECT rolcreaterole OR rolsuper AS allowed FROM pg_catalog.pg_roles WHERE rolname = current_user"
      )
      const allowed = self?.allowed === true
      const found = await readPlatformRoles(tx, [...names, ...loginNames])
      const shape = await platformRoleGate(tx, names, loginNames, server)
      const missing = names.filter(
        (name) => !found.some((r) => r.name === name)
      )
      const denied = allowed ? [] : missing
      const own: EngineDiagnostic[] = []
      if (login !== undefined && server === "target") {
        if (found.some((r) => r.name === login.name))
          own.push(
            ...(await platformRoleGate(
              tx,
              [login.name],
              loginNames,
              server,
              login
            ))
          )
        else if (!allowed) denied.push(login.name)
        else
          adminRefusal.push(...(await missingAdmin(tx, login, missing, server)))
      }
      return { shape, denied, own }
    })
    refusal.push(
      ...read.shape.filter((d) => d.code !== "plan.platform-role-missing"),
      ...read.own,
      ...read.denied.map((role) =>
        applyDiagnostic("roles.create-role-denied", "error", { role, server })
      )
    )
  }
  if (refusal.length > 0)
    return { created: [], refusal: [...refusal, ...adminRefusal] }

  const created: PlatformRoleOutcome[] = []
  const late: EngineDiagnostic[] = []
  const record = (
    server: RoleServer,
    name: string,
    outcome: "created" | "present" | EngineDiagnostic[]
  ) => {
    if (outcome === "created" || outcome === "present")
      created.push({ server, name, outcome })
    else late.push(...outcome)
  }
  for (const { server, db } of servers) {
    await dbs.transaction(db, "commit", async (tx) => {
      // Налаштування сесії чи кластера (`'set, inherit'`) дало б творцеві
      // членство з INHERIT/SET, і власний результат не пройшов би
      // `plan.platform-role-shape`; порожнє — рівно ADMIN
      await tx.query("SET LOCAL createrole_self_grant = ''")
      for (const name of names)
        record(
          server,
          name,
          await createOrCheck(
            tx,
            name,
            [`CREATE ROLE ${quoteIdent(name)} NOLOGIN NOINHERIT`],
            () => platformRoleGate(tx, [name], loginNames, server)
          )
        )
      if (
        login !== undefined &&
        server === "target" &&
        adminRefusal.length === 0
      ) {
        const q = quoteIdent(login.name)
        record(
          server,
          login.name,
          await createOrCheck(
            tx,
            login.name,
            [
              `CREATE ROLE ${q} LOGIN NOINHERIT`,
              // INHERIT FALSE явно: з PG16 типове значення членства бере
              // атрибут ролі, а пара §6.2 мусить бути саме такою
              ...login.memberOf.map(
                (parent) =>
                  `GRANT ${quoteIdent(parent)} TO ${q} WITH INHERIT FALSE, SET TRUE`
              ),
            ],
            () => platformRoleGate(tx, [login.name], loginNames, server, login)
          )
        )
      }
    })
  }
  const all = [...late, ...adminRefusal]
  return all.length > 0 ? { created, refusal: all } : { created }
}

/**
 * Створення однієї ролі фази запису. Роль, що з'явилася між фазами (чужий
 * запуск, адміністратор), звіряється так само, як наявна у фазі читання:
 * інакше `present` прикрив би небезпечну форму. Гонку з паралельним
 * `CREATE ROLE` (`42710`) ловить точка збереження, тож транзакція живе далі;
 * роль входу створюється з членствами в тій самій точці — половинчастої
 * ролі не лишається.
 */
async function createOrCheck(
  tx: ApplyTransaction,
  name: string,
  create: readonly string[],
  gate: () => Promise<EngineDiagnostic[]>
): Promise<"created" | "present" | EngineDiagnostic[]> {
  const shape = async (): Promise<"present" | EngineDiagnostic[]> => {
    const refusal = await gate()
    return refusal.length > 0 ? refusal : "present"
  }
  if ((await readPlatformRoles(tx, [name])).length > 0) return shape()
  await tx.query("SAVEPOINT platform_role")
  try {
    for (const sql of create) await tx.query(sql)
  } catch (error) {
    if (!(error instanceof ApplyDbError) || error.sqlstate !== "42710")
      throw error
    await tx.query("ROLLBACK TO SAVEPOINT platform_role")
    return shape()
  }
  await tx.query("RELEASE SAVEPOINT platform_role")
  return "created"
}
