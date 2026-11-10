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
import { PROVIDER_OWNER_ROLES } from "simetra/model"
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
    process.stderr.write(
      `DB run ${runTag} on ${p} stack${tree !== undefined ? ` at ${tree.summary}` : ""}\n`
    )
    // Тег уже є, але воркерів ще нема: об'єктів цього прогону в знімку бути
    // не може, тож звіт називає лише чужі лишки
    const before = await startChecks(p)
    const leftovers = leftoverReport(before, p)
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

async function acquireLock(lock: string, p: TestProvider): Promise<void> {
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
}

/**
 * Перевірки старту прогону під замком і знімок «до»: стек профілю, роль
 * адреси тестів, потім знімок. Знімок і звірка чужого стека під своїм
 * замком не тримали б «один прогін за раз» ні для одного з двох, а знімок
 * адреси з іншою роллю — тієї моделі з'єднання, яку перевіряють тести.
 */
export async function startChecks(
  p: TestProvider,
  deps: GuardDeps = {}
): Promise<Snapshot> {
  await assertStack(p, deps)
  await assertTestRole(p, deps)
  return snapshot(p, deps)
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
 * Звірка кінця прогону: новий знімок проти знімка `before`; відмінність —
 * збій прогону з командами прибирання.
 */
export async function endChecks(
  p: TestProvider,
  before: Snapshot,
  deps: GuardDeps = {}
): Promise<void> {
  const leaks = diff(before, await snapshot(p, deps))
  if (leaks.length > 0) throw new Error(leakMessage(leaks, p))
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
