// Стенд сигналів (спека профілю postgres §10.4): власний контейнер Centrifugo
// на прогін, споживач якого дивиться на теговану базу тесту, а не на базу
// стека. Стенд не імпортує designer: конфіг дає виклик, а типовий — власний
// конфіг стенду з `http_api` (історію публікацій читає тест).
import { execFile } from "node:child_process"
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { SIGNAL_NOTIFY_CHANNEL, SIGNAL_OUTBOX, quoteIdent } from "simetra/model"
import { runApplicationName, runTag } from "./connection"
import { nodeExec, runContainerLabels } from "./external"
import { testProvider } from "./profile"

/** Ім'я споживача outbox у конфігу Centrifugo (спека профілю §6.1). */
export const SIGNAL_CONSUMER_NAME = "simetra_outbox"

/**
 * Змінні контейнера, якими стенд ставить DSN споживача (Р16): Centrifugo
 * перевизначає ними споживача, оголошеного в конфігу, тож пароль не потрапляє
 * ні у файл конфігу, ні в argv. Єдине місце імен: ними ж користуватимуться
 * стеки розробки.
 */
export const SIGNAL_CONSUMER_ENV = {
  dsn: "CENTRIFUGO_CONSUMERS_SIMETRA_OUTBOX_POSTGRESQL_DSN",
  notificationDsn:
    "CENTRIFUGO_CONSUMERS_SIMETRA_OUTBOX_POSTGRESQL_PARTITION_NOTIFICATION_DSN",
} as const

const COMPOSE_FILE = fileURLToPath(
  new URL("../../../../docker/postgres-stack/compose.yaml", import.meta.url)
)

/**
 * Образ Centrifugo зі стека (тег і дайджест): стенд тестує ту саму версію, що
 * йде на стеку, тож другого місця піну немає.
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

export interface SignalStandOptions {
  /** DSN споживача: роль входу `simetra_signals`, база тесту. З паролем. */
  databaseUrl: string
  /**
   * DSN прямого з'єднання для `LISTEN`. Без нього стенд не слухає каналу —
   * споживач живе лише на опитуванні (так міряють внесок `LISTEN`).
   */
  notifyUrl?: string
  /** Конфіг Centrifugo; без нього — `signalStandConfig`. Без секретів. */
  config?: Record<string, unknown>
  /** Ключ HTTP API типового конфігу. */
  apiKey?: string
}

export interface Publication {
  offset: number
  data: Record<string, unknown>
}

export interface SignalStand {
  /** Ім'я контейнера: тег прогону й номер інстансу. */
  readonly name: string
  /** Адреса HTTP на `127.0.0.1`. */
  readonly httpUrl: string
  /** Публікації каналу з історії HTTP API, від найновішої. */
  history(channel: string, limit?: number): Promise<Publication[]>
  /** Журнал контейнера (stdout і stderr). */
  logs(): Promise<string>
  stop(): Promise<void>
  start(): Promise<void>
  /** Зупиняє, виконує `during` при зупиненому контейнері й запускає знову. */
  restart(during?: () => Promise<void>): Promise<void>
  /** Прибирає контейнер і конфіг; безпечний при повторі. */
  down(): Promise<void>
}

/**
 * Типовий конфіг стенду: ті самі простори й споживач, що в шаблоні профілю
 * (§6.1, §5.3), плюс `http_api` з ключем — тест читає історію. Простори без
 * жодного `allow_*_for_*`. DSN сюди не входять: їх ставить середовище
 * контейнера.
 */
export function signalStandConfig(o: {
  apiKey: string
  listen: boolean
}): Record<string, unknown> {
  const space = (name: string, size: number) => ({
    name,
    history_size: size,
    history_ttl: "300s",
    history_meta_ttl: "24h",
    force_recovery: true,
  })
  return {
    log: { level: "info" },
    health: { enabled: true },
    client: { recovery_max_publication_limit: 300 },
    channel: {
      without_namespace: {},
      namespaces: [
        space("simetra", 100),
        space("simetra-rights", 20),
        space("simetra-user", 20),
      ],
    },
    http_api: { key: o.apiKey },
    consumers: [
      {
        enabled: true,
        name: SIGNAL_CONSUMER_NAME,
        type: "postgresql",
        postgresql: {
          outbox_table_name: `${quoteIdent(SIGNAL_OUTBOX.schema)}.${quoteIdent(SIGNAL_OUTBOX.name)}`,
          num_partitions: 1,
          partition_select_limit: 100,
          partition_poll_interval: "300ms",
          use_try_lock: true,
          ...(o.listen
            ? { partition_notification_channel: SIGNAL_NOTIFY_CHANNEL }
            : {}),
        },
      },
    ],
  }
}

const HEALTH_TIMEOUT_MS = 30_000
const DOCKER_MS = 120_000

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const docker = (...args: string[]) =>
  nodeExec("docker", args, { timeoutMs: DOCKER_MS })

