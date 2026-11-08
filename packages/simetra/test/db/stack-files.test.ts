import { spawnSync } from "node:child_process"
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { withStackLock } from "../../../../scripts/db-stack.mjs"

// Файли стека перевіряються як текст: межі безпеки (лише 127.0.0.1, піни
// образів, жодних секретів у конфігах) ламаються правкою файла, а не коду
const STACK_DIR = fileURLToPath(
  new URL("../../../../docker/postgres-stack/", import.meta.url)
)
const read = (name: string): string =>
  readFileSync(join(STACK_DIR, name), "utf8")

/**
 * Рядки-елементи списків `ports:` у compose-файлі, без лапок. Розбір по рядках
 * знає лише блочний список під голим `ports:`; будь-яку іншу форму ключа
 * (потоковий список, коментар, лапки) він відкидає, а не пропускає мовчки.
 */
function publishedPorts(compose: string): string[] {
  const ports: string[] = []
  let listIndent: number | undefined
  for (const line of compose.split(/\r?\n/)) {
    if (/^\s*["']?ports["']?\s*:/.test(line)) {
      const key = /^(\s*)ports:$/.exec(line)
      if (key === null)
        throw new Error(
          `compose.yaml: write ports as a bare "ports:" block list, got: ${line.trim()}`
        )
      listIndent = key[1]!.length
      continue
    }
    if (listIndent === undefined) continue
    const item = /^(\s*)-\s*(.+?)\s*$/.exec(line)
    if (item !== null && item[1]!.length > listIndent) {
      ports.push(item[2]!.replace(/^["']|["']$/g, ""))
      continue
    }
    if (line.trim() !== "" && !line.trim().startsWith("#"))
      listIndent = undefined
  }
  return ports
}

describe("compose.yaml of the postgres stack", () => {
  const compose = read("compose.yaml")

  it("names the compose project", () => {
    expect(compose).toMatch(/^name: simetra-pg$/m)
  })

  it("publishes every port on 127.0.0.1 only and never the Garage RPC port", () => {
    const ports = publishedPorts(compose)
    expect(ports.length).toBeGreaterThan(0)
    for (const port of ports) expect(port).toMatch(/^127\.0\.0\.1:\d+:\d+$/)
    expect(ports.some((p) => /:3901(:|$)/.test(p))).toBe(false)
  })

  it("has no network_mode", () => {
    expect(compose).not.toMatch(/^\s*["']?network_mode["']?\s*:/m)
  })
})

describe("images of the postgres stack", () => {
  // Свій образ (`simetra-pg/…`) збирається з Dockerfile; пін має його `FROM`
  const thirdParty = [
    ...[...read("compose.yaml").matchAll(/^\s*image:\s*(\S+)/gm)]
      .map((m) => m[1]!)
      .filter((image) => !image.startsWith("simetra-pg/")),
    ...[...read("Dockerfile").matchAll(/^FROM\s+(\S+)/gm)].map((m) => m[1]!),
  ]

  it("pins every third-party image by tag and digest", () => {
    expect(thirdParty.length).toBeGreaterThan(0)
    for (const image of thirdParty) {
      expect(image).toMatch(/^[^:@\s]+:[^:@\s]+@sha256:[0-9a-f]{64}$/)
      expect(image).not.toMatch(/:latest@/)
    }
  })
})

describe("centrifugo.json of the postgres stack", () => {
  const config: unknown = JSON.parse(read("centrifugo.json"))

  function keys(value: unknown): string[] {
    if (Array.isArray(value)) return value.flatMap(keys)
    if (value === null || typeof value !== "object") return []
    return Object.entries(value).flatMap(([k, v]) => [k, ...keys(v)])
  }

  it("has no insecure, admin or anonymous options and no allow_*_for_*", () => {
    const all = keys(config)
    expect(all).not.toContain("insecure")
    expect(all).not.toContain("admin")
    expect(all).not.toContain("allow_anonymous_connect_without_token")
    expect(all.filter((k) => /^allow_.+_for_/.test(k))).toEqual([])
  })

  it("disables the HTTP API", () => {
    expect(config).toMatchObject({ http_api: { disabled: true } })
  })

  // До ПГ-4 немає таблиці outbox і JWKS (Р7): споживач і перевірка токенів
  // з'являються разом із генератором конфігу
  it("has no outbox consumer and no client token yet", () => {
    expect(config).not.toHaveProperty("consumers")
    expect(config).not.toHaveProperty(["client", "token"])
  })

  it("enables the health endpoint", () => {
    expect(config).toMatchObject({ health: { enabled: true } })
  })

  it.each(["simetra", "simetra-rights", "simetra-user"])(
    "namespace %s keeps history and forces recovery",
    (name) => {
      const { namespaces } = (
        config as { channel: { namespaces: Record<string, unknown>[] } }
      ).channel
      const ns = namespaces.find((n) => n.name === name)
      expect(ns).toMatchObject({
        history_ttl: expect.any(String),
        force_recovery: true,
      })
      expect(ns?.history_size).toBeGreaterThan(0)
    }
  )
})

describe("garage.toml of the postgres stack", () => {
  it("holds no secrets: they come from dev-secrets.env", () => {
    const toml = read("garage.toml")
    expect(toml).not.toMatch(/^\s*rpc_secret\s*=/m)
    expect(toml).not.toMatch(/^\s*admin_token\s*=/m)
  })
})

describe("withStackLock", () => {
  let dir: string
  let lock: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "simetra-stack-lock-"))
    lock = join(dir, "stack.lock")
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it("runs fn under a free lock in the guard's format and removes it after", async () => {
    let content = ""
    await withStackLock(lock, async () => {
      content = readFileSync(lock, "utf8")
    })
    expect(content.split("\n").slice(0, 2)).toEqual([
      String(process.pid),
      process.cwd(),
    ])
    expect(existsSync(lock)).toBe(false)
  })

  it("refuses a lock of a live foreign pid without calling fn", async () => {
    // Батько процесу тесту живий весь час тесту
    const holder = `${process.ppid}\n/elsewhere\n2026-01-01T00:00:00.000Z\n`
    writeFileSync(lock, holder)
    const fn = vi.fn(async () => {})
    await expect(withStackLock(lock, fn)).rejects.toThrow(
      `postgres stack is in use by PID ${process.ppid}`
    )
    expect(fn).not.toHaveBeenCalled()
    expect(readFileSync(lock, "utf8")).toBe(holder)
  })

  it("takes over a lock of a dead pid", async () => {
    // pid процесу, що вже завершився: такого живого процесу немає
    const dead = spawnSync(process.execPath, ["-e", ""]).pid
    writeFileSync(lock, `${dead}\n/elsewhere\n2026-01-01T00:00:00.000Z\n`)
    const fn = vi.fn(async () => {})
    await withStackLock(lock, fn)
    expect(fn).toHaveBeenCalledOnce()
    expect(existsSync(lock)).toBe(false)
  })

  it("removes the lock when fn throws", async () => {
    await expect(
      withStackLock(lock, async () => {
        throw new Error("boom")
      })
    ).rejects.toThrow("boom")
    expect(existsSync(lock)).toBe(false)
  })
})
