// Старт і зупинка локального стека профілю `postgres` (compose-проєкт
// `simetra-pg`). Compose і ініціалізація йдуть під тим самим замком, що й
// DB-прогін (`packages/simetra/test/db/stack-guard.ts`): інакше `stop` міг би
// зупинити стек посеред прогону, а прогін — стартувати на напівготовому стеку.
// Без залежностей, крім `start postgres`: він кличе `simetra roles` і міграцію
// Better Auth, тож потребує `pnpm install`.
//
//   node scripts/db-stack.mjs start postgres [--no-build]
//   node scripts/db-stack.mjs stop postgres [--volumes]
//   node scripts/db-stack.mjs files-hash postgres
//   node scripts/db-stack.mjs start supabase-signals
//   node scripts/db-stack.mjs stop supabase-signals
import { spawn } from "node:child_process"
import { EventEmitter } from "node:events"
import {
  createHash,
  createHmac,
  pbkdf2Sync,
  timingSafeEqual,
} from "node:crypto"
import {
  closeSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from "node:fs"
import { constants } from "node:os"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
/** Lock file name of the postgres stack; equals `TEST_STACKS.postgres.lockFile` (asserted by a unit test). */
export const POSTGRES_LOCK_FILE = "simetra-db-stack-postgres.lock"
// Фіксований `/tmp`, не `tmpdir()`: сесії з різним TMPDIR інакше брали б різні
// файли замка одного спільного стека; guard бере той самий шлях
export const POSTGRES_LOCK_PATH = join("/tmp", POSTGRES_LOCK_FILE)
/** Env variable that names the held stack lock to the children of the script. */
export const STACK_LOCK_ENV = "SIMETRA_DB_STACK_LOCK"

// Профілі скрипта як дані. `lock` — замок, той самий, що бере DB-прогін. `supabase-signals` без
// замка: DB-прогін його не вживає (стек Supabase має власний замок guard-а), а
// кроку ініціалізації, що мусив би йти під замком, у нього немає.
const PROFILES = {
  postgres: {
    dir: join(ROOT, "docker/postgres-stack"),
    project: "simetra-pg",
    lock: POSTGRES_LOCK_PATH,
  },
  "supabase-signals": {
    dir: join(ROOT, "docker/supabase-signals"),
    project: "simetra-sb",
    lock: undefined,
  },
}
const BUCKET = "simetra-dev"
// Бекенди кроків старту мають це ім'я, тож їх можна знайти й завершити до
// зняття замка: запит, кинутий убитим дочірнім процесом, сервер виконує й далі
const START_APP_NAME = "simetra_db_start"
// Дочірній, що не завершився за цей час після пересланого сигналу, і вся його
// група дістають SIGKILL: замок не має висіти без кінця
const KILL_AFTER_MS = 30_000
/** @type {readonly NodeJS.Signals[]} */
const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"]

/**
 * Runs `fn` while holding the stack lock at `path` — the same lock the DB-run
 * guard takes. A lock of a live process refuses at once (the caller is a
 * command, not a run that may wait); a lock of a dead process is taken over.
 * While `fn` runs, `STACK_LOCK_ENV` names the lock to child processes.
 *
 * @param {string} path
 * @param {() => Promise<void>} fn
 * @returns {Promise<void>}
 */
export async function withStackLock(path, fn) {
  for (;;) {
    try {
      const fd = openSync(path, "wx")
      writeSync(
        fd,
        `${process.pid}\n${process.cwd()}\n${new Date().toISOString()}\n`
      )
      closeSync(fd)
      break
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== "EEXIST")
        throw error
    }
    const holder = readHolder(path)
    if (holder !== undefined && isAlive(holder.pid))
      throw new Error(
        `postgres stack is in use by PID ${holder.pid} (${holder.cwd}, since ${holder.since}). Lock file: ${path}`
      )
    // Убитий процес лишає файл замка без власника — його можна забрати, як і guard
    removeLockFile(path)
  }
  process.env[STACK_LOCK_ENV] = path
  try {
    await fn()
  } finally {
    delete process.env[STACK_LOCK_ENV]
    // Лише свій замок: чужий, узятий після нашого падіння, не чіпаємо
    if (readHolder(path)?.pid === process.pid) removeLockFile(path)
  }
}

