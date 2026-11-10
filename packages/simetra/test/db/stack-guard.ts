// Сторож DB-прогону vitest обох пакетів; globalSetup проєкту — файл профілю
// (`stack-guard.<профіль>.ts`), бо профіль прогону задає проєкт, а не env
// людини. Локальний стек кожного профілю один на машину, а DB-тести ганяють
// кілька сесій і агентів: правила «один прогін стека за раз» і «стек після
// прогону такий самий, як до нього» тримає цей механізм, а не дисципліна в
// промптах.
import { execFileSync } from "node:child_process"
import {
  openSync,
  readFileSync,
  statfsSync,
  unlinkSync,
  writeSync,
  closeSync,
} from "node:fs"
import { join } from "node:path"
import pg from "pg"
import {
  PROVIDER_EVENT_SOURCES,
  PROVIDER_IDENTITY_SOURCES,
  PROVIDER_OWNER_ROLES,
} from "simetra/model"
import {
  enterRun,
  GUARD_APPLICATION_NAME,
  newRunTag,
  runTagOf,
  SHADOW_PREFIX,
  shadowAgeMinutes,
  testDatabaseUrl,
  testSuperuserUrl,
} from "./connection"
import {
  type Exec,
  type Fetch,
  nodeExec,
  runBuckets,
  runContainers,
} from "./external"
import { installInterruptCleanup } from "./interrupt"
import {
  enterProvider,
  PROVIDER_ENV,
  TEST_STACKS,
  type TestProvider,
} from "./profile"
import {
  assertStack,
  type ClientFactory,
  type GuardClient,
  openAdmin,
  stackDatabases,
  stopRunBackends,
} from "./sweep"

// Межа — з запасом над найдовшим повним прогоном (designer); чекати довше
// означає завислий прогін, і про нього краще дізнатися, ніж чекати безкінечно
const LOCK_WAIT_MS = 45 * 60_000
const LOCK_POLL_MS = 5_000
// Тіні двигуна — повні бази; прогін, що впирається в заповнений диск, падає
// вже наприкінці й лишає сиріт, тож краще не стартувати зовсім. Docker на
// Linux тримає дані стеку на кореневому розділі
const MIN_FREE_BYTES = 3 * 1024 ** 3
// Адмінка Garage локальна: довша відповідь — завислий сервіс, і прогін
// краще впаде, ніж чекатиме
const LIST_TIMEOUT_MS = 10_000

// Контейнери й бакети — лише свого профілю: ресурси прогону іншого стека,
// що йде одночасно, не є змінами цього
// Схеми й розширення — `<база>.<ім'я>` по кожній базі стека; шаблони —
// рядок фактів бази з `pg_database` (дозвіл з'єднань, ознака шаблону,
// власник, ACL): знімок не містить ACL, а шаблон не можна відкрити
export type Snapshot = Record<
  | "databases"
  | "roles"
  | "schemas"
  | "extensions"
  | "templates"
  | "containers"
  | "buckets",
  string[]
>

/**
 * Стан стека на старті прогону: знімок і відбиток `better_auth` бази тестів
 * (`undefined` — профіль без неї).
 */
export interface RunStart {
  snapshot: Snapshot
  identity: string | undefined
}

/**
 * Lock file of the stack of profile `p`. In `/tmp`, not in the checkout and not
 * in `tmpdir()`: the stack is shared by every checkout, worktree and session of
 * the machine, and sessions with another `TMPDIR` would take another file.
 * `scripts/db-stack.mjs` takes the same path.
 */
export function lockPath(p: TestProvider): string {
  return join("/tmp", TEST_STACKS[p].lockFile)
}

/** The vitest globalSetup of a DB project that runs against the stack of `p`. */
export function setupFor(p: TestProvider): () => Promise<() => Promise<void>> {
  return () => setup(p)
}

