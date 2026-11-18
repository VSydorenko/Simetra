import type { SqlParser } from "simetra/compiler"
import {
  DATABASE_PROVIDERS,
  LOGIN_ROLE_SETTINGS,
  loginRoleParentNames,
  PLATFORM_LOGIN_ROLES,
  PLATFORM_ROLES,
  PROVIDER_API_ROLES,
  quoteIdent,
  type DatabaseProvider,
  type PlatformLoginPurpose,
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
  /**
   * Ролі, досяжні з ролей запиту будь-яким ребром `pg_auth_members`, що
   * керують цією роллю (член з `ADMIN`) чи мають `SUPERUSER`.
   */
  requestPath: string[]
  /**
   * Значення `role` з `ALTER ROLE … SET` для всіх баз (`pg_db_role_setting`,
   * `setdatabase = 0`); `null` — налаштування немає. Налаштування окремої бази
   * не читається: воно діє як `SET role` на старті сесії, тож дає не більше,
   * ніж членства з `SET`, які звіряє гейт, а інша роль лише валить вхід.
   */
  roleSetting: string | null
}

/** Роль входу платформи і батьки, в які вона входить парою `INHERIT FALSE, SET TRUE`. */
export interface PlatformLoginRole {
  name: string
  /** Для `checkOnly` — дозволені батьки, а не обов'язкові. */
  memberOf: readonly string[]
  /**
   * Налаштування ролі (`LOGIN_ROLE_SETTINGS`): `role` — група, яку сесія
   * отримує з першого оператора. Без нього налаштування `role` бути не може.
   */
  settings?: Readonly<{ role: string }>
  /**
   * Наявну роль звіряють лише за дозволеними батьками: брак членства не
   * порушення. Так звіряє роль входу без провайдера (її ніхто не створює) і
   * гейт `roles`, що брак членства сам доповнює.
   */
  checkOnly?: true
}

/**
 * Що створює й звіряє `roles` (спека П4 §6.2): ролі грантів `names` — на кожному
 * сервері; ролі входу `login` — лише на цілі, бо бажаний SQL їх не згадує, тож
 * тіні вони не потрібні. Порожній перелік — роль входу пропущено (провайдер
 * невідомий).
 */
export interface PlatformRoleSet {
  names: readonly string[]
  login: readonly PlatformLoginRole[]
  /**
   * Ролі входу, які створювати не можна, але наявні звіряють: без провайдера
   * дозволені батьки — об'єднання профілів усіх провайдерів.
   */
  checkLogin?: readonly PlatformLoginRole[]
}