/**
 * @param {string} path
 * @returns {{ pid: number, cwd: string, since: string } | undefined}
 */
function readHolder(path) {
  try {
    const [pid, cwd = "?", since = "?"] = readFileSync(path, "utf8").split("\n")
    const parsed = Number(pid)
    return Number.isInteger(parsed) && parsed > 0
      ? { pid: parsed, cwd, since }
      : undefined
  } catch {
    return undefined
  }
}

/** @param {number} pid */
function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM — процес є, але чужого користувача
    return /** @type {NodeJS.ErrnoException} */ (error).code === "EPERM"
  }
}

/** @param {string} path */
function removeLockFile(path) {
  try {
    unlinkSync(path)
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT")
      throw error
  }
}

/** @typedef {Pick<NodeJS.EventEmitter, "on" | "off">} SignalSource */

/**
 * @typedef {object} ChildOptions
 * @property {string} [cwd]
 * @property {NodeJS.ProcessEnv} [env] повне середовище дочірнього процесу
 * @property {string} [input] stdin; без нього stdin закрито
 * @property {(chunk: string) => void} [onStdout] stdout у трубу замість термінала
 * @property {SignalSource} [signals] джерело сигналів скрипту; типово `process`
 * @property {number} [killAfterMs]
 */

// EPERM на групі дочірнього — у ній процес, якому скрипт не може слати
// сигнали (інший користувач, setuid): чекати на нього марно, тож групу
// вважаємо завершеною й попереджаємо. Кидати не можна: виклики йдуть зі
// слухача сигналу й таймера, і виняток там був би неперехопленим
/** @param {number} pid @param {unknown} error */
function warnGroup(pid, error) {
  process.stderr.write(
    `db-stack: cannot signal process group ${pid} (${/** @type {NodeJS.ErrnoException} */ (error).code ?? String(error)}); not waiting for it\n`
  )
}

/** @param {number | undefined} pid @param {NodeJS.Signals} signal */
function killGroup(pid, signal) {
  if (pid === undefined) return
  try {
    process.kill(-pid, signal)
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ESRCH")
      warnGroup(pid, error)
  }
}

/** @param {number | undefined} pid */
function groupAlive(pid) {
  if (pid === undefined) return false
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ESRCH")
      warnGroup(pid, error)
    return false
  }
}

/**
 * Runs a child process in its own process group and resolves with its exit
 * code (128 + signal number when a signal ended it). A signal of the script is
 * forwarded to the child's group once; a group still alive `killAfterMs` later
 * gets SIGKILL. The promise settles only after the child exits and, once a
 * signal was forwarded, after its whole group is gone, so a caller under the
 * stack lock keeps the lock until then.
 *
 * @param {string} command
 * @param {readonly string[]} args
 * @param {ChildOptions} [opts]
 * @param {typeof spawn} [spawnFn]
 * @returns {Promise<number>}
 */
export function runChild(command, args, opts = {}, spawnFn = spawn) {
  const signals = opts.signals ?? process
  const killAfterMs = opts.killAfterMs ?? KILL_AFTER_MS
  return new Promise((resolve, reject) => {
    // Своя група: Ctrl-C термінала дістається лише скрипту, а він пересилає
    // сигнал усій групі — і `docker compose`, і його нащадкам, — не лише pid
    const child = spawnFn(command, [...args], {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      detached: true,
      // Процес фонової групи, що читає термінал, зупинив би SIGTTIN: stdin
      // або труба, або закритий
      stdio: [
        opts.input === undefined ? "ignore" : "pipe",
        opts.onStdout === undefined ? "inherit" : "pipe",
        "inherit",
      ],
    })
    let forwarded = false
    /** @type {NodeJS.Timeout | undefined} */
    let killTimer
    const onSignal = (/** @type {NodeJS.Signals} */ signal) => {
      if (forwarded) return
      forwarded = true
      killGroup(child.pid, signal)
      killTimer = setTimeout(() => killGroup(child.pid, "SIGKILL"), killAfterMs)
    }
    for (const s of FORWARDED_SIGNALS) signals.on(s, onSignal)
    const settle = () => {
      clearTimeout(killTimer)
      for (const s of FORWARDED_SIGNALS) signals.off(s, onSignal)
    }
    child.once("error", (error) => {
      settle()
      reject(new Error(`${command} failed: ${error.message}`))
    })
    child.once("close", (code, signal) => {
      const result =
        code ?? 128 + (signal === null ? 0 : constants.signals[signal])
      // Після сигналу нащадок групи (`docker compose` → плагін) може пережити
      // прямий дочірній: замок тримаємо, доки група не порожня, і межа SIGKILL
      // лишається зведеною до того
      const finish = () => {
        if (forwarded && groupAlive(child.pid)) setTimeout(finish, 50)
        else {
          settle()
          resolve(result)
        }
      }
      finish()
    })
    if (opts.onStdout !== undefined)
      child.stdout?.setEncoding("utf8").on("data", opts.onStdout)
    if (opts.input !== undefined) {
      // Дочірній, що вийшов, не дочитавши, дає EPIPE — код виходу скаже більше
      child.stdin?.on("error", () => {})
      child.stdin?.end(opts.input)
    }
  })
}

