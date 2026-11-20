// Власний Centrifugo для `pnpm demo` і e2e шаблону: один хелпер на обох (Р1 плану
// D5). Спільний стек його не дає: Centrifugo падає на старті, коли бази з DSN
// споживача немає, а база demo існує не завжди. Тестового коду тут немає — демо
// його не імпортує; мітки контейнера, адреси й паролі дає той, хто кличе.
import { execFile } from "node:child_process"
import { randomBytes } from "node:crypto"
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import net from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { PLATFORM_LOGIN_ROLES } from "simetra/model"
import { SIGNALS_JWKS_PATH } from "simetra/server/signals"
// Ім'я споживача й змінні його DSN — з генератора конфігу: стеки ставлять DSN
// тими самими змінними, тож друге місце імен розійшлося б
import {
  SIGNAL_CONSUMER_ENV,
  centrifugoConfig,
} from "../../../designer/src/tools/signals-config"
import { TEMPLATE, withDatabase } from "./app-database.mts"

const COMPOSE_FILE = resolve(
  import.meta.dirname,
  "../../../../docker/postgres-stack/compose.yaml"
)
const HEALTH_TIMEOUT_MS = 30_000
const DOCKER_MS = 120_000

/** Назва проєкту шаблону: з неї складається `audience` токенів (`centrifugo:<name>`). */
export function templateProjectName(): string {
  const file = join(TEMPLATE, "metadata/project.meta.json")
  const { name } = JSON.parse(readFileSync(file, "utf8")) as { name?: unknown }
  if (typeof name !== "string" || name === "")
    throw new Error(`${file}: no project name`)
  return name
}

/**
 * Образ Centrifugo зі стека (тег і дайджест): демо й e2e беруть ту саму
 * версію, що йде на стеку, тож другого місця піну немає.
 */
export function centrifugoImage(compose: string = COMPOSE_FILE): string {
  const text = readFileSync(compose, "utf8")
  const at = text.indexOf("\n  centrifugo:")
  const image =
    at < 0 ? undefined : /\n\s+image:\s*(\S+)/.exec(text.slice(at))?.[1]
  if (image === undefined)
    throw new Error(`${compose}: no image of the centrifugo service`)
  return image
}

/**
 * DSN споживача outbox: роль `simetra_signals` на базу застосунку, пароль із
 * `loginSecrets()` (ті самі, що дають `appDsns`).
 */
export function signalsDsn(
  superuserUrl: string,
  database: string,
  secrets: Record<string, string>
): string {
  const password = secrets.SIMETRA_SIGNALS_DEV_PASSWORD
  if (password === undefined || password === "")
    throw new Error("SIMETRA_SIGNALS_DEV_PASSWORD is not set")
  const url = new URL(withDatabase(superuserUrl, database))
  url.username = PLATFORM_LOGIN_ROLES.signals
  url.password = password
  return url.toString()
}

/**
 * Ключі підпису на один запуск: нова пара Ed25519 і новий `kid`. Нічого не
 * зберігається: закомічений ключ у публічному репо потрапив би в production, а
 * новий `kid` змушує Centrifugo перечитати JWKS замість кешу минулого запуску
 * (Р3). `addedAt` = зараз: ключ підписує одразу (профіль §6.3).
 */
export async function generateSigningKeys(
  now: Date = new Date()
): Promise<{ kid: string; json: string }> {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey)
  const kid = `run-${randomBytes(6).toString("hex")}`
  return {
    kid,
    json: JSON.stringify([
      {
        kid,
        privateJwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, d: jwk.d },
        addedAt: now.toISOString(),
      },
    ]),
  }
}

export interface SignalsContainerInput {
  /** Ім'я контейнера. */
  name: string
  /** Аргументи `docker run --label …`: мітки власника (демо чи прогін e2e). */
  labels: readonly string[]
  /** Назва проєкту з файла проєкту шаблону. */
  projectName: string
  /** Походження застосунку: `allowed_origins` і `iss` токенів. */
  origin: string
  /** Порт host-а на 127.0.0.1: його JWKS читає Centrifugo. */
  hostPort: number
  /** Вільний порт HTTP Centrifugo на 127.0.0.1. */
  port: number
  /** DSN ролі `simetra_signals` на базу застосунку; з паролем. */
  databaseUrl: string
  /** Каталог із `config.json` (монтується `:ro`). */
  configDir: string
  image: string
}

/**
 * Усе, що потрібно для `docker run`, без запуску: конфіг, середовище контейнера
 * й argv. Пароль DSN лише в `env`; argv несе імена змінних (`-e NAME` бере
 * значення з середовища клієнта docker), конфіг пароля не має.
 */
