// Стенд сигналів (спека профілю postgres §10.4): власний контейнер Centrifugo
// на прогін, споживач якого дивиться на теговану базу тесту, а не на базу
// стека. Стенд не імпортує designer: конфіг дає виклик, а типовий — власний
// конфіг стенду з `http_api` (історію публікацій читає тест). Гейт доставки
// бере ще тестовий JWKS-сервер і клієнт `centrifuge` звідси ж.
import { execFile } from "node:child_process"
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { createServer as createHttpServer } from "node:http"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  Centrifuge,
  type PublishResult,
  type SubscribedContext,
  type Subscription,
} from "centrifuge"
import type pg from "pg"
import {
  PLATFORM_ROLES,
  SIGNAL_NOTIFY_CHANNEL,
  SIGNAL_OUTBOX,
  quoteIdent,
} from "simetra/model"
import { SIGNALS_JWKS_PATH } from "simetra/server/signals"
import {
  SIGNAL_OUTBOX_POLICIES,
  outboxUnits,
} from "../../src/compiler/platform/outbox"
import { loadSqlParser } from "../../src/compiler/sql/parse"
// Ім'я споживача й змінні його DSN — з генератора конфігу: стенд і стеки ставлять
// DSN тими самими змінними (Р16), тож друге місце імен розійшлося б
import {
  SIGNAL_CONSUMER_ENV,
  SIGNAL_CONSUMER_NAME,
} from "../../../designer/src/tools/signals-config"
import { runApplicationName, runTag } from "./connection"
import { nodeExec, runContainerLabels } from "./external"
import { testProvider } from "./profile"

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
  /** Адреса WebSocket клієнта (`/connection/websocket`). */
  readonly wsUrl: string
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
  const results = await Promise.allSettled([...live].map((s) => s.down()))
  const errors = results.flatMap((r) =>
    r.status === "rejected" ? [r.reason] : []
  )
  if (errors.length > 0)
    throw new AggregateError(errors, "signal stands were not removed")
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
  try {
    chmodSync(dir, 0o755)
    const config =
      o.config ??
      signalStandConfig({ apiKey, listen: o.notifyUrl !== undefined })
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
    writeFileSync(join(dir, "stand.env"), `${env.join("\n")}\n`, {
      mode: 0o600,
    })
  } catch (error) {
    rmSync(dir, { recursive: true, force: true })
    throw error
  }
  const envFile = join(dir, "stand.env")

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
    wsUrl: `ws://127.0.0.1:${port}/connection/websocket`,
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
      // Лише після успішного `rm`: збій лишає стенд у `live`, і `downAll`
      // спробує ще раз
      await docker("rm", "-f", "-v", name)
      downed = true
      live.delete(stand)
      rmSync(dir, { recursive: true, force: true })
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

/**
 * Гранти й політики outbox групи споживача прогону `group` — ті самі одиниці,
 * що генератор дає `simetra_signal_consumer`, з іменем групи й іменами
 * політик із суфіксом тегу (політики таблиці унікальні). Спільну роль членом
 * не доповнюють: гейт ролей побачив би чужого члена. `owner` — з'єднання з
 * базою тесту, що може грантувати на outbox і створювати політики.
 */
export async function grantStandConsumer(
  owner: pg.Client,
  group: string
): Promise<number> {
  const real = PLATFORM_ROLES.signalConsumer
  const policyNames = Object.values(SIGNAL_OUTBOX_POLICIES)
  const grants = outboxUnits(
    "signal-stand",
    testProvider(),
    await loadSqlParser()
  )
    .map((unit) => unit.sql)
    .filter((sql) => sql.includes(quoteIdent(real)))
  for (const sql of grants) {
    let tagged = sql.split(quoteIdent(real)).join(quoteIdent(group))
    for (const name of policyNames)
      tagged = tagged.split(name).join(`${name}_${runTag()}`)
    await owner.query(tagged)
  }
  return grants.length
}

export interface JwksServer {
  /** Origin сервера на `127.0.0.1` — і `iss` токенів гейта. */
  readonly origin: string
  /** `origin` + `SIGNALS_JWKS_PATH`: вхід `jwksUrl` генератора конфігу. */
  readonly jwksUrl: string
  /** Скільки разів Centrifugo читав JWKS. */
  readonly reads: () => number
  close(): Promise<void>
}