/**
 * Контекст однієї команди скрипту: шов `spawn`, джерело сигналів і перший
 * сигнал, що прийшов, — після нього наступні кроки не стартують.
 *
 * @typedef {object} Ctx
 * @property {typeof spawn} spawnFn
 * @property {SignalSource} signals
 * @property {NodeJS.Signals | undefined} interrupted
 * @property {number} [cleanupTimeoutMs]
 */

/**
 * @param {typeof spawn} spawnFn
 * @param {SignalSource} signals
 * @returns {{ ctx: Ctx, release: () => void }}
 */
function commandContext(spawnFn, signals) {
  /** @type {Ctx} */
  const ctx = { spawnFn, signals, interrupted: undefined }
  // Слухач і для того, щоб сигнал між кроками не вбив скрипт до зняття замка
  const record = (/** @type {NodeJS.Signals} */ signal) => {
    ctx.interrupted ??= signal
  }
  for (const s of FORWARDED_SIGNALS) signals.on(s, record)
  return {
    ctx,
    release: () => {
      for (const s of FORWARDED_SIGNALS) signals.off(s, record)
    },
  }
}

/**
 * `runChild` з контекстом команди: кидає на ненульовому коді й на перерваній
 * команді, тож наступний крок не стартує.
 *
 * @param {Ctx} ctx
 * @param {string} command
 * @param {readonly string[]} args
 * @param {ChildOptions} [opts]
 */
async function runChecked(ctx, command, args, opts = {}) {
  if (ctx.interrupted !== undefined)
    throw new Error(`interrupted by ${ctx.interrupted}`)
  const code = await runChild(
    command,
    args,
    { ...opts, signals: ctx.signals },
    ctx.spawnFn
  )
  if (ctx.interrupted !== undefined)
    throw new Error(`interrupted by ${ctx.interrupted}`)
  if (code !== 0) throw new Error(`${command} ${args[0]} exited with ${code}`)
}

/**
 * `docker compose` лише з явним проєктом і файлом стека: без них compose
 * узяв би проєкт за іменем теки й міг би зачепити чужі контейнери.
 *
 * @param {{ dir: string, project: string }} profile
 * @param {string[]} args
 */
const composeArgv = (profile, args) => [
  "compose",
  "-p",
  profile.project,
  "-f",
  join(profile.dir, "compose.yaml"),
  ...args,
]

// Хеш файлів стека — у середовищі кожного виклику compose: він підставляє його
// в аргумент збірки, і `config` бачить той самий файл, що й `up`
const composeEnv = () => ({
  ...process.env,
  SIMETRA_STACK_FILES_HASH: stackFilesHash(),
})

/**
 * @param {Ctx} ctx
 * @param {{ dir: string, project: string }} profile
 * @param {string[]} args
 * @param {{ input?: string, capture?: boolean }} [options]
 * @returns {Promise<string>}
 */
async function compose(ctx, profile, args, options = {}) {
  let stdout = ""
  await runChecked(ctx, "docker", composeArgv(profile, args), {
    env: composeEnv(),
    input: options.input,
    onStdout:
      options.capture === true
        ? (chunk) => {
            stdout += chunk
          }
        : undefined,
  })
  return stdout
}