/** Результат одного створення чи звірки. */
export interface PlatformRoleOutcome {
  server: RoleServer
  name: string
  outcome: "created" | "present"
  /** Батьки, членство в яких цей виклик додав наявній ролі входу. */
  added?: string[]
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

/**
 * Ролі запиту API усіх провайдерів (§6.16 п. 2): об'єднання, а не профіль
 * одного провайдера, бо гейт `plan` провайдера не знає, а роль запиту будь-
 * якого з них у платформній ролі небезпечна однаково.
 */
const DEFAULT_REQUEST_NAMES: readonly string[] = [
  ...new Set(
    Object.values(PROVIDER_API_ROLES)
      .flatMap((roles) => Object.values(roles))
      .filter((role): role is string => role !== null)
  ),
]

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
 * Платформні ролі, які згадує бажаний SQL (спека designer §3.2). Дерева всього тексту —
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

/**
 * Форми названих ролей одним запитом. `requestPath` обходить усі ребра
 * `pg_auth_members`, а не лише `SET`/`INHERIT`: з PG16 `is_admin_of_role`
 * іде всіма членствами, тож роль запиту, що звичайним членством дістається
 * до керівника ролі платформи, може через `SET ROLE` на посередника з
 * `CREATEROLE` змінювати роль платформи. `UNION` завершує цикли.
 */
export async function readPlatformRoles(
  tx: ApplyTransaction,
  names: readonly string[],
  requestNames: readonly string[] = DEFAULT_REQUEST_NAMES
): Promise<PlatformRoleRow[]> {
  return tx.query<PlatformRoleRow & Record<string, unknown>>(
    [
      "WITH RECURSIVE reach(oid) AS (",
      "  SELECT oid FROM pg_catalog.pg_roles WHERE rolname = ANY($2::text[])",
      "  UNION",
      "  SELECT m.roleid FROM pg_catalog.pg_auth_members m",
      "    JOIN reach ON m.member = reach.oid",
      ")",
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
      "    WHERE m.roleid = r.oid) AS members,",
      "  (SELECT COALESCE(jsonb_agg(x.rolname ORDER BY x.rolname), '[]'::jsonb)",
      "     FROM reach JOIN pg_catalog.pg_roles x ON x.oid = reach.oid",
      "    WHERE x.rolsuper OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members a",
      '      WHERE a.roleid = r.oid AND a.member = x.oid AND a.admin_option)) AS "requestPath",',
      "  (SELECT pg_catalog.substr(c, 6) FROM pg_catalog.pg_db_role_setting s",
      "     CROSS JOIN LATERAL pg_catalog.unnest(s.setconfig) AS c",
      "    WHERE s.setrole = r.oid AND s.setdatabase = 0",
      "      AND pg_catalog.starts_with(c, 'role=')) AS \"roleSetting\"",
      "FROM pg_catalog.pg_roles r",
      "WHERE r.rolname = ANY($1::text[])",
      "ORDER BY r.rolname",
    ].join("\n"),
    [[...names], [...requestNames]]
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
 * Порушення ролі входу за фіксованим порядком (спека П4 §6.2). `allowed` — батьки,
 * які роль може мати; `expected` — ті, які вона мусить мати (лише повна
 * звірка `roles`: брак членства безпеки не послаблює). Атрибут `NOINHERIT`
 * з PG16 лише задає типове значення членства, тож перевіряється кожен рядок
 * кожного grantor.
 */
function loginViolation(
  found: PlatformRoleRow,
  def: PlatformLoginRole,
  expected: readonly string[],
  requestNames: readonly string[]
): string | undefined {
  const allowed = new Set(def.memberOf)
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
  const request = requestMember(found, requestNames)
  if (request !== undefined) return `request-role:${request}`
  const [path] = found.requestPath
  if (path !== undefined) return `request-path:${path}`
  const holder = found.members.find((m) => !managesOnly(m))
  if (holder !== undefined) return `member:${holder.role}`
  // Без налаштування роль лишається без прав (fail-closed), але звірка
  // його вимагає: інша роль у налаштуванні — не та форма, що в даних T0
  return (found.roleSetting ?? undefined) === def.settings?.role
    ? undefined
    : "setting:role"
}

/**
 * Роль запиту серед членів платформної ролі в будь-якій формі (§6.16 п. 2).
 * Навіть `ADMIN` без `INHERIT`/`SET` у ролі запиту з `CREATEROLE` дав би
 * запиту видати членство в ролі платформи собі чи іншим.
 */
const requestMember = (
  found: PlatformRoleRow,
  requestNames: readonly string[]
): string | undefined =>
  sortedNames(found.members.map((m) => m.role)).find((m) =>
    requestNames.includes(m)
  )

/**
 * Перше порушення безпечної форми ролі грантів (спека designer §3.2): без жодного
 * атрибута, ні в що не входить, а член може лише керувати нею. Член з
 * `ADMIN`, що сам має `SUPERUSER` чи `CREATEROLE`, нічого не здобуває —
 * такий грант Postgres 16+ дає творцеві. Єдиний виняток (спека П4 §6.2) — роль
 * входу платформи з формою пари в кожному рядку; він закритий за
 * замовчуванням: рядок ролі входу мусить бути в `found` і мати безпечну
 * форму, інакше `GRANT simetra_runtime TO x` дав би `x` ланцюг `SET` до
 * ролі грантів повз гейт.
 */
function grantRoleViolations(
  found: PlatformRoleRow,
  rows: readonly PlatformRoleRow[],
  login: readonly PlatformLoginRole[],
  requestNames: readonly string[],
  checkedLogins: ReadonlySet<string>
): { role: string; violation: string }[] {
  const role = found.name
  const attribute = ATTRIBUTES.find((a) => found.attributes[a])
  if (attribute !== undefined) return [{ role, violation: attribute }]
  const parents = sortedNames(found.memberOf.map((m) => m.role))
  const request =
    parents.find((p) => requestNames.includes(p)) ??
    requestMember(found, requestNames)
  if (request !== undefined)
    return [{ role, violation: `request-role:${request}` }]
  const [path] = found.requestPath
  if (path !== undefined) return [{ role, violation: `request-path:${path}` }]
  const [parent] = parents
  if (parent !== undefined) return [{ role, violation: `member-of:${parent}` }]
  const logins: { role: string; violation: string }[] = []
  for (const name of sortedNames(found.members.map((m) => m.role))) {
    const own = found.members.filter((m) => m.role === name)
    if (own.every(managesOnly)) continue
    const def = login.find((l) => l.name === name)
    const loginRow = rows.find((r) => r.name === name)
    if (def === undefined || !own.every(isPair) || loginRow === undefined)
      return [{ role, violation: `member:${name}` }]
    if (checkedLogins.has(name)) continue
    // Дозволені батьки — власні батьки цієї ролі входу, а не спільна
    // множина: батько, дозволений іншій ролі входу, цій не належить
    const broken = loginViolation(loginRow, def, [], requestNames)
    if (broken !== undefined) logins.push({ role: name, violation: broken })
  }
  return logins
}

/**
 * Відмови плану щодо потрібних ролей одного сервера. `login` — ролі входу
 * платформи, чия пара з роллю грантів допустима, з власними дозволеними
 * батьками кожної (`platformRoleSet`; тест на тегованих іменах передає свої).
 * Роль входу серед `required` звіряють повністю, а виняток пари її вже не
 * звіряє — повну звірку робить виклик, де вона серед `required`.
 * `requestNames` — ролі запиту API, які не можуть бути членами платформних
 * ролей і мати їх членами (типово — усіх провайдерів; тест передає теговані).
 */
export function platformRoleRefusals(
  required: readonly string[],
  found: readonly PlatformRoleRow[],
  server: RoleServer,
  login: readonly PlatformLoginRole[],
  requestNames: readonly string[] = DEFAULT_REQUEST_NAMES
): EngineDiagnostic[] {
  const checkedLogins = new Set(
    login.filter((l) => required.includes(l.name)).map((l) => l.name)
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
    const own = login.find((l) => l.name === role)
    const broken =
      own !== undefined
        ? (() => {
            const violation = loginViolation(
              row,
              own,
              own.checkOnly === true ? [] : own.memberOf,
              requestNames
            )
            return violation === undefined ? [] : [{ role, violation }]
          })()
        : grantRoleViolations(row, found, login, requestNames, checkedLogins)
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
  login: readonly PlatformLoginRole[],
  server: RoleServer,
  requestNames: readonly string[] = DEFAULT_REQUEST_NAMES
): Promise<EngineDiagnostic[]> {
  return platformRoleRefusals(
    required,
    await readPlatformRoles(
      tx,
      [...required, ...login.map((l) => l.name)],
      requestNames
    ),
    server,
    login,
    requestNames
  )
}

/**
 * Спільна передперевірка плану, звірки й репетиції (спека designer §3.2): потрібні ролі
 * мають бути на цілі й на `shadowBase` — до будь-якої тіні, бо тінь
 * завантажує бажаний SQL з грантами цим ролям і впала б сирою помилкою. Без
 * `shadowBase` тінь — у кластері цілі, і перевірки цілі досить.
 */
export async function checkPlatformRoles(
  dbs: ApplyDatabase,
  target: DbConnection,
  shadowBase: DbConnection | undefined,
  desiredSql: string,
  parse: SqlParser,
  provider: DatabaseProvider
): Promise<{ refusal?: EngineDiagnostic[] }> {
  const required = requiredPlatformRoles(desiredSql, parse)
  if (required.length === 0) return {}
  const { login } = platformRoleSet(provider)
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
        platformRoleGate(tx, required, login, server)
      ))
    )
  }
  return refusal.length > 0 ? { refusal } : {}
}