async function setup(p: TestProvider): Promise<() => Promise<void>> {
  // До воркерів: env профілю успадковують і вони, і прибиральник на сигналі
  enterProvider(p)
  const lock = lockPath(p)
  const releaseLock = (): void => {
    // Лише свій замок: чужий, перехоплений після нашого падіння, не чіпаємо
    if (readHolder(lock)?.pid === process.pid) removeLockFile(lock)
  }
  checkFreeSpace()
  await acquireLock(lock, p)
  let removeInterruptCleanup = (): void => {}
  try {
    // Форки воркерів, які vitest стартує після globalSetup, успадковують env:
    // тег в іменах об'єктів і в `application_name` кожного з'єднання прогону
    const runTag = newRunTag()
    enterRun(runTag)
    removeInterruptCleanup = installInterruptCleanup({
      tag: runTag,
      release: releaseLock,
    })
    const tree = treeState()
    // Тег уже є, але воркерів ще нема: об'єктів цього прогону в знімку бути
    // не може, тож звіт називає лише чужі лишки. Рядок старту — після
    // `assertStack`: адреса, перевизначена на чужий стек, інакше дала б у лозі
    // «прогін на стеку p» там, де прогону не було
    const before = await startChecks(p, {
      announce: () =>
        process.stderr.write(
          `DB run ${runTag} on ${p} stack${tree !== undefined ? ` at ${tree.summary}` : ""}\n`
        ),
    })
    const leftovers = leftoverReport(before.snapshot, p)
    if (leftovers.length > 0) process.stderr.write(`${leftovers.join("\n")}\n`)
    return async () => {
      // Нормальне завершення не прибирає: що лишилось, показує звірка стеку
      removeInterruptCleanup()
      try {
        // Запит, кинутий тестом без очікування (тайм-аут, незакритий пул),
        // сервер виконує й далі: після звільнення замка він вантажив би стек
        // наступному прогону. Завершуємо до звірки — `CREATE` такого бекенду
        // інакше з'явився б у стеку вже після знімка
        const backends = await stopRunBackends(runTag)
        if (backends.stopped > 0 || backends.left.length > 0)
          process.stderr.write(
            `DB run ${runTag}: stopped ${backends.stopped} backend(s) still running after the tests${backends.left.length > 0 ? `; still running: ${backends.left.join(", ")}` : ""}\n`
          )
        const changed = treeState()
        if (tree !== undefined && changed?.summary !== tree.summary)
          process.stderr.write(
            `The working tree changed during the DB run (${tree.summary} → ${changed?.summary ?? "unknown"}): the results are not tied to one commit\n`
          )
        await endChecks(p, before)
      } finally {
        releaseLock()
      }
    }
  } catch (error) {
    removeInterruptCleanup()
    releaseLock()
    throw error
  }
}

function checkFreeSpace(): void {
  const stats = statfsSync("/")
  const free = stats.bavail * stats.bsize
  if (free < MIN_FREE_BYTES)
    throw new Error(
      `Only ${(free / 1024 ** 3).toFixed(1)} GB free on /: a DB run needs at least ${MIN_FREE_BYTES / 1024 ** 3} GB (shadow databases are full databases). Free disk space first.`
    )
}

/**
 * Takes the lock file `lock` of the stack of `p`, waiting while a live run
 * holds it; refuses a lock this process already holds.
 */
export async function acquireLock(
  lock: string,
  p: TestProvider
): Promise<void> {
  const deadline = Date.now() + LOCK_WAIT_MS
  let announced = false
  for (;;) {
    try {
      const fd = openSync(lock, "wx")
      writeSync(
        fd,
        `${process.pid}\n${process.cwd()}\n${new Date().toISOString()}\n`
      )
      closeSync(fd)
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    }
    const holder = readHolder(lock)
    // Два DB-проєкти в одному процесі ділять env (тег, профіль), а свого ж
    // замка процес не дочекається
    if (holder?.pid === process.pid)
      throw new Error(
        `This process already holds ${lock}: one DB project per vitest process (run each with its own --project)`
      )
    // Убитий прогін лишає файл замка без живого процесу — замок не тримає
    // ніхто, і його можна забрати
    if (holder === undefined || !isAlive(holder.pid)) {
      removeLockFile(lock)
      continue
    }
    if (Date.now() > deadline)
      throw new Error(
        `The local ${p} stack is still busy after ${LOCK_WAIT_MS / 60_000} min: DB run PID ${holder.pid} (${holder.cwd}, since ${holder.since}). Lock file: ${lock}`
      )
    if (!announced) {
      process.stderr.write(
        `The local ${p} stack is busy: DB run PID ${holder.pid} (${holder.cwd}, since ${holder.since}); waiting…\n`
      )
      announced = true
    }
    await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS))
  }
}

