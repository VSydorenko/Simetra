// Сторож DB-прогону vitest обох пакетів; globalSetup проєкту — файл профілю
// (`stack-guard.<профіль>.ts`), бо профіль прогону задає проєкт, а не env
// людини. Локальний стек кожного профілю один на машину, а DB-тести ганяють
// кілька сесій і агентів: правила «один прогін стека за раз» і «стек після
// прогону такий самий, як до нього» тримає цей механізм, а не дисципліна в
// промптах.
import { execFileSync } from "node:child_process"
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  statSync,
  statfsSync,
  unlinkSync,
  writeSync,
} from "node:fs"
import { join } from "node:path"
import pg from "pg"
import {
  STACK_ENV,
  postgresStack,
  stackIndex,
  stackPool,
} from "../../../../scripts/db-stack-index.mjs"
import {
  PROVIDER_EVENT_SOURCES,
  PROVIDER_IDENTITY_SOURCES,
  PROVIDER_LOGIN_ROLES,
  PROVIDER_OWNER_ROLES,
} from "simetra/model"
import {
  enterRun,
  GUARD_APPLICATION_NAME,
  isRunTag,
  newRunTag,
  runTagOf,
  SHADOW_PREFIX,
  shadowAgeMinutes,
  testDatabaseUrl,
  testSuperuserUrl,
  testUrlOverrideSet,
} from "./connection"
import {
  type Exec,
  type Fetch,
  nodeExec,
  runBuckets,
  runContainers,
} from "./external"
import { installInterruptCleanup } from "./interrupt"
import { provideSupabaseS3 } from "./s3"
import {
  enterProvider,
  PROVIDER_ENV,
  postgresStackAt,
  profileStack,
  stackEnvPrefix,
  type TestProvider,
} from "./profile"
import {
  assertStack,
  type ClientFactory,
  type GuardClient,
  openAdmin,
  stackDatabases,
  stackIndexMismatch,
  stopRunBackends,
} from "./sweep"

// Межа — з запасом над найдовшим повним прогоном (designer); чекати довше
// означає завислий прогін, і про нього краще дізнатися, ніж чекати безкінечно
const LOCK_WAIT_MS = 45 * 60_000
const LOCK_POLL_MS = 5_000
// Стек пулу, що не відповів за кілька секунд, не живий: чекати типових 30 с
// на кожного з дев'яти кандидатів означало б хвилини до першої помилки
const PROBE_TIMEOUT_MS = 3_000
// Замок щойно створений `wx`, а його вміст ще пишеться: порожній файл
// молодший за це вікно — зайнятий, а не покинутий
const LOCK_WRITE_GRACE_MS = 2_000
// Воротар зняття покинутого замка живе мілісекунди; старший — лишок убитого
const RECLAIM_GATE_STALE_MS = 10_000
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
  return join("/tmp", profileStack(p).lockFile)
}

/** The vitest globalSetup of a DB project that runs against the stack of `p`. */
export function setupFor(p: TestProvider): () => Promise<() => Promise<void>> {
  return () => setup(p)
}