/**
 * Ролі, які створює `roles` (спека П4 §6.2). Без провайдера (немає файлу проєкту)
 * роль входу не створюється: без членства в ролі запиту її потім ніхто б не
 * виправив. Наявну `roles` звіряє за об'єднанням батьків усіх провайдерів.
 */
export function platformRoleSet(provider?: DatabaseProvider): PlatformRoleSet {
  const names = Object.values(PLATFORM_ROLES)
  const purposes = Object.entries(PLATFORM_LOGIN_ROLES) as [
    PlatformLoginPurpose,
    string,
  ][]
  if (provider === undefined)
    return {
      names,
      login: [],
      // Старе ефективне правило: батьки з даних T0 усіх профілів разом
      checkLogin: purposes.map(([purpose, name]) => ({
        name,
        memberOf: sortedNames(
          DATABASE_PROVIDERS.flatMap((p) => loginRoleParentNames(purpose, p))
        ),
        ...loginSettings(purpose),
        checkOnly: true as const,
      })),
    }
  return {
    names,
    checkLogin: [],
    // Склад і батьки кожної ролі входу — з даних T0, не літералом тут
    login: purposes.map(([purpose, name]) => ({
      name,
      memberOf: loginRoleParentNames(purpose, provider),
      ...loginSettings(purpose),
    })),
  }
}

