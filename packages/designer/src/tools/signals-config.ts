import { diagnostic, readProjectFile } from "simetra/compiler"
import {
  CENTRIFUGO_CHANNEL_MAX,
  SIGNAL_MERGE_THRESHOLD,
  SIGNAL_NOTIFY_CHANNEL,
  SIGNAL_OUTBOX,
  quoteIdent,
} from "simetra/model"
import { z } from "zod"
import { readMetadataDir } from "../io/metadata-dir"
import { defineTool } from "./types"

const PROJECT_FILE = "project.meta.json"

/** Name of the outbox consumer in the Centrifugo config (postgres profile spec §6.1). */
export const SIGNAL_CONSUMER_NAME = "simetra_outbox"

/**
 * Environment variables that give the consumer its DSNs (postgres profile spec
 * §10.1): Centrifugo overrides the consumer declared in the config with them,
 * so the password of `simetra_signals` never lands in the config file.
 */
export const SIGNAL_CONSUMER_ENV = {
  dsn: "CENTRIFUGO_CONSUMERS_SIMETRA_OUTBOX_POSTGRESQL_DSN",
  notificationDsn:
    "CENTRIFUGO_CONSUMERS_SIMETRA_OUTBOX_POSTGRESQL_PARTITION_NOTIFICATION_DSN",
} as const

/**
 * `history_size` of the namespace `simetra`: it bounds the signal merge
 * threshold from above (threshold + 1 `invalidate` ≤ history, P4-B spec §8.2).
 */
export const SIGNAL_HISTORY_SIZE = 100

// Простори — частина топіка до першої `:` (спека профілю §6.1); історія прав і
// користувача менша: сигнал там рідкісний і без злиття
const NAMESPACES: readonly { name: string; historySize: number }[] = [
  { name: "simetra", historySize: SIGNAL_HISTORY_SIZE },
  { name: "simetra-rights", historySize: 20 },
  { name: "simetra-user", historySize: 20 },
]

// Межа відкликання (спека профілю §6.2): Centrifugo закриває прострочену
// підписку лише на такті присутності клієнта, тож межа — TTL токена каналу +
// `expired_sub_close_delay` + `presence_update_interval`. Обидва ключі пише
// генератор явно: межа — властивість безпеки, а не типове значення образу
const PRESENCE_UPDATE_INTERVAL = "5s"
const EXPIRED_SUB_CLOSE_DELAY = "25s"

const HISTORY_TTL = "300s"
const HISTORY_META_TTL = "24h"
const RECOVERY_MAX_PUBLICATION_LIMIT = 300
const OUTBOX_TABLE = `${quoteIdent(SIGNAL_OUTBOX.schema)}.${quoteIdent(SIGNAL_OUTBOX.name)}`

export interface CentrifugoConfigInput {
  /** `name` of the project file: the token audience is `centrifugo:<projectName>`. */
  projectName: string
  /** The browser origin of the application (`client.allowed_origins`). */
  origin: string
  /** The host origin, the `iss` of every token. */
  issuer: string
  /** The JWKS address of the host (`SIGNALS_JWKS_PATH` on its internal address). */
  jwksUrl: string
}

/**
 * Centrifugo v6 config of one application (postgres profile spec §6.1, §5.3):
 * three namespaces with history and forced recovery, no client permission,
 * the outbox consumer with empty DSNs (they come from `SIGNAL_CONSUMER_ENV`),
 * the HTTP API off. No `http_server`: the address is the deployment's choice.
 */
export function centrifugoConfig(o: CentrifugoConfigInput) {
  return {
    client: {
      allowed_origins: [o.origin],
      token: {
        jwks_public_endpoint: o.jwksUrl,
        audience: `centrifugo:${o.projectName}`,
        issuer: o.issuer,
      },
      recovery_max_publication_limit: RECOVERY_MAX_PUBLICATION_LIMIT,
      presence_update_interval: PRESENCE_UPDATE_INTERVAL,
      expired_sub_close_delay: EXPIRED_SUB_CLOSE_DELAY,
    },
    channel: {
      max_length: CENTRIFUGO_CHANNEL_MAX,
      without_namespace: {},
      namespaces: NAMESPACES.map((n) => ({
        name: n.name,
        history_size: n.historySize,
        history_ttl: HISTORY_TTL,
        history_meta_ttl: HISTORY_META_TTL,
        force_recovery: true,
      })),
    },
    consumers: [
      {
        enabled: true,
        name: SIGNAL_CONSUMER_NAME,
        type: "postgresql",
        postgresql: {
          dsn: "",
          partition_notification_dsn: "",
          outbox_table_name: OUTBOX_TABLE,
          num_partitions: 1,
          partition_select_limit: 100,
          partition_poll_interval: "300ms",
          partition_notification_channel: SIGNAL_NOTIFY_CHANNEL,
          use_try_lock: true,
        },
      },
    ],
    http_api: { disabled: true },
    health: { enabled: true },
    log: { level: "info" },
  }
}