/**
 * sha256 of the files of `docker/postgres-stack/**` (relative paths and
 * contents), so the same files give the same hash in every checkout. Every
 * container of the stack carries it as the label `simetra.stack-files-hash`.
 *
 * @param {string} [dir] the stack directory; a test passes a copy
 * @returns {string}
 */
export function stackFilesHash(dir = PROFILES.postgres.dir) {
  /** @param {string} at @returns {string[]} */
  const walk = (at) =>
    readdirSync(at, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? walk(join(at, entry.name))
        : [relative(dir, join(at, entry.name))]
    )
  const hash = createHash("sha256")
  for (const file of walk(dir).sort()) {
    hash.update(`${file}\0`)
    hash.update(readFileSync(join(dir, file)))
    hash.update("\0")
  }
  return hash.digest("hex")
}

const STACK_FILES_LABEL = "simetra.stack-files-hash"

/** Codes of the refusals of `start postgres` on a running stack. */
export const STACK_REFUSAL = {
  /** A container has no `simetra.stack-files-hash`: built before the label. */
  unlabelled: "STACK_UNLABELLED",
  /** A container is missing, or its label differs from this branch. */
  differs: "STACK_DIFFERS",
}

/** @param {string} code @param {string} message */
const refusal = (code, message) => Object.assign(new Error(message), { code })
const SERVICE_LABEL = "com.docker.compose.service"

/**
 * Мітки контейнерів проєкту за сервісом; порожньо — стека немає.
 *
 * @param {Ctx} ctx
 * @returns {Promise<Map<string, Record<string, string>>>}
 */
async function stackContainers(ctx) {
  const ids = (
    await compose(ctx, PROFILES.postgres, ["ps", "--all", "--quiet"], {
      capture: true,
    })
  )
    .split("\n")
    .map((id) => id.trim())
    .filter((id) => id !== "")
  /** @type {Map<string, Record<string, string>>} */
  const byService = new Map()
  if (ids.length === 0) return byService
  let out = ""
  await runChecked(ctx, "docker", ["inspect", ...ids], {
    onStdout: (chunk) => {
      out += chunk
    },
  })
  for (const container of JSON.parse(out)) {
    const labels = container.Config?.Labels ?? {}
    byService.set(labels[SERVICE_LABEL], labels)
  }
  return byService
}

/**
 * Запущений стек лишається, лише якщо зібраний з тих самих файлів: `up`
 * інакше перестворив би контейнери спільного стека під чужими прогонами.
 * Хеш конфігу compose не годиться: він містить абсолютний шлях bind-монтувань,
 * тож ті самі файли з іншого checkout-а дали б інший хеш.
 *
 * @param {Ctx} ctx
 * @param {Map<string, Record<string, string>>} containers
 */
async function assertSameStack(ctx, containers) {
  const services = (
    await compose(ctx, PROFILES.postgres, ["config", "--services"], {
      capture: true,
    })
  )
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
  const expected = stackFilesHash()
  /** @type {string[]} */
  const differences = []
  /** @type {string[]} */
  const unlabelled = []
  if (services.length === 0) differences.push("compose printed no services")
  for (const service of services) {
    const labels = containers.get(service)
    const label = labels?.[STACK_FILES_LABEL]
    if (labels === undefined) differences.push(`${service}: no container`)
    // Порожнє значення — контейнер, створений compose без скрипту старту
    else if (label === undefined || label === "") unlabelled.push(service)
    else if (label !== expected)
      differences.push(`${service}: ${STACK_FILES_LABEL}`)
  }
  // Стек без мітки походить з версії скрипту до неї: звірити нічого, лише
  // перебудувати, і що саме виконати — відомо
  if (unlabelled.length > 0)
    throw refusal(
      STACK_REFUSAL.unlabelled,
      `the stack was built before the ${STACK_FILES_LABEL} label (${unlabelled.join(", ")}); rebuild it: node scripts/db-stack.mjs stop postgres --volumes, then pnpm db:pg:start (this deletes the stack's data)`
    )
  if (differences.length > 0)
    throw refusal(
      STACK_REFUSAL.differs,
      `stack config differs from this branch (${differences.join(", ")}); stopping the stack is the owner's call`
    )
}