/** Налаштування ролі входу з даних T0; без рядка — поля немає. */
const loginSettings = (
  purpose: PlatformLoginPurpose
): Pick<PlatformLoginRole, "settings"> => {
  const settings = LOGIN_ROLE_SETTINGS[purpose]
  return settings === undefined ? {} : { settings }
}

/**
 * Налаштування ролі входу при створенні (спека профілю postgres §3.1):
 * Centrifugo не вміє `SET ROLE`, тож групу ставить `ALTER ROLE … SET role`.
 * Наявній ролі налаштування не доповнюється: інше чи відсутнє — відмова форми.
 */
export const loginSettingSql = (login: PlatformLoginRole): string[] =>
  login.settings === undefined
    ? []
    : [
        `ALTER ROLE ${quoteIdent(login.name)} SET role = '${login.settings.role.replaceAll("'", "''")}'`,
      ]

/**
 * Членство ролі входу в батьку — пара §6.2. `INHERIT FALSE` явно: з PG16
 * типове значення членства бере атрибут ролі, а пара мусить бути саме такою.
 */
const pairGrant = (parent: string, login: string): string =>
  `GRANT ${quoteIdent(parent)} TO ${quoteIdent(login)} WITH INHERIT FALSE, SET TRUE`

/** Обов'язкові батьки ролі входу, членства в яких наявна роль не має. */
const lackingParents = (
  login: PlatformLoginRole,
  found: PlatformRoleRow
): string[] =>
  login.memberOf.filter((p) => !found.memberOf.some((m) => m.role === p))

/**
 * Гейт `roles` для ролі входу: брак обов'язкового членства — не відмова, бо
 * `roles` його доповнює; будь-яке інше порушення лишається відмовою.
 */
const allowingLack = (login: PlatformLoginRole): PlatformLoginRole => ({
  ...login,
  checkOnly: true,
})

/**
 * Батьки з `parents`, членство в яких сесія видати не може. Відсутній
 * батько, якого цей виклик створить, перевірки не потребує: творець
 * отримує на нього `ADMIN` сам.
 */
async function missingAdmin(
  tx: ApplyTransaction,
  parents: readonly string[],
  names: readonly string[]
): Promise<string[]> {
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
    [[...parents]]
  )
  return parents.filter((parent) => {
    const found = rows.find((r) => r.role === parent)
    if (found?.present !== true) return !names.includes(parent)
    return !found.admin
  })
}

/** Відмова доповнення: параметри несуть точний `GRANT`, який виконати замість. */
const grantDenied = (
  login: string,
  parent: string,
  server: RoleServer
): EngineDiagnostic =>
  applyDiagnostic("roles.membership-grant-denied", "error", {
    role: login,
    parent,
    server,
    statement: pairGrant(parent, login),
  })

/**
 * Створює відсутні платформні ролі (спека designer §3.2, спека П4 §6.2). Спершу на всіх серверах
 * лише читає — право ролі сесії й форму наявних ролей, — і пише лише без
 * жодної відмови: інакше ціль лишилася б із роллю, а тінь без неї. Право
 * потрібне лише там, де роль відсутня. Ціль і `shadowBase` можуть бути
 * одним кластером, а ролі кластерні: роль, створена на першому сервері, на
 * другому вже `present`. Брак `ADMIN` на батьку ролі входу зупиняє лише
 * цю роль входу: ролі грантів і інші ролі входу потрібні незалежно від неї, а
 * роль входу без членства в ролі запиту мовчки змінила б шлях читання.
 *
 * Наявній ролі входу `roles` додає брак обов'язкового членства — рівно пару
 * §6.2, як при створенні: інакше базу, створену до нового батька профілю,
 * без ручного SQL не оновити. Інша форма членства, зайвий батько чи будь-яке
 * інше порушення — та сама відмова форми, без тихого виправлення.
 */