/** Журнал: Centrifugo пише в stderr, тож `nodeExec` (лише stdout) не годиться. */
const dockerLogs = (name: string) =>
  new Promise<string>((resolve, reject) => {
    execFile(
      "docker",
      ["logs", name],
      { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) =>
        error === null
          ? resolve(`${stdout}${stderr}`)
          : reject(new Error(`docker logs ${name}: ${error.message}`))
    )
  })

// Порт лишається тим самим на весь вік стенду: `docker restart` з новим
// портом не дав би клієнту тієї самої адреси.
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })

// Усі стенди процесу: `downAll` прибирає те, що тест забув чи не встиг
const live = new Set<SignalStand>()
let counter = 0

/** Прибирає кожен стенд процесу, що лишився. */
export async function downAllStands(): Promise<void> {
  for (const stand of [...live]) await stand.down()
}

/** DSN з `application_name` прогону: сторож завершує бекенди за цим тегом. */
function tagged(url: string): string {
  const parsed = new URL(url)
  parsed.searchParams.set("application_name", runApplicationName(runTag()))
  return parsed.toString()
}

/**
 * Піднімає контейнер Centrifugo зі споживачем outbox: `--network host`, HTTP
 * лише на `127.0.0.1` і вільному порту (Р6), мітки прогону для сторожа,
 * конфіг у тимчасовому каталозі `:ro`, готовність — `/health`. Пароль DSN —
 * лише у файлі середовища цього каталогу (не в argv і не в конфігу).
 */
export async function startSignalStand(
  o: SignalStandOptions
): Promise<SignalStand> {
  const tag = runTag()
  counter += 1
  const name = `simetra-signal-${tag}-${counter}`
  const port = await freePort()
  const httpUrl = `http://127.0.0.1:${port}`
  const apiKey = o.apiKey ?? "signal-stand-api-key"
  const dir = mkdtempSync(join(tmpdir(), `simetra-signal-${tag}-`))
  chmodSync(dir, 0o755)
  const config =
    o.config ?? signalStandConfig({ apiKey, listen: o.notifyUrl !== undefined })
  writeFileSync(join(dir, "config.json"), JSON.stringify(config), {
    mode: 0o644,
  })
  const env = [
    "CENTRIFUGO_HTTP_SERVER_ADDRESS=127.0.0.1",
    `CENTRIFUGO_HTTP_SERVER_PORT=${port}`,
    `${SIGNAL_CONSUMER_ENV.dsn}=${tagged(o.databaseUrl)}`,
    ...(o.notifyUrl === undefined
      ? []
      : [`${SIGNAL_CONSUMER_ENV.notificationDsn}=${tagged(o.notifyUrl)}`]),
  ]
  const envFile = join(dir, "stand.env")
  writeFileSync(envFile, `${env.join("\n")}\n`, { mode: 0o600 })

  const healthy = async (): Promise<boolean> => {
    try {
      return (await fetch(`${httpUrl}/health`)).ok
    } catch {
      return false
    }
  }
  const waitHealthy = async (): Promise<void> => {
    const until = Date.now() + HEALTH_TIMEOUT_MS
    while (!(await healthy())) {
      if (Date.now() > until) {
        const logs = await dockerLogs(name).catch(() => "(no logs)")
        throw new Error(`signal stand ${name}: not healthy\n${logs}`)
      }
      await sleep(100)
    }
  }

  let downed = false
  const stand: SignalStand = {
    name,
    httpUrl,
    async history(channel, limit = 10) {
      const response = await fetch(`${httpUrl}/api/history`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": apiKey },
        body: JSON.stringify({ channel, limit, reverse: true }),
      })
      const body = (await response.json()) as {
        error?: { message: string }
        result?: { publications?: Publication[] }
      }
      if (body.error !== undefined)
        throw new Error(`history ${channel}: ${body.error.message}`)
      return body.result?.publications ?? []
    },
    logs: () => dockerLogs(name),
    async stop() {
      await docker("stop", "-t", "0", name)
    },
    async start() {
      await docker("start", name)
      await waitHealthy()
    },
    async restart(during) {
      await docker("stop", "-t", "0", name)
      await during?.()
      await docker("start", name)
      await waitHealthy()
    },
    async down() {
      if (downed) return
      downed = true
      live.delete(stand)
      try {
        await docker("rm", "-f", "-v", name)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  }
  live.add(stand)
  try {
    await docker(
      "run",
      "-d",
      "--name",
      name,
      "--network",
      "host",
      ...runContainerLabels(tag, testProvider()),
      "--env-file",
      envFile,
      "-v",
      `${dir}:/stand:ro`,
      centrifugoImage(),
      "centrifugo",
      "-c",
      "/stand/config.json"
    )
    await waitHealthy()
  } catch (error) {
    await stand.down().catch(() => undefined)
    throw error
  }
  return stand
}