/**
 * Тестовий JWKS host-а на `127.0.0.1` і вільному порту (Р6, Р17): Centrifugo
 * у мережі хоста бачить loopback. Віддає `jwks()` на кожен запит — так ключ,
 * якого немає в JWKS, Centrifugo не знайде й після перечитування.
 */
export async function startJwksServer(
  jwks: () => unknown
): Promise<JwksServer> {
  let reads = 0
  const server = createHttpServer((request, response) => {
    if (request.method !== "GET" || request.url !== SIGNALS_JWKS_PATH) {
      response.writeHead(404).end()
      return
    }
    reads += 1
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify(jwks()))
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve())
  })
  const { port } = server.address() as { port: number }
  const origin = `http://127.0.0.1:${port}`
  return {
    origin,
    jwksUrl: `${origin}${SIGNALS_JWKS_PATH}`,
    reads: () => reads,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

/** Публікація, яку отримав клієнт, і мітка `performance.now()` отримання. */
export interface ReceivedSignal {
  data: Record<string, unknown>
  offset: number | undefined
  at: number
}

/** Подія закриття підписки (`unsubscribed` чи `subscribing` після підписки). */
export interface SubscriptionClose {
  state: "unsubscribed" | "subscribing"
  code: number
  reason: string
  /** `Date.now()`: межу відкликання міряють годинником стіни, як `exp`. */
  at: number
}

export interface SignalSubscription {
  readonly channel: string
  readonly received: ReceivedSignal[]
  /** Кожна подія `subscribed`, від першої. */
  readonly subscribed: SubscribedContext[]
  /** Кожне закриття після підписки. */
  readonly closes: SubscriptionClose[]
  state(): string
  /** Перша (від `from`) публікація, що задовольняє `match`; інакше — помилка за `timeoutMs`. */
  next(
    match: (data: Record<string, unknown>) => boolean,
    timeoutMs?: number,
    from?: number
  ): Promise<ReceivedSignal>
  /** Чекає `subscribed` з номером `count` (від 1). */
  subscribedAt(count: number, timeoutMs?: number): Promise<SubscribedContext>
  publish(data: unknown): Promise<PublishResult>
}

/** Підсумок підписки: підписано чи сервер відмовив з кодом. */
export type SubscribeOutcome =
  | { state: "subscribed"; subscription: SignalSubscription }
  | { state: "refused"; code: number; message: string }

export interface SignalClient {
  readonly centrifuge: Centrifuge
  /** Підписка з токеном каналу; `getToken` — поновлення (без нього — лише цей токен). */
  subscribe(
    channel: string,
    options: { token?: string; getToken?: () => Promise<string> }
  ): Promise<SubscribeOutcome>
  disconnect(): void
  connect(): Promise<void>
}

/** Підсумок з'єднання: з'єднано чи сервер відмовив з кодом. */
export type ConnectOutcome =
  | { state: "connected"; client: SignalClient }
  | {
      state: "refused"
      code: number
      reason: string
      /** Код першої відмови сервера на `connect` (до поновлення токена SDK). */
      error: number | undefined
    }

const OUTCOME_MS = 10_000
const clients = new Set<Centrifuge>()

/** Закриває кожен клієнт процесу, що лишився відкритим. */
export function closeAllClients(): void {
  for (const c of clients) c.disconnect()
  clients.clear()
}

function waitFor<T>(
  what: string,
  timeoutMs: number,
  attach: (done: (value: T) => void, fail: (error: Error) => void) => void
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${what}: no outcome in ${timeoutMs} ms`)),
      timeoutMs
    )
    attach(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

function wrapSubscription(sub: Subscription): SignalSubscription {
  const received: ReceivedSignal[] = []
  const subscribed: SubscribedContext[] = []
  const closes: SubscriptionClose[] = []
  const listeners = new Set<() => void>()
  const changed = () => {
    for (const l of [...listeners]) l()
  }
  sub.on("publication", (ctx) => {
    received.push({
      data: ctx.data as Record<string, unknown>,
      offset: ctx.offset,
      at: performance.now(),
    })
    changed()
  })
  sub.on("subscribed", (ctx) => {
    subscribed.push(ctx)
    changed()
  })
  sub.on("unsubscribed", (ctx) => {
    closes.push({
      state: "unsubscribed",
      code: ctx.code,
      reason: ctx.reason,
      at: Date.now(),
    })
    changed()
  })
  sub.on("subscribing", (ctx) => {
    if (subscribed.length === 0) return
    closes.push({
      state: "subscribing",
      code: ctx.code,
      reason: ctx.reason,
      at: Date.now(),
    })
    changed()
  })
  const until = <T>(
    what: string,
    timeoutMs: number,
    probe: () => T | undefined
  ): Promise<T> =>
    waitFor<T>(what, timeoutMs, (done) => {
      const check = () => {
        const value = probe()
        if (value === undefined) return
        listeners.delete(check)
        done(value)
      }
      listeners.add(check)
      check()
    })
  return {
    channel: sub.channel,
    received,
    subscribed,
    closes,
    state: () => sub.state,
    next: (match, timeoutMs = OUTCOME_MS, from = 0) =>
      until(`publication on ${sub.channel}`, timeoutMs, () =>
        received.slice(from).find((r) => match(r.data))
      ),
    subscribedAt: (count, timeoutMs = OUTCOME_MS) =>
      until(
        `subscribed #${count} on ${sub.channel}`,
        timeoutMs,
        () => subscribed[count - 1]
      ),
    publish: (data) => sub.publish(data),
  }
}