/**
 * @param {string} file ім'я .env-файла в теці стека
 * @param {string[]} required обов'язкові змінні
 * @returns {Record<string, string>}
 */
function readEnvFile(file, required) {
  /** @type {Record<string, string>} */
  const secrets = {}
  const text = readFileSync(join(PROFILES.postgres.dir, file), "utf8")
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line)
    if (m !== null) secrets[m[1]] = m[2].trim()
  }
  for (const name of required)
    if (!secrets[name]) throw new Error(`${name} is not set in ${file}`)
  return secrets
}

/** Секрети Garage: їх читає і compose (`env_file`), тож паролів ролей тут нема. */
const devSecrets = () =>
  readEnvFile("dev-secrets.env", ["GARAGE_DEV_KEY_ID", "GARAGE_DEV_KEY_SECRET"])

/**
 * @param {Ctx} ctx
 * @param {string[]} args
 */
const garage = (ctx, args) =>
  // Журнал з'єднань CLI на кожен виклик лише засмічує вивід старту
  compose(
    ctx,
    PROFILES.postgres,
    ["exec", "-T", "-e", "RUST_LOG=garage=warn", "garage", "/garage", ...args],
    { capture: true }
  )

/**
 * Адмінський виклик через CLI: структурована відповідь замість розбору
 * таблиць `garage status`, формат яких не є контрактом.
 *
 * @param {Ctx} ctx
 * @param {string} endpoint
 * @param {unknown} [payload]
 */
const garageApi = async (ctx, endpoint, payload) =>
  JSON.parse(
    await garage(
      ctx,
      payload === undefined
        ? ["json-api", endpoint]
        : ["json-api", endpoint, JSON.stringify(payload)]
    )
  )

// Кожен крок спершу дивиться на стан: повторний `db:pg:start` на запущеному
// стеку нічого не змінює
/** @param {Ctx} ctx */
async function initGarage(ctx) {
  const secrets = devSecrets()
  const keyId = secrets.GARAGE_DEV_KEY_ID
  const status = await garageApi(ctx, "GetClusterStatus")
  const node = status.nodes[0]
  if (node === undefined) throw new Error("Garage reports no nodes")
  if (node.role === null || node.role === undefined) {
    await garage(ctx, ["layout", "assign", "-z", "dc1", "-c", "1G", node.id])
    const layout = await garageApi(ctx, "GetClusterLayout")
    await garage(ctx, [
      "layout",
      "apply",
      "--version",
      String(layout.version + 1),
    ])
  }
  const keys = await garageApi(ctx, "ListKeys")
  if (!keys.some((/** @type {{ id: string }} */ k) => k.id === keyId))
    await garage(ctx, [
      "key",
      "import",
      "--yes",
      "-n",
      BUCKET,
      keyId,
      secrets.GARAGE_DEV_KEY_SECRET,
    ])
  const buckets = await garageApi(ctx, "ListBuckets")
  if (
    !buckets.some((/** @type {{ globalAliases: string[] }} */ b) =>
      b.globalAliases.includes(BUCKET)
    )
  )
    await garage(ctx, ["bucket", "create", BUCKET])
  const bucket = await garageApi(ctx, "GetBucketInfo", { globalAlias: BUCKET })
  const grant = bucket.keys.find(
    (/** @type {{ accessKeyId: string }} */ k) => k.accessKeyId === keyId
  )?.permissions
  if (grant?.read !== true || grant?.write !== true || grant?.owner !== true)
    await garage(ctx, [
      "bucket",
      "allow",
      "--read",
      "--write",
      "--owner",
      BUCKET,
      "--key",
      keyId,
    ])
}

// Адреса стека для кроків після `compose up`: порт і пароль суперкористувача
// — з compose.yaml; база `simetra` — база застосунку стека (спека профілю §3.1)
const STACK_HOST = "127.0.0.1:54422"
const STACK_DATABASE = "simetra"

/** @param {string} user @param {string} password */
const stackUrl = (user, password) =>
  `postgresql://${user}:${password}@${STACK_HOST}/${STACK_DATABASE}`

