// Старт і зупинка локального стека профілю `postgres` (compose-проєкт
// `simetra-pg`). Compose і ініціалізація йдуть під тим самим замком, що й
// DB-прогін (`packages/simetra/test/db/stack-guard.ts`): інакше `stop` міг би
// зупинити стек посеред прогону, а прогін — стартувати на напівготовому стеку.
// Без залежностей, крім `start postgres`: він кличе `simetra roles` і міграцію
// Better Auth, тож потребує `pnpm install`.
//
//   node scripts/db-stack.mjs start postgres
//   node scripts/db-stack.mjs stop postgres [--volumes]
//   node scripts/db-stack.mjs start supabase-signals
//   node scripts/db-stack.mjs stop supabase-signals
import { spawnSync } from "node:child_process"
import {
  closeSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
/** Lock file name of the postgres stack; equals `TEST_STACKS.postgres.lockFile` (asserted by a unit test). */
export const POSTGRES_LOCK_FILE = "simetra-db-stack-postgres.lock"

// Профілі скрипта як дані. `lock` — замок, той самий, що бере DB-прогін. `supabase-signals` без
// замка: DB-прогін його не вживає (стек Supabase має власний замок guard-а), а
// кроку ініціалізації, що мусив би йти під замком, у нього немає.
const PROFILES = {
  postgres: {
    dir: join(ROOT, "docker/postgres-stack"),
    project: "simetra-pg",
    lock: join(tmpdir(), POSTGRES_LOCK_FILE),
  },
  "supabase-signals": {
    dir: join(ROOT, "docker/supabase-signals"),
    project: "simetra-sb",
    lock: undefined,
  },
}
const STACK_DIR = PROFILES.postgres.dir
const BUCKET = "simetra-dev"

/**
 * Runs `fn` while holding the stack lock at `path` — the same lock the DB-run
 * guard takes. A lock of a live process refuses at once (the caller is a
 * command, not a run that may wait); a lock of a dead process is taken over.
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
  try {
    await fn()
  } finally {
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

/**
 * `docker compose` лише з явним проєктом і файлом стека: без них compose
 * узяв би проєкт за іменем теки й міг би зачепити чужі контейнери.
 *
 * @param {{ dir: string, project: string }} profile
 * @param {string[]} args
 * @param {{ input?: string | Buffer, capture?: boolean }} [options]
 * @returns {string}
 */
function compose(profile, args, options = {}) {
  const result = spawnSync(
    "docker",
    [
      "compose",
      "-p",
      profile.project,
      "-f",
      join(profile.dir, "compose.yaml"),
      ...args,
    ],
    {
      input: options.input,
      encoding: "utf8",
      stdio: [
        options.input === undefined ? "inherit" : "pipe",
        options.capture === true ? "pipe" : "inherit",
        "inherit",
      ],
    }
  )
  if (result.error !== undefined)
    throw new Error(`docker compose failed: ${result.error.message}`)
  if (result.status !== 0)
    throw new Error(
      `docker compose ${args.join(" ")} exited with ${result.status ?? result.signal}`
    )
  return result.stdout ?? ""
}

/** @param {string[]} args */
const garage = (args) =>
  // Журнал з'єднань CLI на кожен виклик лише засмічує вивід старту
  compose(
    PROFILES.postgres,
    ["exec", "-T", "-e", "RUST_LOG=garage=warn", "garage", "/garage", ...args],
    {
      capture: true,
    }
  )

/**
 * Адмінський виклик через CLI: структурована відповідь замість розбору
 * таблиць `garage status`, формат яких не є контрактом.
 *
 * @param {string} endpoint
 * @param {unknown} [payload]
 */
const garageApi = (endpoint, payload) =>
  JSON.parse(
    garage(
      payload === undefined
        ? ["json-api", endpoint]
        : ["json-api", endpoint, JSON.stringify(payload)]
    )
  )

/**
 * @param {string[]} [extra] додаткові обов'язкові змінні
 * @returns {Record<string, string>}
 */
function devSecrets(extra = []) {
  /** @type {Record<string, string>} */
  const secrets = {}
  const text = readFileSync(join(STACK_DIR, "dev-secrets.env"), "utf8")
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line)
    if (m !== null) secrets[m[1]] = m[2].trim()
  }
  for (const name of ["GARAGE_DEV_KEY_ID", "GARAGE_DEV_KEY_SECRET", ...extra])
    if (!secrets[name]) throw new Error(`${name} is not set in dev-secrets.env`)
  return secrets
}

