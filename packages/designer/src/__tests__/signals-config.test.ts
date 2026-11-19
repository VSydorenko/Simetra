import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SIGNAL_MERGE_THRESHOLD } from "simetra/model"
import { afterEach, describe, expect, it } from "vitest"
import { renderResult } from "../cli/render"
import { toolByName } from "../tools/catalog"
import { invoke } from "../tools/invoke"
import {
  centrifugoConfig,
  centrifugoConfigRefusals,
  SIGNAL_CONSUMER_ENV,
  type CentrifugoConfig,
  SIGNAL_HISTORY_SIZE,
  type SignalsConfigData,
} from "../tools/signals-config"
import { opts } from "./helpers/catalog"

const INPUT = {
  projectName: "Acme",
  origin: "https://app.example.com",
  issuer: "https://app.example.com",
  jwksUrl: "http://app:3000/simetra/signals/jwks",
}

type Config = CentrifugoConfig

const mutated = (change: (c: Config) => void): Config => {
  const config = structuredClone(centrifugoConfig(INPUT))
  change(config)
  return config
}

// Опція поза типом конфігу: саме такі білий список і мусить відкинути
const add = (target: object, key: string, value: unknown): void => {
  Object.assign(target, { [key]: value })
}
const ns = (c: Config, name: string) =>
  c.channel.namespaces.find((n) => n.name === name)!
const postgresql = (c: Config) => c.consumers[0]!.postgresql

describe("centrifugoConfig", () => {
  it("passes its own refusals", () => {
    expect(centrifugoConfigRefusals(centrifugoConfig(INPUT))).toEqual([])
  })

  it("builds the audience from the project name and takes the inputs as given", () => {
    expect(centrifugoConfig(INPUT)).toMatchObject({
      client: {
        allowed_origins: [INPUT.origin],
        token: {
          jwks_public_endpoint: INPUT.jwksUrl,
          audience: "centrifugo:Acme",
          issuer: INPUT.issuer,
        },
      },
    })
  })

  it("names the outbox consumer with empty DSNs and no listener", () => {
    const config = centrifugoConfig(INPUT)
    expect(config.consumers).toEqual([
      expect.objectContaining({ name: "simetra_outbox", type: "postgresql" }),
    ])
    expect(postgresql(config)).toMatchObject({
      dsn: "",
      partition_notification_dsn: "",
      outbox_table_name: "simetra.signal_outbox",
      partition_notification_channel: "simetra_signal_outbox",
    })
    expect(config).not.toHaveProperty("http_server")
    expect(config).toMatchObject({ log: { level: "info" } })
  })

  // Р23: поріг злиття + 1 (`invalidate`) вміщується в історію простору `simetra`
  it("the default merge threshold + 1 fits the history of namespace simetra", () => {
    const size = ns(centrifugoConfig(INPUT), "simetra").history_size
    expect(size).toBe(SIGNAL_HISTORY_SIZE)
    expect(SIGNAL_MERGE_THRESHOLD + 1).toBeLessThanOrEqual(size)
  })
})