export type CentrifugoConfig = ReturnType<typeof centrifugoConfig>

type Rule = (value: unknown, path: string) => string[]

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

// Білий список, а не перелік заборон: нова опція Centrifugo (новий слухач,
// дозвіл клієнту, ключ) не проходить мовчки, доки її не додано сюди свідомо
function object(shape: Record<string, Rule>): Rule {
  return (value, path) => {
    if (!isRecord(value)) return [`${path}: expected an object`]
    const extra = Object.keys(value)
      .filter((key) => !Object.hasOwn(shape, key))
      .map((key) => `${path}.${key}: not an allowed option`)
    const own = Object.entries(shape).flatMap(([key, rule]) =>
      Object.hasOwn(value, key)
        ? rule(value[key], `${path}.${key}`)
        : [`${path}.${key}: missing`]
    )
    return [...extra, ...own]
  }
}

const exactly =
  (expected: unknown): Rule =>
  (value, path) =>
    value === expected
      ? []
      : [
          `${path}: must be ${JSON.stringify(expected)}, got ${JSON.stringify(value)}`,
        ]

const int =
  (min: number, max = Number.MAX_SAFE_INTEGER): Rule =>
  (value, path) =>
    Number.isInteger(value) &&
    (value as number) >= min &&
    (value as number) <= max
      ? []
      : [`${path}: must be an integer from ${min} to ${max}`]

const duration: Rule = (value, path) =>
  typeof value === "string" && /^\d+(ms|s|m|h)$/.test(value)
    ? []
    : [`${path}: must be a duration such as "300s"`]

const DURATION_MS = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 } as const

const durationMs = (value: string): number => {
  const [, amount, unit] = /^(\d+)(ms|s|m|h)$/.exec(value)!
  return Number(amount) * DURATION_MS[unit as keyof typeof DURATION_MS]
}

// Більше значення відсунуло б межу відкликання за число спеки
const durationAtMost =
  (bound: string): Rule =>
  (value, path) =>
    duration(value, path).length === 0 &&
    durationMs(value as string) > 0 &&
    durationMs(value as string) <= durationMs(bound)
      ? []
      : [`${path}: must be a positive duration not above ${bound}`]

const nonEmpty: Rule = (value, path) =>
  typeof value === "string" && value.trim() !== ""
    ? []
    : [`${path}: must be a non-empty string`]

// Origin — рівно схема, хост і порт: `*`, шлях чи шаблон відкрили б з'єднання
// з чужих сторінок
const origin: Rule = (value, path) => {
  if (typeof value === "string" && URL.canParse(value)) {
    const url = new URL(value)
    if (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.origin === value
    )
      return []
  }
  return [`${path}: must be an http(s) origin, got ${JSON.stringify(value)}`]
}

const LOOPBACK_HOST = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/
// Однослівне ім'я — сервіс внутрішньої мережі (compose, k8s), не хост інтернету
const SERVICE_NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i

/**
 * JWKS лише через TLS чи внутрішню адресу (спека профілю §6.3): підміна
 * відповіді JWKS дала б токен на будь-який канал.
 */
const jwksUrl: Rule = (value, path) => {
  const refused = [
    `${path}: must be an https: URL, or http: on a loopback address or a single-label service name, got ${JSON.stringify(value)}`,
  ]
  if (typeof value !== "string" || !URL.canParse(value)) return refused
  const url = new URL(value)
  if (url.username !== "" || url.password !== "") return refused
  if (url.protocol === "https:") return []
  if (url.protocol !== "http:") return refused
  return LOOPBACK_HOST.test(url.hostname) ||
    (SERVICE_NAME.test(url.hostname) && !/^\d+$/.test(url.hostname))
    ? []
    : refused
}

const namespace = object({
  name: nonEmpty,
  history_size: int(1),
  history_ttl: duration,
  history_meta_ttl: duration,
  force_recovery: exactly(true),
})

const namespaces: Rule = (value, path) => {
  if (!Array.isArray(value)) return [`${path}: expected an array`]
  const own = value.flatMap((n, i) => namespace(n, `${path}[${i}]`))
  const names = value.map((n) => (isRecord(n) ? n.name : undefined))
  const expected = NAMESPACES.map((n) => n.name)
  const set =
    names.length === expected.length &&
    expected.every((name) => names.includes(name))
      ? []
      : [`${path}: must be exactly the namespaces ${expected.join(", ")}`]
  // Поріг злиття + 1 (`invalidate`) мусить уміститися в історію: інакше
  // короткий розрив на великій команді не відновлюється (Р23)
  const simetra = value.find((n) => isRecord(n) && n.name === "simetra")
  const history =
    isRecord(simetra) &&
    Number.isInteger(simetra.history_size) &&
    (simetra.history_size as number) < SIGNAL_MERGE_THRESHOLD + 1
      ? [
          `${path}: history_size of simetra must be at least ${SIGNAL_MERGE_THRESHOLD + 1} (the default signal merge threshold + 1)`,
        ]
      : []
  return [...own, ...set, ...history]
}