// Ролі входу Simetra й змінні їхніх dev-паролів. Імена — ті самі, що дають
// `PROVIDER_OWNER_ROLES`, `PROVIDER_LOGIN_ROLES` і `PLATFORM_LOGIN_ROLES`;
// збіг тримає unit-тест
const LOGIN_ROLES = [
  { role: "simetra_owner", secret: "SIMETRA_OWNER_DEV_PASSWORD" },
  { role: "simetra_runtime", secret: "SIMETRA_RUNTIME_DEV_PASSWORD" },
  { role: "simetra_auth", secret: "SIMETRA_AUTH_DEV_PASSWORD" },
]

/** Пароль у `\set` без екранування: лише безпечні символи, інакше SQL зламався б. */
const SAFE_PASSWORD = /^[A-Za-z0-9._-]+$/

/**
 * Аргументи `docker compose exec … psql`: пароль ніколи не тут (він іде у
 * stdin). `exec` не передає середовища хоста, тож ім'я сесії — через `-e`.
 *
 * @param {string[]} extra
 */
const psqlArgs = (...extra) => [
  "exec",
  "-T",
  "-e",
  `PGAPPNAME=${START_APP_NAME}`,
  "postgres",
  "psql",
  "-v",
  "ON_ERROR_STOP=1",
  "-U",
  "postgres",
  "-d",
  "postgres",
  ...extra,
  "-f",
  "-",
]

/** Аргументи `docker compose exec … psql`: пароль ніколи не тут (він іде у stdin). */
export const POSTGRES_PSQL_ARGS = psqlArgs()

/**
 * StoredKey and ServerKey of a SCRAM-SHA-256 verifier (RFC 5802, RFC 7677),
 * base64. The password goes in as is: the stack's passwords are ASCII from
 * `SAFE_PASSWORD`, where SASLprep changes nothing.
 *
 * @param {string} password
 * @param {string} salt base64
 * @param {number} iterations
 * @returns {{ storedKey: string, serverKey: string }}
 */
export function scramKeys(password, salt, iterations) {
  const salted = pbkdf2Sync(
    password,
    Buffer.from(salt, "base64"),
    iterations,
    32,
    "sha256"
  )
  const hmac = (/** @type {string} */ msg) =>
    createHmac("sha256", salted).update(msg).digest()
  return {
    storedKey: createHash("sha256").update(hmac("Client Key")).digest("base64"),
    serverKey: hmac("Server Key").toString("base64"),
  }
}

/**
 * Whether a `pg_authid.rolpassword` value is a SCRAM verifier of `password`.
 * The verifier is salted, so SQL cannot compare it; the keys are derived again
 * with its salt and iteration count.
 *
 * @param {string} verifier
 * @param {string} password
 * @returns {boolean}
 */
export function passwordMatches(verifier, password) {
  const m = /^SCRAM-SHA-256\$(\d+):([^$]+)\$([^:]+):(.+)$/.exec(verifier)
  if (m === null) return false
  const keys = scramKeys(password, m[2], Number(m[1]))
  const same = (/** @type {string} */ a, /** @type {string} */ b) => {
    const x = Buffer.from(a)
    const y = Buffer.from(b)
    return x.length === y.length && timingSafeEqual(x, y)
  }
  return same(keys.storedKey, m[3]) && same(keys.serverKey, m[4])
}

/**
 * Команда кроку Better Auth: DSN лише в середовищі дочірнього процесу, не в argv.
 *
 * @param {Record<string, string>} secrets
 * @param {string} superuserUrl
 */
export function betterAuthCommand(secrets, superuserUrl) {
  return {
    args: [
      "--import",
      "tsx",
      join(ROOT, "packages/simetra/test/db/better-auth-cli.ts"),
    ],
    env: {
      SIMETRA_SUPERUSER_URL: superuserUrl,
      SIMETRA_AUTH_URL: stackUrl(
        "simetra_auth",
        secrets.SIMETRA_AUTH_DEV_PASSWORD
      ),
    },
  }
}