export function signalsContainer(o: SignalsContainerInput): {
  config: ReturnType<typeof centrifugoConfig>
  env: Record<string, string>
  args: string[]
} {
  const config = centrifugoConfig({
    projectName: o.projectName,
    origin: o.origin,
    issuer: o.origin,
    jwksUrl: `http://127.0.0.1:${o.hostPort}${SIGNALS_JWKS_PATH}`,
  })
  const env = {
    CENTRIFUGO_HTTP_SERVER_ADDRESS: "127.0.0.1",
    CENTRIFUGO_HTTP_SERVER_PORT: String(o.port),
    [SIGNAL_CONSUMER_ENV.dsn]: o.databaseUrl,
    [SIGNAL_CONSUMER_ENV.notificationDsn]: o.databaseUrl,
  }
  const args = [
    "run",
    "-d",
    "--name",
    o.name,
    "--network",
    "host",
    ...o.labels,
    ...Object.keys(env).flatMap((name) => ["-e", name]),
    "-v",
    `${o.configDir}:/signals:ro`,
    o.image,
    "centrifugo",
    "-c",
    "/signals/config.json",
  ]
  return { config, env, args }
}

const docker = (
  args: readonly string[],
  env?: Record<string, string>
): Promise<string> =>
  new Promise((resolveRun, reject) => {
    execFile(
      "docker",
      [...args],
      {
        encoding: "utf8",
        timeout: DOCKER_MS,
        killSignal: "SIGKILL",
        env: { ...process.env, ...env },
      },
      (error, stdout, stderr) =>
        error === null
          ? resolveRun(stdout)
          : reject(
              new Error(`docker ${args[0]}: ${stderr.trim() || error.message}`)
            )
    )
  })

/** Журнал: Centrifugo пише в stderr, тож лише stdout не годиться. */
const dockerLogs = (name: string): Promise<string> =>
  new Promise((resolveLogs) => {
    execFile(
      "docker",
      ["logs", name],
      { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 * 1024 },
      (_error, stdout, stderr) => resolveLogs(`${stdout}${stderr}`)
    )
  })

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo
      server.close(() => resolvePort(port))
    })
  })
}

/**
 * Знімає контейнери з міткою `label` (`ключ=значення`): залишок попереднього
 * запуску, що не встиг прибратися. Мітка власна для кожного володаря, тож чужого
 * контейнера, зокрема Centrifugo стека, це не торкається.
 */
export async function removeSignalsContainers(label: string): Promise<void> {
  const ids = (await docker(["ps", "-aq", "--filter", `label=${label}`]))
    .split("\n")
    .filter((id) => id !== "")
  if (ids.length > 0) await docker(["rm", "-f", "-v", ...ids])
}

export interface SignalsStand {
  name: string
  /** WebSocket-адреса для браузера: `SIMETRA_SIGNALS_URL` host-а. */
  wsUrl: string
  httpUrl: string
  logs: () => Promise<string>
  /** Знімає контейнер і конфіг; безпечний при повторі. */
  down: () => Promise<void>
}

export interface StartSignalsOptions {
  name: string
  labels: readonly string[]
  origin: string
  hostPort: number
  databaseUrl: string
}

/**
 * Запускає Centrifugo під host: `--network host`, HTTP лише на 127.0.0.1 і
 * вільному порту, конфіг у тимчасовому каталозі, готовність — `/health`. На
 * збої старту контейнер знімається сам.
 */
export async function startSignals(
  o: StartSignalsOptions
): Promise<SignalsStand> {
  const port = await freePort()
  const httpUrl = `http://127.0.0.1:${port}`
  const dir = mkdtempSync(join(tmpdir(), "simetra-signals-"))
  const spec = signalsContainer({
    name: o.name,
    labels: o.labels,
    projectName: templateProjectName(),
    origin: o.origin,
    hostPort: o.hostPort,
    port,
    databaseUrl: o.databaseUrl,
    configDir: dir,
    image: centrifugoImage(),
  })
  let downed = false
  const stand: SignalsStand = {
    name: o.name,
    wsUrl: `ws://127.0.0.1:${port}/connection/websocket`,
    httpUrl,
    logs: () => dockerLogs(o.name),
    async down() {
      if (downed) return
      await docker(["rm", "-f", "-v", o.name])
      downed = true
      rmSync(dir, { recursive: true, force: true })
    },
  }
  try {
    // Контейнер працює не від root: каталог і файл мають бути читабельні
    chmodSync(dir, 0o755)
    writeFileSync(join(dir, "config.json"), JSON.stringify(spec.config), {
      mode: 0o644,
    })
    await docker(spec.args, spec.env)
    const until = Date.now() + HEALTH_TIMEOUT_MS
    for (;;) {
      const ok = await fetch(`${httpUrl}/health`)
        .then((r) => r.ok)
        .catch(() => false)
      if (ok) break
      if (Date.now() > until)
        throw new Error(
          `centrifugo ${o.name}: not healthy\n${await dockerLogs(o.name)}`
        )
      await new Promise((r) => setTimeout(r, 100))
    }
  } catch (error) {
    await stand.down().catch(() => undefined)
    rmSync(dir, { recursive: true, force: true })
    throw error
  }
  return stand
}