/**
 * Клієнт `centrifuge` (WebSocket Node) зі стендом: з'єднання з токеном
 * `token`; без `getToken` прострочений токен не поновлюється. Підсумок —
 * перша подія `connected` чи `disconnected`.
 */
export async function connectSignals(
  stand: Pick<SignalStand, "wsUrl">,
  options: { token: string; getToken?: () => Promise<string> }
): Promise<ConnectOutcome> {
  const centrifuge = new Centrifuge(stand.wsUrl, {
    token: options.token,
    // Відмова поновлення — порожній рядок: клієнт закривається з
    // `unauthorized`, а не повторює запит без кінця
    getToken: options.getToken ?? (async () => ""),
    minReconnectDelay: 100,
    maxReconnectDelay: 500,
  })
  clients.add(centrifuge)
  const close = () => {
    centrifuge.disconnect()
    clients.delete(centrifuge)
  }
  const client: SignalClient = {
    centrifuge,
    disconnect: close,
    connect: () =>
      waitFor<void>("reconnect", OUTCOME_MS, (done) => {
        clients.add(centrifuge)
        centrifuge.once("connected", () => done())
        centrifuge.connect()
      }),
    subscribe: (channel, o) => {
      const sub = centrifuge.newSubscription(channel, {
        ...(o.token === undefined ? {} : { token: o.token }),
        getToken: o.getToken ?? (async () => ""),
        minResubscribeDelay: 100,
        maxResubscribeDelay: 500,
      })
      const wrapped = wrapSubscription(sub)
      return waitFor<SubscribeOutcome>(
        `subscribe ${channel}`,
        OUTCOME_MS,
        (done) => {
          // Постійну відмову сервера (код ≥ 100) SDK віддає `unsubscribed` з
          // кодом відмови; тимчасову повторює — тоді підсумку немає. Токен,
          // якого Centrifugo не приймає, рве все з'єднання: код відмови несе
          // `disconnected`, а підписка лишається `subscribing`
          const detach = () => {
            sub.off("subscribed", onSubscribed)
            sub.off("unsubscribed", onRefused)
            centrifuge.off("disconnected", onRefused)
          }
          const onSubscribed = () => {
            detach()
            done({ state: "subscribed", subscription: wrapped })
          }
          const onRefused = (ctx: { code: number; reason: string }) => {
            detach()
            centrifuge.removeSubscription(sub)
            done({ state: "refused", code: ctx.code, message: ctx.reason })
          }
          sub.on("subscribed", onSubscribed)
          sub.on("unsubscribed", onRefused)
          centrifuge.on("disconnected", onRefused)
          sub.subscribe()
        }
      )
    },
  }
  return waitFor<ConnectOutcome>("connect", OUTCOME_MS, (done) => {
    let error: number | undefined
    const onError = (ctx: { type: string; error: { code: number } }) => {
      if (ctx.type === "connect" && error === undefined) error = ctx.error.code
    }
    const detach = () => {
      centrifuge.off("error", onError)
      centrifuge.off("connected", onConnected)
      centrifuge.off("disconnected", onDisconnected)
    }
    const onConnected = () => {
      detach()
      done({ state: "connected", client })
    }
    const onDisconnected = (ctx: { code: number; reason: string }) => {
      detach()
      close()
      done({ state: "refused", code: ctx.code, reason: ctx.reason, error })
    }
    centrifuge.on("error", onError)
    centrifuge.on("connected", onConnected)
    centrifuge.on("disconnected", onDisconnected)
    centrifuge.connect()
  })
}