async function setup(p: TestProvider): Promise<() => Promise<void>> {
  // До воркерів: env профілю успадковують і вони, і прибиральник на сигналі
  enterProvider(p)
  checkFreeSpace()
  // Індекс стека потрапляє в `process.env.SIMETRA_STACK` усередині
  // `takeStack`, до будь-чого, що обчислює адресу
  const { release: releaseLock } = await takeStack(p)
  let removeInterruptCleanup = (): void => {}
  try {
    // Форки воркерів, які vitest стартує після globalSetup, успадковують env:
    // тег в іменах об'єктів і в `application_name` кожного з'єднання прогону
    const runTag = newRunTag()
    enterRun(runTag)
    // Один `supabase status` на прогін: значення S3 успадковують воркери й
    // прибиральник на сигналі. Без них тест не створить бакета, тож краще
    // впасти тут, поки в стеку ще нічого нема
    if (p === "supabase") provideSupabaseS3()
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
          `DB run ${runTag} on ${p} stack${stackSuffix(profileStack(p).index)}${tree !== undefined ? ` at ${tree.summary}` : ""}\n`
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

/** Параметри вибору й захоплення стека; тест підставляє замки, живість і паузи. */
export interface PickOptions {
  /** Індекси кандидатів у порядку спроб. */
  candidates: readonly number[]
  provider: TestProvider
  /** Шлях замка кандидата; типово — з модуля індексу. */
  lockOf?: (index: number) => string
  /**
   * Перевірка, що стек кандидата живий і звітує свій індекс; без неї
   * (явний стек) кандидат береться, як є: помилку дасть `assertStack`.
   */
  live?: (index: number) => Promise<boolean>
  waitMs?: number
  pollMs?: number
}

/** Захоплений стек: індекс, шлях замка й звільнення саме цього замка. */
export interface TakenStack {
  index: number
  lock: string
  release: () => void
}

/**
 * Release of exactly the lock `lock` and only while this process still holds
 * it: a lock taken over by another run after our crash is not touched, and the
 * lock of another stack of the pool is never named here.
 */
export function lockReleaser(lock: string): () => void {
  return () => {
    if (readHolder(lock)?.pid === process.pid) removeLockFile(lock)
  }
}

/**
 * Chooses the stack of the run and takes its lock: explicit `SIMETRA_STACK` or
 * a `SIMETRA_TEST_*_URL` override means one stack, otherwise the pool. Puts the
 * index into `process.env.SIMETRA_STACK` at once, so that every address
 * computed after it, and every forked worker, points at this stack.
 */
export async function takeStack(
  p: TestProvider,
  o: Partial<PickOptions> = {}
): Promise<TakenStack> {
  let pick: PickOptions
  if (p === "supabase") {
    // Профіль без індексу й пулу; `profileStack` відмовить на змінних пулу
    pick = {
      candidates: [1],
      provider: p,
      lockOf: () => lockPath(p),
    }
  } else if (
    process.env[STACK_ENV] !== undefined ||
    testUrlOverrideSet(process.env)
  ) {
    // Адресу, задану вручну, сторож за пулом не вибере: стек — явний або перший
    pick = { candidates: [stackIndex(process.env)], provider: p }
  } else {
    pick = {
      candidates: stackPool(process.env),
      provider: p,
      live: (index) => probeStack(index),
    }
  }
  const taken = await acquireStack({ ...pick, ...o })
  if (p === "postgres") process.env[STACK_ENV] = String(taken.index)
  return taken
}

/**
 * Живий ли стек `index` пулу: вхід суперкористувачем у базу `postgres` з
 * короткою межею й збіг `simetra.stack_index` з індексом (порожнє — лише для
 * стека 1, ще не перебудованого). Недосяжний стек — не живий, не помилка.
 */
export async function probeStack(
  index: number,
  make: (config: pg.ClientConfig) => GuardClient = (c) => {
    // Обрив з'єднання після `connect` не має валити процес сторожа
    const client = new pg.Client(c)
    client.on("error", () => {})
    return client
  }
): Promise<boolean> {
  const target = new URL(postgresStackAt(index).superuserUrl)
  target.pathname = "/postgres"
  const client = make({
    connectionString: target.toString(),
    connectionTimeoutMillis: PROBE_TIMEOUT_MS,
    query_timeout: PROBE_TIMEOUT_MS,
    application_name: GUARD_APPLICATION_NAME,
  })
  try {
    await client.connect()
    const row = (
      await client.query<{ idx: string | null }>(
        "select pg_catalog.current_setting('simetra.stack_index', true) as idx"
      )
    ).rows[0]
    return stackIndexOk(index, row?.idx)
  } catch {
    return false
  } finally {
    await client.end().catch(() => undefined)
  }
}

function stackIndexOk(
  index: number,
  reported: string | null | undefined
): boolean {
  return stackIndexMismatch(index, reported) === null
}

/**
 * Takes the lock of the first free live candidate. The pick and the lock are
 * one step: `wx` creates the file only for one of the competitors, and a
 * candidate counts only when its lock is created. Live candidates that are all
 * busy are polled together until one frees; with no live candidate it throws.
 * Refuses a lock this process already holds.
 */
export async function acquireStack(o: PickOptions): Promise<TakenStack> {
  const lockOf = o.lockOf ?? ((index) => postgresStack(index).lockPath)
  const waitMs = o.waitMs ?? LOCK_WAIT_MS
  const pollMs = o.pollMs ?? LOCK_POLL_MS
  const deadline = Date.now() + waitMs
  const dead = new Set<number>()
  let announced = false
  for (;;) {
    const busy: { index: number; lock: string; holder: Holder }[] = []
    for (const index of o.candidates) {
      if (dead.has(index)) continue
      const lock = lockOf(index)
      const holder = tryCreateLock(lock)
      if (holder !== undefined) {
        busy.push({ index, lock, holder })
        continue
      }
      // Замок наш: живий стек лишає його, не живий — звільняє для інших
      if (o.live === undefined || (await alive(o.live, index, lock))) {
        return { index, lock, release: lockReleaser(lock) }
      }
      dead.add(index)
    }
    if (busy.length === 0) {
      throw new Error(
        `No live local ${o.provider} stack among the candidates ${o.candidates.join(", ")}: start one with ${o.candidates
          .map(
            (index) =>
              `${index === 1 ? "" : `${STACK_ENV}=${index} `}pnpm db:pg:start`
          )
          .join(" or ")}`
      )
    }
    const who = busy
      .map(
        ({ holder }) =>
          `DB run PID ${holder.pid} (${holder.cwd}, since ${holder.since})`
      )
      .join(", ")
    // Один живий кандидат (решта не живі): текст стека без пулу, для стека 1
    // такий самий, як до пулу
    const single = busy.length === 1
    const first = busy[0]!
    if (Date.now() > deadline)
      throw new Error(
        `The local ${o.provider} stack${single ? stackSuffix(first.index) : "s"} ${single ? "is" : "are"} still busy after ${waitMs / 60_000} min: ${who}. Lock file${single ? "" : "s"}: ${busy.map((b) => b.lock).join(", ")}`
      )
    if (!announced) {
      process.stderr.write(
        single
          ? `The local ${o.provider} stack${stackSuffix(first.index)} is busy: ${who}; waiting…\n`
          : `All live local ${o.provider} stacks (${busy.map((b) => b.index).join(", ")}) are busy: ${who}; waiting…\n`
      )
      announced = true
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
}

// Для стека 1 повідомлення лишається таким, яким воно було до пулу
function stackSuffix(index: number): string {
  return index === 1 ? "" : ` ${index}`
}

async function alive(
  live: (index: number) => Promise<boolean>,
  index: number,
  lock: string
): Promise<boolean> {
  let ok = false
  try {
    ok = await live(index)
  } finally {
    // Лише свій замок: і при помилці проби, і коли стек не живий
    if (!ok) lockReleaser(lock)()
  }
  return ok
}

interface Holder {
  pid: number
  cwd: string
  since: string
}

/**
 * Creates the lock file with `wx`; `undefined` — the lock is ours. Otherwise
 * the live holder: a lock of a dead process is taken over here, and a refusal
 * names the lock this very process already holds.
 */
function tryCreateLock(lock: string): Holder | undefined {
  for (;;) {
    try {
      const fd = openSync(lock, "wx")
      writeSync(
        fd,
        `${process.pid}\n${process.cwd()}\n${new Date().toISOString()}\n`
      )
      closeSync(fd)
      return undefined
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
    if (holder !== undefined && isAlive(holder.pid)) return holder
    // Файла вже нема (власник його звільнив між `wx` і читанням): нічого
    // знімати, а знімок «стале» чужий свіжий замок — саме та гонка, яку
    // виключає вибір під `wx`
    if (holder === undefined && !existsSync(lock)) continue
    // Без вмісту: або `wx` щойно створив файл і пише pid (тоді він зайнятий),
    // або файл покинутий
    if (holder === undefined && lockAgeMs(lock) < LOCK_WRITE_GRACE_MS)
      return { pid: 0, cwd: "?", since: "?" }
    // Убитий прогін лишає файл замка без живого процесу — замок не тримає
    // ніхто, і його можна забрати
    if (!reclaimStale(lock, holder?.pid))
      return { pid: 0, cwd: "?", since: "?" }
  }
}

// Знімає покинутий замок так, щоб не зняти чужий свіжий: двоє, що бачать той
// самий покинутий файл, інакше обоє зняли б його, а другий зняв би вже замок
// першого. Воротар `<замок>.reclaim` створюється `wx`, тож під ним знімає один;
// звільнити замок тим часом може лише власник, а покинутий власника не має.
// `false` — воротар зайнятий, спробу повторить наступне опитування
function reclaimStale(lock: string, stalePid: number | undefined): boolean {
  const gate = `${lock}.reclaim`
  try {
    closeSync(openSync(gate, "wx"))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    // Воротар покинутого знімальника: інакше замок не знявся б ніколи
    if (lockAgeMs(gate) > RECLAIM_GATE_STALE_MS) removeLockFile(gate)
    return false
  }
  try {
    const now = readHolder(lock)
    if (
      existsSync(lock) &&
      now?.pid === stalePid &&
      (stalePid !== undefined || lockAgeMs(lock) >= LOCK_WRITE_GRACE_MS)
    )
      removeLockFile(lock)
  } finally {
    removeLockFile(gate)
  }
  return true
}

function lockAgeMs(lock: string): number {
  try {
    return Date.now() - statSync(lock).mtimeMs
  } catch {
    // Файла вже нема: він не «щойно створений», наступна спроба `wx` вирішить
    return Number.POSITIVE_INFINITY
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
      `The run changed better_auth of database ${testsDatabase(p)} (fingerprint ${before.identity ?? "none"} → ${identity ?? "none"}): a test granted, altered or created something there outside a rollback. Restore it by hand; the start check of the next run names only owners, grants, default privileges, trigger state and column names that differ from the db:pg:start state, not other changes the fingerprint covers (column types, role settings).`
    )
  if (problems.length > 0) throw new Error(problems.join("\n"))
}

// Роль, якій `db:pg:start` віддає схему ідентичності (міграція Better Auth
// іде від неї, як у проді): перший логін профілю
const identityRoleOf = (p: TestProvider): string => PROVIDER_LOGIN_ROLES[p][0]!

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
    "select o.object, case a.grantee when 0 then 'PUBLIC' else pg_catalog.pg_get_userbyid(a.grantee)::text end as grantee, a.privilege_type::text as privilege, a.is_grantable::text as grantable from (select 'schema ' || n.nspname as object, n.nspacl as acl from pg_catalog.pg_namespace n where n.nspname = $1 union all select 'relation ' || c.relname, c.relacl from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace where n.nspname = $1) o cross join lateral pg_catalog.aclexplode(o.acl) a order by 1, 2, 3",
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
  coalesce((select pg_catalog.string_agg(d.defaclobjtype::text || ' ' || pg_catalog.pg_get_userbyid(d.defaclrole)::text || ' ' || d.defaclacl::text, ',' order by d.defaclobjtype, d.defaclrole) from pg_catalog.pg_default_acl d join pg_catalog.pg_namespace n on n.oid = d.defaclnamespace where n.nspname = $1), ''),
  coalesce((select pg_catalog.string_agg(s.setdatabase::text || ' ' || s.setconfig::text, ',' order by s.setdatabase) from pg_catalog.pg_db_role_setting s join pg_catalog.pg_roles r on r.oid = s.setrole where r.rolname = $2), '')
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
      {
        schema: table.schema,
        table: table.name,
        owner,
        identityRole: identityRoleOf(p),
      }
    )
    if (differences.length > 0)
      throw new Error(
        `better_auth of database ${database} is not in the db:pg:start state (${differences.join("; ")}): restore it by hand or rebuild the stack (stopping the stack is the owner's call)`
      )
    return await fingerprintIn(client, table, identityRoleOf(p))
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
 * — роль ідентичності; власник має лише `USAGE` на схему, `TRIGGER` і
 * `REFERENCES` на таблицю ідентичності (тригер провізії, ключ моделі), інших отримувачів немає; типових
 * привілеїв у схемі немає; тригери таблиці ідентичності ввімкнені.
 */
export function identityStateDifferences(
  facts: {
    owners: Record<string, string>[]
    grants: Record<string, string>[]
    defaultAcl: Record<string, string>[]
    triggers: Record<string, string>[]
  },
  o: { schema: string; table: string; owner: string; identityRole: string }
): string[] {
  const allowed = new Set([
    `schema ${o.schema} ${o.owner} USAGE`,
    `relation ${o.table} ${o.owner} TRIGGER`,
    `relation ${o.table} ${o.owner} REFERENCES`,
  ])
  return [
    ...facts.owners
      .filter((r) => r.owner !== o.identityRole)
      .map((r) => `${r.object} is owned by ${r.owner}`),
    ...facts.grants
      .filter(
        (g) =>
          g.grantee !== o.identityRole &&
          !allowed.has(`${g.object} ${g.grantee} ${g.privilege}`)
      )
      .map((g) => `${g.object} grants ${g.privilege} to ${g.grantee}`),
    // Дозволений грант з правом передачі розширив би коло отримувачів
    ...facts.grants
      .filter((g) => g.grantee !== o.identityRole && g.grantable === "true")
      .map(
        (g) =>
          `${g.object} grants ${g.privilege} to ${g.grantee} WITH GRANT OPTION`
      ),
    ...facts.defaultAcl.map(
      (d) =>
        `default privileges of ${d.role} for type ${d.type} in schema ${o.schema}`
    ),
    ...facts.triggers
      // `D` — вимкнений, `R` — спрацьовує лише в репліці: в обох тригер
      // провізії не діє в сесії тестів
      .filter((t) => t.enabled === "D" || t.enabled === "R")
      .map(
        (t) =>
          `trigger ${t.name} on ${o.table} is ${t.enabled === "D" ? "disabled" : "enabled only for replica sessions"}`
      ),
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
    return await fingerprintIn(client, table, identityRoleOf(p))
  } finally {
    await client.end()
  }
}

async function fingerprintIn(
  client: GuardClient,
  table: { schema: string },
  identityRole: string
): Promise<string> {
  const row = (
    await client.query<{ fingerprint: string }>(IDENTITY_SQL.fingerprint, [
      table.schema,
      identityRole,
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
  // Для Supabase — порожньо: його бакети додаються нижче з `storage.buckets`
  const buckets = (
    await runBuckets(profileStack(p), deps.fetch ?? fetch, LIST_TIMEOUT_MS)
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
        // Бакети Supabase — рядки `storage.buckets`; суперкористувач стека
        // читає їх без окремого гранту. Garage бачить `runBuckets` вище
        if (p === "supabase")
          for (const name of await names(
            client,
            "select name from storage.buckets where name like 'run-%' order by 1"
          ))
            if (isRunTag(name.slice("run-".length))) result.buckets.push(name)
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
        `    cd packages/simetra && ${stackEnvPrefix(profileStack(p))}${PROVIDER_ENV}=${p} node --import tsx test/db/sweep.ts ${tag}`,
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
  // Лишки стека N ≠ 1: без назви стека рядки `DROP DATABASE` нічим не
  // прив'язані до нього
  const stack = profileStack(p)
  if (lines.length > 0 && stack.index !== 1)
    lines.unshift(
      `Stack ${stack.key} (${STACK_ENV}=${stack.index}) — the objects below are on it:`
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
      const su = profileStack(p).superuserName
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
    // Прибиральник бакет прогону порожнить сам; рядок — для лишка, якого він
    // не зміг видалити
    if (kind === "buckets")
      return [
        `  bucket ${name}: empty and delete in ${p === "postgres" ? "Garage" : "Supabase Storage"}`,
      ]
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
