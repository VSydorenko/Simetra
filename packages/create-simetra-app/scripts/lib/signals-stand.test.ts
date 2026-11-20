import { describe, expect, it } from "vitest"
import { SIGNALS_JWKS_PATH } from "simetra/server/signals"
import {
  centrifugoConfig,
  centrifugoConfigRefusals,
} from "../../../designer/src/tools/signals-config"
import { appDsns } from "./app-database.mts"
import {
  centrifugoImage,
  generateSigningKeys,
  redactPassword,
  signalsContainer,
  signalsDsn,
  templateProjectName,
} from "./signals-stand.mts"

const SUPERUSER = "postgres://postgres:super@127.0.0.1:5432/postgres"
const SECRETS = {
  SIMETRA_OWNER_DEV_PASSWORD: "owner-pw",
  SIMETRA_AUTH_DEV_PASSWORD: "auth-pw",
  SIMETRA_RUNTIME_DEV_PASSWORD: "runtime-pw",
  SIMETRA_SIGNALS_DEV_PASSWORD: "signals-secret-pw",
}
const ORIGIN = "http://127.0.0.1:4123"

const container = (database = "app_db") =>
  signalsContainer({
    name: "c",
    labels: ["--label", "a=b"],
    projectName: templateProjectName(),
    origin: ORIGIN,
    hostPort: 4123,
    port: 8123,
    databaseUrl: signalsDsn(SUPERUSER, database, SECRETS),
    configDir: "/tmp/x",
    image: "img",
  })

describe("signalsContainer (І9)", () => {
  it("config accepts the tokens of this host: project name, origin, own JWKS", () => {
    const { config } = container()
    expect(config).toEqual(
      centrifugoConfig({
        projectName: "TemplateApp",
        origin: ORIGIN,
        issuer: ORIGIN,
        jwksUrl: `http://127.0.0.1:4123${SIGNALS_JWKS_PATH}`,
      })
    )
    expect(centrifugoConfigRefusals(config)).toEqual([])
  })

  it("the consumer DSN leads to the application database as simetra_signals", () => {
    const dsn = new URL(
      container("app_db").env
        .CENTRIFUGO_CONSUMERS_SIMETRA_OUTBOX_POSTGRESQL_DSN!
    )
    expect(dsn.pathname).toBe("/app_db")
    expect(dsn.username).toBe("simetra_signals")
    // Той самий хост і база, що й DSN ролей застосунку
    const app = new URL(
      appDsns(SUPERUSER, "app_db", SECRETS).SIMETRA_RUNTIME_DATABASE_URL
    )
    expect([dsn.host, dsn.pathname]).toEqual([app.host, app.pathname])
  })

  it("the password lives only in the container environment", () => {
    const { args, config, env } = container()
    expect(
      Object.values(env).filter((v) => v.includes("signals-secret-pw"))
    ).toHaveLength(2)
    expect(args.join(" ")).not.toContain("signals-secret-pw")
    expect(JSON.stringify(config)).not.toContain("signals-secret-pw")
    // argv несе лише імена змінних
    expect(args).toContain("CENTRIFUGO_CONSUMERS_SIMETRA_OUTBOX_POSTGRESQL_DSN")
  })

  it("binds HTTP to loopback and uses the host network", () => {
    const { env, args } = container()
    expect(env.CENTRIFUGO_HTTP_SERVER_ADDRESS).toBe("127.0.0.1")
    expect(args).toContain("host")
  })
})

describe("generateSigningKeys (Р3)", () => {
  it("gives a fresh Ed25519 pair and a new kid on every call", async () => {
    const a = await generateSigningKeys(new Date("2026-01-01T00:00:00Z"))
    const b = await generateSigningKeys()
    expect(a.kid).not.toBe(b.kid)
    const [key] = JSON.parse(a.json) as {
      kid: string
      privateJwk: Record<string, string>
      addedAt: string
    }[]
    expect(key!.kid).toBe(a.kid)
    expect(key!.addedAt).toBe("2026-01-01T00:00:00.000Z")
    expect(Object.keys(key!.privateJwk).sort()).toEqual([
      "crv",
      "d",
      "kty",
      "x",
    ])
    expect(key!.privateJwk.crv).toBe("Ed25519")
  })
})

describe("centrifugoImage", () => {
  it("is the digest-pinned image of the stack compose file", () => {
    expect(centrifugoImage()).toMatch(
      /^centrifugo\/centrifugo:v[\d.]+@sha256:[0-9a-f]{64}$/
    )
  })
})

describe("redactPassword", () => {
  it("removes the DSN password from logs, raw and decoded", () => {
    const dsn = "postgres://simetra_signals:p%40ss@127.0.0.1:5432/app"
    const logs = "dial postgres://simetra_signals:p%40ss@h/app failed, p@ss"
    const out = redactPassword(logs, dsn)
    expect(out).not.toContain("p%40ss")
    expect(out).not.toContain("p@ss")
    expect(out).toContain("failed")
  })
})