describe("centrifugoConfigRefusals: every mutation of invariant 11 is refused", () => {
  it.each<[string, (c: Config) => void]>([
    [
      "a top-level option outside the whitelist",
      (c) => add(c, "engine", { type: "redis" }),
    ],
    ["http_server", (c) => add(c, "http_server", { address: "0.0.0.0" })],
    ["grpc_api", (c) => add(c, "grpc_api", { enabled: true })],
    ["admin", (c) => add(c, "admin", { enabled: true })],
    ["client.insecure", (c) => add(c.client, "insecure", true)],
    [
      "anonymous connect",
      (c) => add(c.client, "allow_anonymous_connect_without_token", true),
    ],
    [
      "hmac_secret_key",
      (c) => add(c.client.token, "hmac_secret_key", "secret"),
    ],
    ["audience_regex", (c) => add(c.client.token, "audience_regex", ".*")],
    ["allowed_origins *", (c) => (c.client.allowed_origins = ["*"])],
    [
      "an origin with a path",
      (c) => (c.client.allowed_origins = ["https://a.example/x"]),
    ],
    ["no origin", (c) => (c.client.allowed_origins = [])],
    ["no audience", (c) => Reflect.deleteProperty(c.client.token, "audience")],
    ["no issuer", (c) => (c.client.token.issuer = "")],
    ["http_api enabled", (c) => add(c.http_api, "disabled", false)],
    ["an http_api key", (c) => add(c.http_api, "key", "k")],
    [
      "client publish",
      (c) => add(ns(c, "simetra"), "allow_publish_for_client", true),
    ],
    [
      "subscribe without a channel token",
      (c) => add(ns(c, "simetra"), "allow_subscribe_for_client", true),
    ],
    [
      "history for subscribers",
      (c) => add(ns(c, "simetra-user"), "allow_history_for_subscriber", true),
    ],
    [
      "presence for subscribers",
      (c) =>
        add(ns(c, "simetra-rights"), "allow_presence_for_subscriber", true),
    ],
    ["presence", (c) => add(ns(c, "simetra"), "presence", true)],
    [
      "an option in without_namespace",
      (c) => add(c.channel.without_namespace, "allow_publish_for_client", true),
    ],
    [
      "force_recovery off",
      (c) => add(ns(c, "simetra"), "force_recovery", false),
    ],
    [
      "history_size below the merge threshold + 1",
      (c) => (ns(c, "simetra").history_size = SIGNAL_MERGE_THRESHOLD),
    ],
    [
      "an extra namespace",
      (c) => c.channel.namespaces.push({ ...ns(c, "simetra"), name: "other" }),
    ],
    ["a missing namespace", (c) => c.channel.namespaces.pop()],
    ["channel max_length over 255", (c) => add(c.channel, "max_length", 256)],
    [
      "a password in the DSN",
      (c) =>
        add(postgresql(c), "dsn", "postgresql://simetra_signals:pw@db/app"),
    ],
    [
      "a password in the notification DSN",
      (c) =>
        add(
          postgresql(c),
          "partition_notification_dsn",
          "postgresql://simetra_signals:pw@db/app"
        ),
    ],
    [
      "another outbox table",
      (c) => add(postgresql(c), "outbox_table_name", "public.t"),
    ],
    ["use_try_lock off", (c) => add(postgresql(c), "use_try_lock", false)],
    ["a second consumer", (c) => c.consumers.push(c.consumers[0]!)],
    ["a disabled consumer", (c) => add(c.consumers[0]!, "enabled", false)],
    ["health off", (c) => add(c.health, "enabled", false)],
    ["debug logging", (c) => add(c.log, "level", "debug")],
  ])("%s", (_title, change) => {
    expect(centrifugoConfigRefusals(mutated(change))).not.toEqual([])
  })

  it("names the path of the refused option", () => {
    expect(
      centrifugoConfigRefusals(mutated((c) => add(c.client, "insecure", true)))
    ).toEqual(["config.client.insecure: not an allowed option"])
  })

  it("refuses a value that is not an object", () => {
    expect(centrifugoConfigRefusals(null)).toEqual([
      "config: expected an object",
    ])
  })
})

// Межа відкликання (спека профілю §6.2): TTL токена каналу + 25 с + 5 с
describe("centrifugoConfigRefusals: the revocation bound", () => {
  const client = () => centrifugoConfig(INPUT).client

  it("writes the expiry close delays and the presence tick explicitly", () => {
    expect(client()).toMatchObject({
      presence_update_interval: "5s",
      expired_sub_close_delay: "25s",
      expired_close_delay: "25s",
    })
  })

  it.each([
    ["presence_update_interval", "4s"],
    ["presence_update_interval", "500ms"],
    ["expired_sub_close_delay", "10s"],
    ["expired_close_delay", "10s"],
  ] as const)("accepts %s %s", (key, value) => {
    const c = centrifugoConfig(INPUT)
    c.client[key] = value
    expect(centrifugoConfigRefusals(c)).toEqual([])
  })

  it.each([
    ["presence_update_interval", "30s"],
    ["presence_update_interval", "6s"],
    ["presence_update_interval", "1m"],
    ["presence_update_interval", "0s"],
    ["presence_update_interval", "5"],
    ["expired_sub_close_delay", "30s"],
    ["expired_sub_close_delay", "1h"],
    ["expired_close_delay", "30s"],
    ["expired_close_delay", "26s"],
    ["expired_close_delay", "0s"],
  ] as const)("refuses %s %s", (key, value) => {
    const c = centrifugoConfig(INPUT)
    c.client[key] = value
    expect(centrifugoConfigRefusals(c)).toEqual([
      `config.client.${key}: must be a positive duration not above ${key === "presence_update_interval" ? "5s" : "25s"}`,
    ])
  })

  it.each([
    "presence_update_interval",
    "expired_sub_close_delay",
    "expired_close_delay",
  ] as const)(
    "refuses a config without %s (the image default would apply)",
    (key) => {
      const c = centrifugoConfig(INPUT)
      Reflect.deleteProperty(c.client, key)
      expect(centrifugoConfigRefusals(c)).toEqual([
        `config.client.${key}: missing`,
      ])
    }
  )
})