export async function ensurePlatformRoles(
  dbs: ApplyDatabase,
  servers: readonly { server: RoleServer; db: DbConnection }[],
  roles: PlatformRoleSet
): Promise<{ created: PlatformRoleOutcome[]; refusal?: EngineDiagnostic[] }> {
  const { names, login } = roles
  const gated = [...login, ...(roles.checkLogin ?? [])]
  // Брак членства доповнюється нижче, тож гейт його не відхиляє
  const gateLogins = gated.map(allowingLack)
  const refusal: EngineDiagnostic[] = []
  const adminRefusal: EngineDiagnostic[] = []
  // Р21: роль входу без ADMIN на своєму батьку зупиняється сама, решта ні
  const blocked = new Set<string>()
  for (const { server, db } of servers) {
    const read = await dbs.transaction(db, "rollback", async (tx) => {
      const [self] = await tx.query<{ allowed: boolean }>(
        "SELECT rolcreaterole OR rolsuper AS allowed FROM pg_catalog.pg_roles WHERE rolname = current_user"
      )
      const allowed = self?.allowed === true
      const found = await readPlatformRoles(tx, [
        ...names,
        ...gated.map((l) => l.name),
      ])
      const present = gated.filter((l) => found.some((r) => r.name === l.name))
      // На цілі наявні ролі входу звіряються повністю разом з ролями грантів:
      // роль входу серед потрібних знімає її повтор з винятку пари, тож
      // порушення звітується один раз
      const shape = await platformRoleGate(
        tx,
        server === "target" ? [...names, ...present.map((l) => l.name)] : names,
        gateLogins,
        server
      )
      const missing = names.filter(
        (name) => !found.some((r) => r.name === name)
      )
      const denied = allowed ? [] : missing
      if (server === "target")
        for (const l of login) {
          const row = found.find((r) => r.name === l.name)
          if (row !== undefined) {
            // Доповнення наявної: GRANT членства вимагає лише ADMIN на батьку
            const lacking = lackingParents(l, row)
            const without =
              lacking.length > 0 ? await missingAdmin(tx, lacking, missing) : []
            if (without.length > 0) blocked.add(l.name)
            adminRefusal.push(
              ...without.map((parent) => grantDenied(l.name, parent, server))
            )
          } else if (!allowed) denied.push(l.name)
          else {
            const without = await missingAdmin(tx, l.memberOf, missing)
            if (without.length > 0) blocked.add(l.name)
            adminRefusal.push(
              ...without.map((role) =>
                applyDiagnostic("roles.admin-option-missing", "error", {
                  role,
                  server,
                })
              )
            )
          }
        }
      return { shape, denied }
    })
    refusal.push(
      ...read.shape.filter((d) => d.code !== "plan.platform-role-missing"),
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
    outcome: "created" | "present" | EngineDiagnostic[],
    added: string[] = []
  ) => {
    if (outcome === "created" || outcome === "present")
      created.push({
        server,
        name,
        outcome,
        ...(added.length > 0 ? { added } : {}),
      })
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
            () => platformRoleGate(tx, [name], gateLogins, server)
          )
        )
      if (server === "target")
        for (const l of login) {
          if (blocked.has(l.name)) continue
          const outcome = await createOrCheck(
            tx,
            l.name,
            [
              `CREATE ROLE ${quoteIdent(l.name)} LOGIN NOINHERIT`,
              ...l.memberOf.map((parent) => pairGrant(parent, l.name)),
              ...loginSettingSql(l),
            ],
            () => platformRoleGate(tx, [l.name], gateLogins, server)
          )
          if (outcome !== "present") {
            record(server, l.name, outcome)
            continue
          }
          // Брак — за свіжим рядком: членство могло з'явитися між фазами
          const [row] = await readPlatformRoles(tx, [l.name])
          const { added, denied } = await addMemberships(
            tx,
            l.name,
            row === undefined ? [] : lackingParents(l, row),
            server
          )
          late.push(...denied)
          record(server, l.name, outcome, added)
        }
    })
  }
  const all = [...late, ...adminRefusal]
  return all.length > 0 ? { created, refusal: all } : { created }
}

/**
 * Доповнення наявної ролі входу парами §6.2. Право перевірила фаза читання;
 * батько, якого між фазами відкликали чи позбавили сесію `ADMIN`, дає
 * кодовану відмову з точним `GRANT`, а не сирий `42501`: точка збереження
 * тримає транзакцію живою.
 */
async function addMemberships(
  tx: ApplyTransaction,
  login: string,
  parents: readonly string[],
  server: RoleServer
): Promise<{ added: string[]; denied: EngineDiagnostic[] }> {
  const added: string[] = []
  const denied: EngineDiagnostic[] = []
  for (const parent of parents) {
    await tx.query("SAVEPOINT platform_membership")
    try {
      await tx.query(pairGrant(parent, login))
    } catch (error) {
      // 42501 — немає ADMIN, 42704 — батька вже немає
      if (
        !(error instanceof ApplyDbError) ||
        (error.sqlstate !== "42501" && error.sqlstate !== "42704")
      )
        throw error
      await tx.query("ROLLBACK TO SAVEPOINT platform_membership")
      denied.push(grantDenied(login, parent, server))
      continue
    }
    await tx.query("RELEASE SAVEPOINT platform_membership")
    added.push(parent)
  }
  return { added, denied }
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