/**
 * Starts the postgres stack, or re-runs the init steps on a running stack of
 * the same files without recreating its containers. The caller holds the lock.
 *
 * @param {{ spawnFn?: typeof spawn, signals?: SignalSource, noBuild?: boolean, cleanupTimeoutMs?: number }} [options]
 * @returns {Promise<void>}
 */
export async function startPostgres(options = {}) {
  const { ctx, release } = commandContext(
    options.spawnFn ?? spawn,
    options.signals ?? process
  )
  ctx.cleanupTimeoutMs = options.cleanupTimeoutMs
  try {
    await startPostgresSteps(ctx, options.noBuild === true)
  } finally {
    release()
  }
}

/** @param {Ctx} ctx @param {boolean} noBuild */
async function startPostgresSteps(ctx, noBuild) {
  const profile = PROFILES.postgres
  const containers = await stackContainers(ctx)
  // На наявному стеку без `--build`: збірка перезаписала б спільний тег
  // образу з файлів цієї гілки, навіть коли контейнер лишається
  if (containers.size > 0) {
    await assertSameStack(ctx, containers)
    await compose(ctx, profile, ["up", "-d", "--wait", "--no-recreate"])
  } else
    await compose(ctx, profile, [
      "up",
      "-d",
      "--wait",
      ...(noBuild ? [] : ["--build"]),
    ])
  try {
    await initGarage(ctx)
    const psql = (
      /** @type {string} */ input,
      /** @type {string[]} */ ...extra
    ) => compose(ctx, profile, psqlArgs(...extra), { input, capture: true })
    await psql(readFileSync(join(profile.dir, "dev-environment.sql"), "utf8"))
    const secrets = readEnvFile(
      "login-secrets.env",
      LOGIN_ROLES.map((r) => r.secret)
    )
    for (const { secret } of LOGIN_ROLES)
      if (!SAFE_PASSWORD.test(secrets[secret]))
        throw new Error(
          `${secret} in login-secrets.env has unsupported characters`
        )
    const superuserUrl = stackUrl("postgres", "postgres")
    const node = (
      /** @type {string[]} */ args,
      /** @type {Record<string, string>} */ env,
      cwd = ROOT
    ) =>
      runChecked(ctx, process.execPath, args, {
        cwd,
        env: { ...process.env, ...env, PGAPPNAME: START_APP_NAME },
      })
    await node(
      [
        join(ROOT, "packages/designer/bin/simetra.mjs"),
        "roles",
        join(profile.dir, "project"),
      ],
      { SIMETRA_DATABASE_URL: superuserUrl }
    )
    // Пароль ставиться лише там, де відрізняється: ALTER з тим самим паролем
    // знову солить верифікатор, а повторний старт не має змінювати нічого
    const current = new Map(
      (
        await psql(
          `SELECT rolname, coalesce(rolpassword, '') FROM pg_catalog.pg_authid WHERE rolname IN (${LOGIN_ROLES.map((r) => `'${r.role}'`).join(", ")});\n`,
          "-A",
          "-t"
        )
      )
        .split("\n")
        .filter((line) => line.includes("|"))
        .map((line) => {
          const at = line.indexOf("|")
          return [line.slice(0, at), line.slice(at + 1).trim()]
        })
    )
    const stale = LOGIN_ROLES.filter(
      ({ role, secret }) =>
        !passwordMatches(current.get(role) ?? "", secrets[secret])
    )
    // Пароль іде у stdin `psql` (`\set` + `:'pw'`), а не в `-v`: argv видно в `ps`
    if (stale.length > 0)
      await psql(
        stale
          .map(
            ({ role, secret }, i) =>
              `\\set pw${i} '${secrets[secret]}'\nALTER ROLE ${role} PASSWORD :'pw${i}';\n`
          )
          .join("")
      )
    const step = betterAuthCommand(secrets, superuserUrl)
    // `tsx` — залежність пакета simetra, не кореня: звідти її й резолвить `--import`
    await node(step.args, step.env, join(ROOT, "packages/simetra"))
  } finally {
    await stopStartBackends(ctx)
  }
}

// Прибирання бекендів не чує сигналів скрипту (другий Ctrl-C інакше вбив би
// саме його), тож має власну межу: завислий psql не тримає замок довше
const CLEANUP_TIMEOUT_MS = 15_000
const CLEANUP_KILL_AFTER_MS = 2_000