// Кожен крок спершу дивиться на стан: повторний `db:pg:start` на запущеному
// стеку нічого не змінює
function initGarage() {
  const secrets = devSecrets()
  const keyId = secrets.GARAGE_DEV_KEY_ID
  const status = garageApi("GetClusterStatus")
  const node = status.nodes[0]
  if (node === undefined) throw new Error("Garage reports no nodes")
  if (node.role === null || node.role === undefined) {
    garage(["layout", "assign", "-z", "dc1", "-c", "1G", node.id])
    const layout = garageApi("GetClusterLayout")
    garage(["layout", "apply", "--version", String(layout.version + 1)])
  }
  const keys = garageApi("ListKeys")
  if (!keys.some((/** @type {{ id: string }} */ k) => k.id === keyId))
    garage([
      "key",
      "import",
      "--yes",
      "-n",
      BUCKET,
      keyId,
      secrets.GARAGE_DEV_KEY_SECRET,
    ])
  const buckets = garageApi("ListBuckets")
  if (
    !buckets.some((/** @type {{ globalAliases: string[] }} */ b) =>
      b.globalAliases.includes(BUCKET)
    )
  )
    garage(["bucket", "create", BUCKET])
  const bucket = garageApi("GetBucketInfo", { globalAlias: BUCKET })
  const grant = bucket.keys.find(
    (/** @type {{ accessKeyId: string }} */ k) => k.accessKeyId === keyId
  )?.permissions
  if (grant?.read !== true || grant?.write !== true || grant?.owner !== true)
    garage([
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

/**
 * @param {string} command
 * @param {string[]} args
 * @param {Record<string, string>} env
 * @param {string} [cwd]
 */
function run(command, args, env, cwd = ROOT) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    env: { ...process.env, ...env },
  })
  if (result.error !== undefined)
    throw new Error(`${command} failed: ${result.error.message}`)
  if (result.status !== 0)
    throw new Error(
      `${command} ${args[0]} exited with ${result.status ?? result.signal}`
    )
}

/** Пароль у `\set` без екранування: лише безпечні символи, інакше SQL зламався б. */
const SAFE_PASSWORD = /^[A-Za-z0-9._-]+$/

async function startPostgres() {
  compose(PROFILES.postgres, ["up", "-d", "--build", "--wait"])
  initGarage()
  const psql = (/** @type {string} */ input) =>
    compose(
      PROFILES.postgres,
      [
        "exec",
        "-T",
        "postgres",
        "psql",
        "-v",
        "ON_ERROR_STOP=1",
        "-U",
        "postgres",
        "-d",
        "postgres",
        "-f",
        "-",
      ],
      { input }
    )
  psql(readFileSync(join(STACK_DIR, "dev-environment.sql"), "utf8"))
  const secrets = devSecrets(LOGIN_ROLES.map((r) => r.secret))
  const superuserUrl = stackUrl("postgres", "postgres")
  run(
    process.execPath,
    [
      join(ROOT, "packages/designer/bin/simetra.mjs"),
      "roles",
      join(STACK_DIR, "project"),
    ],
    { SIMETRA_DATABASE_URL: superuserUrl }
  )
  // Пароль іде у stdin `psql` (`\set` + `:'pw'`), а не в `-v`: argv видно в `ps`
  psql(
    LOGIN_ROLES.map(({ role, secret }, i) => {
      const password = secrets[secret]
      if (!SAFE_PASSWORD.test(password))
        throw new Error(
          `${secret} in dev-secrets.env has unsupported characters`
        )
      return `\\set pw${i} '${password}'\nALTER ROLE ${role} PASSWORD :'pw${i}';\n`
    }).join("")
  )
  // DSN лише через середовище дочірнього процесу, не через argv
  run(
    process.execPath,
    [
      "--import",
      "tsx",
      join(ROOT, "packages/simetra/test/db/better-auth-cli.ts"),
    ],
    {
      SIMETRA_SUPERUSER_URL: superuserUrl,
      SIMETRA_AUTH_URL: stackUrl(
        "simetra_auth",
        secrets.SIMETRA_AUTH_DEV_PASSWORD
      ),
    },
    // `tsx` — залежність пакета simetra, не кореня: звідти її й резолвить `--import`
    join(ROOT, "packages/simetra")
  )
}

async function startSignals() {
  compose(PROFILES["supabase-signals"], ["up", "-d", "--wait"])
}

/**
 * @param {keyof typeof PROFILES} profile
 * @param {boolean} volumes
 */
async function stop(profile, volumes) {
  compose(PROFILES[profile], volumes ? ["down", "--volumes"] : ["down"])
}

/** @param {string[]} argv */
async function main(argv) {
  const [command, profile, ...flags] = argv
  const usage =
    "usage: node scripts/db-stack.mjs start postgres | stop postgres [--volumes] | start supabase-signals | stop supabase-signals"
  if (
    (profile !== "postgres" && profile !== "supabase-signals") ||
    (command !== "start" && command !== "stop")
  )
    throw new Error(usage)
  // Тома є лише в стеку `postgres`: Centrifugo нічого не зберігає
  const allowed =
    command === "stop" && profile === "postgres" ? ["--volumes"] : []
  const unknown = flags.filter((f) => !allowed.includes(f))
  if (unknown.length > 0)
    throw new Error(`unknown flag ${unknown[0]}; ${usage}`)
  const run = () =>
    command === "stop"
      ? stop(profile, flags.includes("--volumes"))
      : profile === "postgres"
        ? startPostgres()
        : startSignals()
  const { lock } = PROFILES[profile]
  await (lock === undefined ? run() : withStackLock(lock, run))
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