describe("centrifugoConfigRefusals: jwksUrl", () => {
  const refused = (jwksUrl: string) =>
    centrifugoConfigRefusals(centrifugoConfig({ ...INPUT, jwksUrl }))

  it.each([
    "https://auth.example.com/simetra/signals/jwks",
    "http://127.0.0.1:3000/simetra/signals/jwks",
    "http://localhost:3000/simetra/signals/jwks",
    "http://[::1]:3000/simetra/signals/jwks",
    "http://app:3000/simetra/signals/jwks",
  ])("accepts %s", (url) => {
    expect(refused(url)).toEqual([])
  })

  it.each([
    "http://auth.example.com/simetra/signals/jwks",
    "http://10.0.0.5:3000/simetra/signals/jwks",
    "http://user:pw@127.0.0.1:3000/simetra/signals/jwks",
    "ftp://127.0.0.1/jwks",
    "not a url",
  ])("refuses %s", (url) => {
    expect(refused(url)).toEqual([
      expect.stringMatching(/^config\.client\.token\.jwks_public_endpoint: /),
    ])
  })
})

describe("the signals-config tool", () => {
  const dirs: string[] = []
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true })))
  })
  const projectDir = async (file?: object): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "simetra-signals-config-"))
    dirs.push(dir)
    if (file !== undefined)
      await writeFile(join(dir, "project.meta.json"), JSON.stringify(file))
    return dir
  }
  const tool = toolByName("signals-config")!
  const input = {
    origin: INPUT.origin,
    issuer: INPUT.issuer,
    jwksUrl: INPUT.jwksUrl,
  }

  it("reads neither files to write nor a database", () => {
    expect(tool).toMatchObject({
      files: "read",
      database: "none",
      data: "none",
    })
  })

  it("generates the config of the project and names both DSN variables", async () => {
    const dir = await projectDir({
      name: "Acme",
      database: { provider: "postgres" },
    })
    const r = await invoke(tool, input, opts(dir))
    expect(r.ok).toBe(true)
    expect(r.written).toBe(false)
    expect(r.data).toEqual({
      config: centrifugoConfig(INPUT),
      environment: [
        SIGNAL_CONSUMER_ENV.dsn,
        SIGNAL_CONSUMER_ENV.notificationDsn,
      ],
    } satisfies SignalsConfigData)
    expect(tool.description).toContain(SIGNAL_CONSUMER_ENV.dsn)
    expect(tool.description).toContain(SIGNAL_CONSUMER_ENV.notificationDsn)
    const text = renderResult(tool, r, { dir, locale: "en", format: "text" })
    expect(JSON.parse(text.stdout)).toEqual(centrifugoConfig(INPUT))
    const json = renderResult(tool, r, { dir, locale: "en", format: "json" })
    expect(JSON.parse(json.stdout)).toMatchObject({
      ok: true,
      environment: [
        SIGNAL_CONSUMER_ENV.dsn,
        SIGNAL_CONSUMER_ENV.notificationDsn,
      ],
    })
  })

  it("refuses an http: JWKS address on an external host", async () => {
    const dir = await projectDir({
      name: "Acme",
      database: { provider: "postgres" },
    })
    const r = await invoke(
      tool,
      { ...input, jwksUrl: "http://auth.example.com/jwks" },
      opts(dir)
    )
    expect(r.ok).toBe(false)
    expect(r.refusal).toMatchObject({
      reason: "refused",
      message: expect.stringContaining("jwks_public_endpoint"),
    })
  })

  it("reports a missing project file", async () => {
    const r = await invoke(tool, input, opts(await projectDir()))
    expect(r.ok).toBe(false)
    expect(r.diagnostics.map((d) => d.code)).toEqual(["project.missing"])
  })
})