/**
 * Бекенди кроків старту завершує суперкористувач до зняття замка, і після
 * сигналу теж; збій лише попереджає — первинна помилка старту важливіша.
 *
 * @param {Ctx} ctx
 */
async function stopStartBackends(ctx) {
  // Джерело «сигналів» лише для власної межі часу
  const deadline = new EventEmitter()
  const timer = setTimeout(
    () => deadline.emit("SIGTERM", "SIGTERM"),
    ctx.cleanupTimeoutMs ?? CLEANUP_TIMEOUT_MS
  )
  const code = await runChild(
    "docker",
    composeArgv(PROFILES.postgres, psqlArgs("-q")),
    {
      env: composeEnv(),
      input: `SELECT pg_catalog.pg_terminate_backend(pid) FROM pg_catalog.pg_stat_activity WHERE application_name = '${START_APP_NAME}' AND pid <> pg_catalog.pg_backend_pid();\n`,
      onStdout: () => {},
      signals: deadline,
      killAfterMs: CLEANUP_KILL_AFTER_MS,
    },
    ctx.spawnFn
  )
    .catch(() => -1)
    .finally(() => clearTimeout(timer))
  if (code !== 0)
    process.stderr.write(
      `db-stack: could not stop the backends of ${START_APP_NAME} (exit ${code}); they may still load the stack\n`
    )
}

/** @param {Ctx} ctx */
async function startSignals(ctx) {
  await compose(ctx, PROFILES["supabase-signals"], ["up", "-d", "--wait"])
}

/**
 * @param {Ctx} ctx
 * @param {keyof typeof PROFILES} profile
 * @param {boolean} volumes
 */
async function stop(ctx, profile, volumes) {
  await compose(
    ctx,
    PROFILES[profile],
    volumes ? ["down", "--volumes"] : ["down"]
  )
}

/** @param {string[]} argv */
async function main(argv) {
  const [command, profile, ...flags] = argv
  const usage =
    "usage: node scripts/db-stack.mjs start postgres [--no-build] | stop postgres [--volumes] | files-hash postgres | start supabase-signals | stop supabase-signals"
  if (
    (profile !== "postgres" && profile !== "supabase-signals") ||
    (command !== "start" && command !== "stop" && command !== "files-hash") ||
    (command === "files-hash" && profile !== "postgres")
  )
    throw new Error(usage)
  // Тома є лише в стеку `postgres`: Centrifugo нічого не зберігає; `--no-build`
  // — для CI, де образ зібрано заздалегідь із кешем
  /** @type {Record<string, string[]>} */
  const flagsOf = { stop: ["--volumes"], start: ["--no-build"] }
  const allowed = profile === "postgres" ? (flagsOf[command] ?? []) : []
  const unknown = flags.filter((f) => !allowed.includes(f))
  if (unknown.length > 0)
    throw new Error(`unknown flag ${unknown[0]}; ${usage}`)
  if (command === "files-hash") {
    process.stdout.write(`${stackFilesHash()}\n`)
    return
  }
  // Сигнал під час команди не вбиває скрипт одразу: його дістає дочірня
  // група, а замок знімається вже після її виходу
  const { ctx, release } = commandContext(spawn, process)
  const run = () =>
    command === "stop"
      ? stop(ctx, profile, flags.includes("--volumes"))
      : profile === "postgres"
        ? startPostgres({ noBuild: flags.includes("--no-build") })
        : startSignals(ctx)
  const { lock } = PROFILES[profile]
  try {
    await (lock === undefined ? run() : withStackLock(lock, run))
  } finally {
    release()
  }
}

// Лише як команда: тест імпортує `withStackLock`, і CLI тоді не запускається
/** @returns {boolean} */
function invokedAsCommand() {
  const invoked = process.argv[1]
  if (invoked === undefined) return false
  try {
    return (
      realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url))
    )
  } catch {
    // argv[1] — не файл (REPL, `node -e`, шлях, якого вже нема): не команда
    return false
  }
}
if (invokedAsCommand()) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(
      `db-stack: ${error instanceof Error ? error.message : String(error)}`
    )
    process.exit(1)
  })
}