function readHolder(
  lock: string
): { pid: number; cwd: string; since: string } | undefined {
  try {
    const [pid, cwd = "?", since = "?"] = readFileSync(lock, "utf8").split("\n")
    const parsed = Number(pid)
    return Number.isInteger(parsed) && parsed > 0
      ? { pid: parsed, cwd, since }
      : undefined
  } catch {
    return undefined
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM — процес є, але чужого користувача
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

function removeLockFile(lock: string): void {
  try {
    unlinkSync(lock)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
}

function treeState(): { summary: string } | undefined {
  try {
    const head = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
    }).trim()
    const dirty = execFileSync("git", ["status", "--porcelain"], {
      encoding: "utf8",
    })
      .split("\n")
      .filter((line) => line !== "")
    return {
      summary:
        dirty.length === 0
          ? `${head}, clean tree`
          : `${head}, ${dirty.length} uncommitted path(s)`,
    }
  } catch {
    // Без git (архів, контейнер) відбиток просто не друкується
    return undefined
  }
}

/** Залежності перевірок сторожа, які юніт-тест підставляє. */
export interface GuardDeps {
  client?: ClientFactory
  exec?: Exec
  fetch?: Fetch
  /** Рядок старту прогону: друкується, щойно адреси звірено зі стеком. */
  announce?: () => void
}

/**
 * Перевірки старту прогону під замком і знімок «до»: стек профілю, роль
 * адреси тестів, стан `better_auth`, потім знімок. Знімок і звірка чужого
 * стека під своїм замком не тримали б «один прогін за раз» ні для одного з
 * двох, а знімок адреси з іншою роллю — тієї моделі з'єднання, яку
 * перевіряють тести.
 */
export async function startChecks(
  p: TestProvider,
  deps: GuardDeps = {}
): Promise<RunStart> {
  await assertStack(p, deps)
  deps.announce?.()
  await assertTestRole(p, deps)
  const identity = await assertIdentityState(p, deps)
  return { snapshot: await snapshot(p, deps), identity }
}

/**
 * Адреса тестів стартує роллю власника профілю без `rolsuper` (спека профілю
 * §10.3, запобіжник 3): так модель з'єднання перевіряє кожен прогін, зокрема
 * scoped і з перевизначеною адресою. З'єднання — без прелюдії: перевіряється
 * саме стартова роль.
 */
export async function assertTestRole(
  p: TestProvider,
  deps: GuardDeps = {}
): Promise<void> {
  const owner = PROVIDER_OWNER_ROLES[p]
  const make = deps.client ?? ((config) => new pg.Client(config))
  const client = make({
    connectionString: testDatabaseUrl(),
    application_name: GUARD_APPLICATION_NAME,
  })
  await client.connect()
  let row: { role: string; superuser: boolean } | undefined
  try {
    row = (
      await client.query<{ role: string; superuser: boolean }>(
        "select current_user as role, rolsuper as superuser from pg_catalog.pg_roles where rolname = current_user"
      )
    ).rows[0]
  } finally {
    await client.end()
  }
  if (row?.role !== owner || row.superuser)
    throw new Error(
      `test database URL does not run as ${owner} (SIMETRA_TEST_DATABASE_URL?): it starts as ${row?.role ?? "an unknown role"}${row?.superuser === true ? ", a superuser" : ""}`
    )
}

/**
 * Звірка кінця прогону: новий знімок проти знімка `before` і відбиток
 * `better_auth` проти стартового; відмінність — збій прогону з командами
 * прибирання.
 */
export async function endChecks(
  p: TestProvider,
  before: RunStart,
  deps: GuardDeps = {}
): Promise<void> {
  const leaks = diff(before.snapshot, await snapshot(p, deps))
  const problems = leaks.length > 0 ? [leakMessage(leaks, p)] : []
  const identity = await identityFingerprint(p, deps)
  if (identity !== before.identity)
    problems.push(
      `The run changed better_auth of database ${testsDatabase(p)} (fingerprint ${before.identity ?? "none"} → ${identity ?? "none"}): a test granted, altered or created something there outside a rollback. Restore it by hand; the start check of the next run names what differs from the db:pg:start state.`
    )
  if (problems.length > 0) throw new Error(problems.join("\n"))
}

// Роль, якій `db:pg:start` віддає схему ідентичності (міграція Better Auth
// іде від неї, як у проді)
const IDENTITY_ROLE = "simetra_auth"

/**
 * Запити звірки `better_auth` бази тестів; `$1` — схема ідентичності, `$2` —
 * її таблиця (у відбитку — роль ідентичності). Іменовані, щоб юніт-тест
 * відповідав на кожен окремо.
 */
export const IDENTITY_SQL = {
  columns:
    "select a.attname::text as name from pg_catalog.pg_attribute a join pg_catalog.pg_class c on c.oid = a.attrelid join pg_catalog.pg_namespace n on n.oid = c.relnamespace where n.nspname = $1 and c.relname = $2 and a.attnum > 0 and not a.attisdropped order by a.attnum",
  owners:
    "select 'schema ' || n.nspname as object, pg_catalog.pg_get_userbyid(n.nspowner)::text as owner from pg_catalog.pg_namespace n where n.nspname = $1 union all select 'relation ' || c.relname, pg_catalog.pg_get_userbyid(c.relowner)::text from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace where n.nspname = $1 order by 1",
  grants:
    "select o.object, case a.grantee when 0 then 'PUBLIC' else pg_catalog.pg_get_userbyid(a.grantee)::text end as grantee, a.privilege_type::text as privilege from (select 'schema ' || n.nspname as object, n.nspacl as acl from pg_catalog.pg_namespace n where n.nspname = $1 union all select 'relation ' || c.relname, c.relacl from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace where n.nspname = $1) o cross join lateral pg_catalog.aclexplode(o.acl) a order by 1, 2, 3",
  defaultAcl:
    "select d.defaclobjtype::text as type, pg_catalog.pg_get_userbyid(d.defaclrole)::text as role from pg_catalog.pg_default_acl d join pg_catalog.pg_namespace n on n.oid = d.defaclnamespace where n.nspname = $1 order by 1, 2",
  triggers:
    "select t.tgname::text as name, t.tgenabled::text as enabled from pg_catalog.pg_trigger t join pg_catalog.pg_class c on c.oid = t.tgrelid join pg_catalog.pg_namespace n on n.oid = c.relnamespace where n.nspname = $1 and c.relname = $2 order by 1",
  // Колонки, власники й ACL схеми та її відношень, тригери, типові
  // привілеї схеми й налаштування ролі ідентичності: знімок стека ACL не
  // містить, тож грант, лишений тестом поза відкатом, інакше пройшов би
  fingerprint: `select pg_catalog.md5(pg_catalog.concat_ws(E'\\n',
  coalesce((select pg_catalog.string_agg(c.relname || '.' || a.attname || ' ' || pg_catalog.format_type(a.atttypid, a.atttypmod) || ' ' || a.attnotnull::text, ',' order by c.relname, a.attnum) from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace join pg_catalog.pg_attribute a on a.attrelid = c.oid where n.nspname = $1 and a.attnum > 0 and not a.attisdropped), ''),
  coalesce((select pg_catalog.pg_get_userbyid(n.nspowner)::text || ' ' || coalesce(n.nspacl::text, '') from pg_catalog.pg_namespace n where n.nspname = $1), ''),
  coalesce((select pg_catalog.string_agg(c.relname || ' ' || pg_catalog.pg_get_userbyid(c.relowner)::text || ' ' || coalesce(c.relacl::text, ''), ',' order by c.relname) from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace where n.nspname = $1), ''),
  coalesce((select pg_catalog.string_agg(c.relname || ' ' || t.tgname || ' ' || t.tgenabled::text, ',' order by c.relname, t.tgname) from pg_catalog.pg_trigger t join pg_catalog.pg_class c on c.oid = t.tgrelid join pg_catalog.pg_namespace n on n.oid = c.relnamespace where n.nspname = $1), ''),
  coalesce((select pg_catalog.string_agg(d.defaclobjtype::text || ' ' || pg_catalog.pg_get_userbyid(d.defaclrole)::text || ' ' || d.defaclacl::text, ',' order by 1) from pg_catalog.pg_default_acl d join pg_catalog.pg_namespace n on n.oid = d.defaclnamespace where n.nspname = $1), ''),
  coalesce((select pg_catalog.string_agg(s.setdatabase::text || ' ' || s.setconfig::text, ',' order by 1) from pg_catalog.pg_db_role_setting s join pg_catalog.pg_roles r on r.oid = s.setrole where r.rolname = $2), '')
)) as fingerprint`,
} as const

// Схема ідентичності має стан `db:pg:start` лише на профілі, де її створює
// старт стека; на Supabase схемою `auth` володіє провайдер
function identityTable(
  p: TestProvider
): { schema: string; name: string } | undefined {
  return p === "postgres" ? PROVIDER_IDENTITY_SOURCES[p].table : undefined
}

function testsDatabase(p: TestProvider): string {
  return stackDatabases(p).at(-1)!
}

/**
 * Звірка `better_auth` бази тестів зі станом після `pnpm db:pg:start` до
 * знімка (спека профілю §10.3, «знімок стека»): колонки таблиці
 * ідентичності — з колонками джерела подій цієї гілки, власники, гранти,
 * типові привілеї й тригери — абсолютно. Відбиток лише відносний: залишок
 * прогону, убитого до звірки кінця, став би базою наступного. Повертає
 * відбиток для звірки кінця; `undefined` — профіль без цієї схеми.
 */
export async function assertIdentityState(
  p: TestProvider,
  deps: GuardDeps = {}
): Promise<string | undefined> {
  const table = identityTable(p)
  if (table === undefined) return undefined
  const database = testsDatabase(p)
  const client = await openAdmin(testSuperuserUrl(), database, deps)
  try {
    const params = [table.schema, table.name]
    const rows = async <R extends Record<string, string>>(
      sql: string,
      values: unknown[] = params.slice(0, 1)
    ): Promise<R[]> => (await client.query<R>(sql, values)).rows
    const columns = (
      await rows<{ name: string }>(IDENTITY_SQL.columns, params)
    ).map((c) => c.name)
    const expected =
      PROVIDER_EVENT_SOURCES[p].find(
        (s) => s.schema === table.schema && s.table === table.name
      )?.columns ?? []
    const mismatch = columnMismatch(columns, expected)
    if (mismatch !== undefined)
      throw new Error(
        `better_auth."user" of database ${database} does not match this branch (${mismatch})`
      )
    const owner = PROVIDER_OWNER_ROLES[p]
    const differences = identityStateDifferences(
      {
        owners: await rows(IDENTITY_SQL.owners),
        grants: await rows(IDENTITY_SQL.grants),
        defaultAcl: await rows(IDENTITY_SQL.defaultAcl),
        triggers: await rows(IDENTITY_SQL.triggers, params),
      },
      { schema: table.schema, table: table.name, owner }
    )
    if (differences.length > 0)
      throw new Error(
        `better_auth of database ${database} is not in the db:pg:start state (${differences.join("; ")}): restore it by hand or rebuild the stack (stopping the stack is the owner's call)`
      )
    return await fingerprintIn(client, table)
  } finally {
    await client.end()
  }
}

// Бракує колонок — стек старший за гілку, і міграцію дасть повторний старт;
// зайві — стек з іншої гілки, а зупинити спільний стек вирішує власник
function columnMismatch(
  actual: readonly string[],
  expected: readonly string[]
): string | undefined {
  const missing = expected.filter((c) => !actual.includes(c))
  const extra = actual.filter((c) => !expected.includes(c))
  const parts: string[] = []
  if (missing.length > 0)
    parts.push(
      `missing column(s) ${missing.join(", ")}: run pnpm db:pg:start to migrate it`
    )
  if (extra.length > 0)
    parts.push(
      `extra column(s) ${extra.join(", ")}: the stack comes from another branch; stopping the stack is the owner's call`
    )
  if (parts.length === 0 && actual.join(",") !== expected.join(","))
    parts.push(
      `column order ${actual.join(", ")}, expected ${expected.join(", ")}: the stack comes from another branch; stopping the stack is the owner's call`
    )
  return parts.length > 0 ? parts.join("; ") : undefined
}

/**
 * Відмінності `better_auth` від стану після `db:pg:start`: схема й відношення
 * — роль ідентичності; власник має лише `USAGE` на схему й `TRIGGER` на
 * таблицю ідентичності (тригер провізії), інших отримувачів немає; типових
 * привілеїв у схемі немає; тригери таблиці ідентичності ввімкнені.
 */
export function identityStateDifferences(
  facts: {
    owners: Record<string, string>[]
    grants: Record<string, string>[]
    defaultAcl: Record<string, string>[]
    triggers: Record<string, string>[]
  },
  o: { schema: string; table: string; owner: string }
): string[] {
  const allowed = new Set([
    `schema ${o.schema} ${o.owner} USAGE`,
    `relation ${o.table} ${o.owner} TRIGGER`,
  ])
  return [
    ...facts.owners
      .filter((r) => r.owner !== IDENTITY_ROLE)
      .map((r) => `${r.object} is owned by ${r.owner}`),
    ...facts.grants
      .filter(
        (g) =>
          g.grantee !== IDENTITY_ROLE &&
          !allowed.has(`${g.object} ${g.grantee} ${g.privilege}`)
      )
      .map((g) => `${g.object} grants ${g.privilege} to ${g.grantee}`),
    ...facts.defaultAcl.map(
      (d) =>
        `default privileges of ${d.role} for type ${d.type} in schema ${o.schema}`
    ),
    ...facts.triggers
      .filter((t) => t.enabled === "D")
      .map((t) => `trigger ${t.name} on ${o.table} is disabled`),
  ]
}

/**
 * Відбиток `better_auth` бази тестів для звірки кінця прогону; `undefined` —
 * профіль без цієї схеми.
 */
export async function identityFingerprint(
  p: TestProvider,
  deps: GuardDeps = {}
): Promise<string | undefined> {
  const table = identityTable(p)
  if (table === undefined) return undefined
  const client = await openAdmin(testSuperuserUrl(), testsDatabase(p), deps)
  try {
    return await fingerprintIn(client, table)
  } finally {
    await client.end()
  }
}

async function fingerprintIn(
  client: GuardClient,
  table: { schema: string }
): Promise<string> {
  const row = (
    await client.query<{ fingerprint: string }>(IDENTITY_SQL.fingerprint, [
      table.schema,
      IDENTITY_ROLE,
    ])
  ).rows[0]
  if (row === undefined) throw new Error("better_auth fingerprint: no row")
  return row.fingerprint
}

// Перелік контейнерів і бакетів, що впав, валить прогін: порожній замість
// нього сховав би витік. Каталоги кластера (бази, ролі, факти шаблонів) — з
// бази `postgres`; схеми й розширення — з кожної бази стека: тести пишуть у
// базу тестів, а базовий стан і `superuserClient` — і в `postgres`
async function snapshot(
  p: TestProvider,
  deps: GuardDeps = {}
): Promise<Snapshot> {
  const containers = (await runContainers(p, deps.exec ?? nodeExec)).map(
    (c) => c.name
  )
  const buckets = (
    await runBuckets(TEST_STACKS[p], deps.fetch ?? fetch, LIST_TIMEOUT_MS)
  ).map((b) => b.name)
  const names = async (client: GuardClient, sql: string): Promise<string[]> =>
    (await client.query<{ name: string }>(sql)).rows.map((row) => row.name)
  const result: Snapshot = {
    databases: [],
    roles: [],
    schemas: [],
    extensions: [],
    templates: [],
    containers,
    buckets,
  }
  for (const database of stackDatabases(p)) {
    const client = await openAdmin(testSuperuserUrl(), database, deps)
    try {
      if (database === "postgres") {
        result.databases = await names(
          client,
          "select datname as name from pg_catalog.pg_database order by 1"
        )
        result.roles = await names(
          client,
          "select rolname as name from pg_catalog.pg_roles order by 1"
        )
        // Шаблон з `datallowconn = false` не відкрити — його факти лише тут
        const templates = await client.query<{
          name: string
          allowconn: boolean
          template: boolean
          owner: string
          acl: string
        }>(
          "select datname as name, datallowconn as allowconn, datistemplate as template, pg_catalog.pg_get_userbyid(datdba) as owner, coalesce(datacl::text, '') as acl from pg_catalog.pg_database where datistemplate or not datallowconn order by 1"
        )
        result.templates = templates.rows.map(
          (t) =>
            `${t.name} allowconn=${t.allowconn} template=${t.template} owner=${t.owner} acl=${t.acl}`
        )
      }
      // Тимчасові схеми сесій Postgres створює сам і не прибирає — це не слід тесту
      for (const name of await names(
        client,
        "select nspname as name from pg_catalog.pg_namespace where nspname !~ '^pg_(toast_)?temp_[0-9]+$' order by 1"
      ))
        result.schemas.push(`${database}.${name}`)
      for (const name of await names(
        client,
        "select extname as name from pg_catalog.pg_extension order by 1"
      ))
        result.extensions.push(`${database}.${name}`)
    } finally {
      await client.end()
    }
  }
  return result
}

/**
 * Рядки звіту про об'єкти прогонів, що вже є на стеку; порожньо — їх нема.
 * Замок гарантує, що інший DB-прогін зараз не йде, тож тегові об'єкти на
 * старті — лишки вбитого прогону чи збою прибиральника: SIGKILL не ловиться,
 * а звірка наступного прогону їх не побачить, бо вони вже є в знімку «до».
 * Їх лише називаємо, згрупувавши за тегом із командою прибиральника цього
 * тегу: що видаляти на спільному стеку, вирішує людина. Тінь без тегу могла
 * лишити й інша сесія (ручний спайк), тож для неї — окремий `DROP` на ім'я.
 */
export function leftoverReport(
  before: Pick<Snapshot, "databases" | "roles"> &
    Partial<Pick<Snapshot, "containers" | "buckets">>,
  p: TestProvider,
  now: number = Date.now()
): string[] {
  const byTag = new Map<string, string[]>()
  const untaggedShadows: string[] = []
  const objects = [
    ...before.databases.map((name) => ({ kind: "database" as const, name })),
    ...before.roles.map((name) => ({ kind: "role" as const, name })),
  ]
  for (const { kind, name } of objects) {
    const shadow = kind === "database" && name.startsWith(SHADOW_PREFIX)
    const tag = runTagOf(kind, name)
    if (tag !== undefined)
      byTag.set(tag, [
        ...(byTag.get(tag) ?? []),
        `${kind} ${name}${shadow ? ` (${ageNote(name, now)})` : ""}`,
      ])
    else if (shadow) untaggedShadows.push(name)
  }
  // Тег бакета — в імені `run-<тег>`; ім'я контейнера тегу не несе, тож
  // контейнер названо окремо з командою на ім'я
  for (const name of before.buckets ?? []) {
    const tag = name.slice("run-".length)
    byTag.set(tag, [...(byTag.get(tag) ?? []), `bucket ${name}`])
  }
  const containers = before.containers ?? []
  const lines: string[] = []
  if (byTag.size > 0)
    lines.push(
      "Objects of earlier DB runs are already on the stack, likely left by a killed run or a failed sweep; they are not removed. A run's sweep drops only the objects of its tag:",
      ...[...byTag].flatMap(([tag, names]) => [
        `  run ${tag}: ${names.join(", ")}`,
        // Профіль явно: прибиральник без нього пішов би на типовий стек
        `    cd packages/simetra && ${PROVIDER_ENV}=${p} node --import tsx test/db/sweep.ts ${tag}`,
      ])
    )
  if (containers.length > 0)
    lines.push(
      "Containers of earlier DB runs are already on the stack, likely left by a killed run; they are not removed. To clean up, after checking nobody else owns them:",
      ...containers.map((name) => `  docker rm -f -v ${name}`)
    )
  if (untaggedShadows.length > 0)
    lines.push(
      "Untagged shadow databases are already on the stack, left by a killed run or another session; they are not removed. To clean up, after checking nobody else owns them:",
      ...untaggedShadows.map(
        (name) =>
          `  DROP DATABASE "${name}" WITH (FORCE);  -- ${ageNote(name, now)}`
      )
    )
  return lines
}

function ageNote(name: string, now: number): string {
  const age = shadowAgeMinutes(name, now)
  return age === undefined ? "age unknown" : `${Math.round(age)} min old`
}

export type Change = {
  kind: keyof Snapshot
  name: string
  change: "added" | "removed"
}

export function diff(before: Snapshot, after: Snapshot): Change[] {
  return (Object.keys(before) as (keyof Snapshot)[]).flatMap((kind) => {
    const was = new Set(before[kind])
    const now = new Set(after[kind])
    return [
      ...after[kind]
        .filter((name) => !was.has(name))
        .map((name) => ({ kind, name, change: "added" as const })),
      ...before[kind]
        .filter((name) => !now.has(name))
        .map((name) => ({ kind, name, change: "removed" as const })),
    ]
  })
}

export function leakMessage(
  changes: readonly Change[],
  p: TestProvider
): string {
  const lines = changes.map(
    ({ kind, name, change }) => `  ${change} ${kind}: ${name}`
  )
  const cleanup = changes.flatMap(({ kind, name, change }) => {
    if (change !== "added") return []
    // Шаблон без зняття ознаки не видалиться; для звичайної бази рядок безпечний
    if (kind === "databases")
      return [
        `  ALTER DATABASE "${name}" WITH IS_TEMPLATE false;`,
        `  DROP DATABASE "${name}" WITH (FORCE);`,
      ]
    // Роль, яку створив тест, видаляє лише суперкористувач стека
    // (testSuperuserUrl): на стеку Supabase у postgres немає ADMIN на неї.
    // `DROP OWNED BY` діє в поточній базі — тож у кожній базі стека
    if (kind === "roles") {
      const [main, ...rest] = stackDatabases(p)
      const su = TEST_STACKS[p].superuserName
      return [
        ...rest.map(
          (database) =>
            `  DROP OWNED BY "${name}";  -- as ${su}, in database ${database}`
        ),
        `  DROP OWNED BY "${name}"; DROP ROLE "${name}";  -- as ${su}, in database ${main!}`,
      ]
    }
    // Ім'я схеми й розширення — `<база>.<ім'я>`: `DROP` діє в поточній базі
    const dot = name.indexOf(".")
    const [database, local] = [name.slice(0, dot), name.slice(dot + 1)]
    if (kind === "schemas")
      return [`  DROP SCHEMA "${local}";  -- in database ${database}`]
    if (kind === "templates")
      return [
        `  database facts now: ${name}; restore the facts from before the run by hand (ALTER DATABASE … ALLOW_CONNECTIONS / IS_TEMPLATE / OWNER TO, GRANT / REVOKE)`,
      ]
    if (kind === "containers") return [`  docker rm -f -v ${name}`]
    // Порожнити бакет прибиральник ще не вміє (Р5): це робить людина
    if (kind === "buckets")
      return [`  bucket ${name}: empty and delete in Garage`]
    return [`  DROP EXTENSION "${local}";  -- in database ${database}`]
  })
  return [
    "The DB run left the local stack different from how it found it (a test that does not clean up, or another client changed the stack during the run):",
    ...lines,
    ...(cleanup.length > 0
      ? ["Cleanup, after checking nobody else owns these objects:", ...cleanup]
      : []),
  ].join("\n")
}