const consumer = object({
  enabled: exactly(true),
  name: exactly(SIGNAL_CONSUMER_NAME),
  type: exactly("postgresql"),
  postgresql: object({
    // Секрет — лише середовищем (`SIGNAL_CONSUMER_ENV`), ніколи у файлі
    dsn: exactly(""),
    partition_notification_dsn: exactly(""),
    outbox_table_name: exactly(OUTBOX_TABLE),
    num_partitions: exactly(1),
    partition_select_limit: int(1),
    partition_poll_interval: duration,
    partition_notification_channel: exactly(SIGNAL_NOTIFY_CHANNEL),
    // Один інстанс тримає транзакцію розділу; решта не чекають (§5.3)
    use_try_lock: exactly(true),
  }),
})

const consumers: Rule = (value, path) =>
  Array.isArray(value) && value.length === 1
    ? consumer(value[0], `${path}[0]`)
    : [`${path}: must hold exactly the consumer ${SIGNAL_CONSUMER_NAME}`]

const config = object({
  client: object({
    allowed_origins: (value, path) =>
      Array.isArray(value) && value.length > 0
        ? value.flatMap((o, i) => origin(o, `${path}[${i}]`))
        : [`${path}: must list at least one origin`],
    token: object({
      jwks_public_endpoint: jwksUrl,
      audience: (value, path) =>
        typeof value === "string" && /^centrifugo:\S+$/.test(value)
          ? []
          : [`${path}: must be centrifugo:<project name>`],
      issuer: nonEmpty,
    }),
    recovery_max_publication_limit: int(1),
    presence_update_interval: durationAtMost(PRESENCE_UPDATE_INTERVAL),
    expired_sub_close_delay: durationAtMost(EXPIRED_SUB_CLOSE_DELAY),
  }),
  channel: object({
    max_length: int(1, CENTRIFUGO_CHANNEL_MAX),
    // Простір без імені без жодного дозволу: канал поза трьома просторами недосяжний
    without_namespace: object({}),
    namespaces,
  }),
  consumers,
  http_api: object({ disabled: exactly(true) }),
  health: object({ enabled: exactly(true) }),
  log: object({ level: exactly("info") }),
})

/**
 * Refusals of a Centrifugo config (P4-B block B2, invariant 11): every level
 * is a whitelist of keys, so a client permission (`allow_*_for_*`,
 * anonymous connect, presence), an insecure or admin mode, a secret
 * (`hmac_secret_key`, a DSN), another listener (`http_server`, `grpc_api`)
 * or an open origin is refused. Empty for the output of `centrifugoConfig`.
 */
export function centrifugoConfigRefusals(value: unknown): string[] {
  return config(value, "config")
}

export interface SignalsConfigData {
  config: CentrifugoConfig
  /** Variables the deployment sets to the DSNs of the login role `simetra_signals`. */
  environment: string[]
}

export const signalsConfigTool = defineTool({
  name: "signals-config",
  description: `Generate the Centrifugo v6 config of the project's signals: three namespaces with history and forced recovery, no client permission, the outbox consumer, the HTTP API off. Input is JSON {origin, issuer, jwksUrl}: origin — the browser origin of the application; issuer — the host origin, the iss of every token (the audience is centrifugo:<project name>); jwksUrl — the JWKS address of the host, https: or http: on a loopback address or a single-label service name. The config holds no secret: set ${SIGNAL_CONSUMER_ENV.dsn} and ${SIGNAL_CONSUMER_ENV.notificationDsn} to the DSN of the login role simetra_signals (a direct connection; a pooler only in session mode) in the environment of Centrifugo. Run exactly one Centrifugo per application. The HTTP listener is the deployment's choice (CENTRIFUGO_HTTP_SERVER_ADDRESS, CENTRIFUGO_HTTP_SERVER_PORT). Refuses a config that breaks the whitelist.`,
  input: z.strictObject({
    origin: z.string(),
    issuer: z.string(),
    jwksUrl: z.string(),
  }),
  files: "read",
  database: "none",
  data: "none",
  destructive: false,
  async run({ dir }, input) {
    const text = (await readMetadataDir(dir)).get(PROJECT_FILE)
    if (text === undefined)
      return {
        ok: false,
        changes: [],
        diagnostics: [diagnostic("project.missing", PROJECT_FILE, "")],
      }
    const read = readProjectFile(text)
    if (read.project === undefined)
      return { ok: false, changes: [], diagnostics: read.diagnostics }
    const config = centrifugoConfig({
      projectName: read.project.name,
      ...input,
    })
    const refusals = centrifugoConfigRefusals(config)
    if (refusals.length > 0)
      return {
        ok: false,
        changes: [],
        diagnostics: [],
        refusal: refusals.join("\n"),
      }
    const data: SignalsConfigData = {
      config,
      environment: [
        SIGNAL_CONSUMER_ENV.dsn,
        SIGNAL_CONSUMER_ENV.notificationDsn,
      ],
    }
    return { ok: true, changes: [], diagnostics: [], data }
  },
})
