import {
  type ChildProcess,
  spawn,
  type SpawnOptions,
  spawnSync,
} from "node:child_process"
import { createHmac, createHash } from "node:crypto"
import { EventEmitter } from "node:events"
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { fileURLToPath } from "node:url"
import {
  PLATFORM_LOGIN_ROLES,
  PROVIDER_LOGIN_ROLES,
  PROVIDER_OWNER_ROLES,
} from "simetra/model"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  betterAuthCommand,
  passwordMatches,
  POSTGRES_LOCK_FILE,
  POSTGRES_LOCK_PATH,
  POSTGRES_PSQL_ARGS,
  runChild,
  scramKeys,
  STACK_LOCK_ENV,
  stackFilesHash,
  startPostgres,
  withStackLock,
} from "../../../../scripts/db-stack.mjs"
import { TEST_STACKS } from "./profile"
import { lockPath } from "./stack-guard"

// Файли стека перевіряються як текст: межі безпеки (лише 127.0.0.1, піни
// образів, жодних секретів у конфігах) ламаються правкою файла, а не коду
const dockerDir = (name: string): string =>
  fileURLToPath(new URL(`../../../../docker/${name}/`, import.meta.url))
const STACK_DIR = dockerDir("postgres-stack")
const read = (name: string, dir = STACK_DIR): string =>
  readFileSync(join(dir, name), "utf8")

// Стек `postgres` і Centrifugo поруч зі стеком Supabase мають однакові межі
// безпеки, тому спільні перевірки йдуть по обох теках
const STACKS = [
  { title: "postgres stack", dir: STACK_DIR, project: "simetra-pg" },
  {
    title: "supabase-signals stack",
    dir: dockerDir("supabase-signals"),
    project: "simetra-sb",
  },
]

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

describe.each(STACKS)("compose.yaml of the $title", ({ dir, project }) => {
  const compose = read("compose.yaml", dir)

  it("names the compose project", () => {
    expect(compose).toMatch(new RegExp(`^name: ${project}$`, "m"))
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

  it("pins the Centrifugo image by tag and digest", () => {
    const [image] = [...compose.matchAll(/^\s*image:\s*(centrifugo\S+)/gm)]
    expect(image?.[1]).toMatch(/^[^:@\s]+:[^:@\s]+@sha256:[0-9a-f]{64}$/)
  })
})

it("pins one Centrifugo image in both stacks", () => {
  const images = STACKS.map(
    ({ dir }) =>
      /^\s*image:\s*(centrifugo\S+)/m.exec(read("compose.yaml", dir))?.[1]
  )
  expect(new Set(images).size).toBe(1)
})

it("publishes the Centrifugo of the Supabase stack on its own port", () => {
  const [, signals] = STACKS
  expect(publishedPorts(read("compose.yaml", signals!.dir))).toEqual([
    "127.0.0.1:8101:8000",
  ])
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

describe.each(STACKS)("centrifugo.json of the $title", ({ dir }) => {
  const config: unknown = JSON.parse(read("centrifugo.json", dir))

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

describe("Simetra identity of the postgres stack", () => {
  const script = readFileSync(
    fileURLToPath(new URL("../../../../scripts/db-stack.mjs", import.meta.url)),
    "utf8"
  )
  const secretNames = [
    "SIMETRA_OWNER_DEV_PASSWORD",
    "SIMETRA_RUNTIME_DEV_PASSWORD",
    "SIMETRA_AUTH_DEV_PASSWORD",
  ]

  it("the stack project file selects the postgres provider", () => {
    expect(JSON.parse(read("project/project.meta.json"))).toMatchObject({
      database: { provider: "postgres" },
    })
  })

  it("login-secrets.env holds a password for each login role", () => {
    const secrets = read("login-secrets.env")
    for (const name of secretNames)
      expect(secrets).toMatch(new RegExp(`^${name}=\\S+$`, "m"))
  })

  // Усе з `env_file` потрапляє в середовище контейнера
  it("dev-secrets.env holds no login password and compose reads only GARAGE_ keys", () => {
    const garage = read("dev-secrets.env")
    for (const name of secretNames) expect(garage).not.toContain(name)
    const files = [
      ...read("compose.yaml").matchAll(/^\s*env_file:\s*(\S+)\s*$/gm),
    ].map((m) => m[1]!)
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      expect(file).not.toContain("login-secrets")
      const keys = [...read(file).matchAll(/^([A-Z0-9_]+)=/gm)].map(
        (m) => m[1]!
      )
      expect(keys.length).toBeGreaterThan(0)
      for (const key of keys) expect(key).toMatch(/^GARAGE_/)
    }
    expect(read("compose.yaml")).not.toContain("login-secrets")
  })

  // Імена в скрипті без залежностей — літерали; тест тримає їх рівними даним T0
  it("the script names the login roles of the T0 data and a secret for each", () => {
    for (const role of [
      PROVIDER_OWNER_ROLES.postgres,
      PROVIDER_LOGIN_ROLES.postgres[0],
      PLATFORM_LOGIN_ROLES.runtime,
    ])
      expect(script).toContain(`role: "${role}"`)
    for (const name of secretNames) expect(script).toContain(`"${name}"`)
  })

  it("passes passwords through stdin and DSNs through the environment, never argv", () => {
    const secrets = Object.fromEntries(
      [...read("login-secrets.env").matchAll(/^([A-Z0-9_]+)=(\S+)$/gm)].map(
        (m) => [m[1]!, m[2]!]
      )
    )
    const passwords = secretNames.map((name) => secrets[name]!)
    expect(passwords).toHaveLength(secretNames.length)
    const step = betterAuthCommand(secrets, "postgresql://postgres@h/simetra")
    // argv у `ps`: ні psql, ні дочірній процес Better Auth не несуть паролів чи DSN
    const argvs = [POSTGRES_PSQL_ARGS, step.args]
    for (const argv of argvs)
      for (const arg of argv) {
        for (const password of passwords) expect(arg).not.toContain(password)
        expect(arg).not.toMatch(/PASSWORD|postgresql:\/\/|login-secrets/)
      }
    expect(step.env.SIMETRA_AUTH_URL).toContain(
      secrets.SIMETRA_AUTH_DEV_PASSWORD
    )
    expect(script).toContain("SIMETRA_SUPERUSER_URL")
    expect(script).toContain("SIMETRA_AUTH_URL")
  })
})

describe("withStackLock", () => {
  // Команда стека й DB-прогін мусять брати один замок: інакше `stop` зупинив
  // би стек посеред прогону
  it("the script locks the same file as the guard of the postgres stack", () => {
    expect(POSTGRES_LOCK_FILE).toBe(TEST_STACKS.postgres.lockFile)
  })

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

describe("stack lock path", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  // Сесії з різним TMPDIR інакше брали б різні файли й не виключали б одна одну
  it("is /tmp/<lockFile> in the script and in the guard whatever TMPDIR is", () => {
    vi.stubEnv("TMPDIR", "/var/tmp/some-session")
    expect(POSTGRES_LOCK_PATH).toBe(`/tmp/${TEST_STACKS.postgres.lockFile}`)
    expect(lockPath("postgres")).toBe(POSTGRES_LOCK_PATH)
    expect(lockPath("supabase")).toBe(`/tmp/${TEST_STACKS.supabase.lockFile}`)
  })

  it("withStackLock names the held lock to its children only while fn runs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "simetra-stack-lock-"))
    try {
      const lock = join(dir, "stack.lock")
      let seen: string | undefined
      await withStackLock(lock, async () => {
        seen = process.env[STACK_LOCK_ENV]
      })
      expect(seen).toBe(lock)
      expect(process.env[STACK_LOCK_ENV]).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("better-auth-cli refuses to run outside the stack lock", () => {
    const env = { ...process.env }
    delete env[STACK_LOCK_ENV]
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        fileURLToPath(new URL("./better-auth-cli.ts", import.meta.url)),
      ],
      {
        cwd: fileURLToPath(new URL("../../", import.meta.url)),
        encoding: "utf8",
        env: {
          ...env,
          SIMETRA_SUPERUSER_URL: "postgresql://postgres@127.0.0.1:1/simetra",
          SIMETRA_AUTH_URL: "postgresql://simetra_auth@127.0.0.1:1/simetra",
        },
      }
    )
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(STACK_LOCK_ENV)
  })
})

/** Дочірній процес вузла, що друкує `ready` і живе, доки його не вб'ють. */
function realChild(
  onTerm: string
): (
  command: string,
  args: readonly string[],
  options: SpawnOptions
) => ChildProcess {
  return (_command, _args, options) =>
    spawn(
      process.execPath,
      [
        "-e",
        `process.on("SIGTERM", () => { process.stdout.write("TERM\\n"); ${onTerm} });
         setInterval(() => {}, 1000);
         process.stdout.write("ready\\n")`,
      ],
      options
    )
}

describe("runChild", () => {
  it("starts the child detached, in its own process group", async () => {
    let options: SpawnOptions | undefined
    const code = await runChild("x", [], {}, (command, args, o) => {
      options = o
      return spawn(process.execPath, ["-e", ""], o)
    })
    expect(code).toBe(0)
    expect(options?.detached).toBe(true)
  })

  it("forwards a signal of the script to the child's group exactly once", async () => {
    const signals = new EventEmitter()
    let out = ""
    let ready!: () => void
    const started = new Promise<void>((resolve) => (ready = resolve))
    const done = runChild(
      "x",
      [],
      {
        signals,
        onStdout: (chunk: string) => {
          out += chunk
          if (out.includes("ready")) ready()
        },
      },
      realChild("setTimeout(() => process.exit(0), 200)")
    )
    await started
    signals.emit("SIGTERM", "SIGTERM")
    signals.emit("SIGTERM", "SIGTERM")
    signals.emit("SIGINT", "SIGINT")
    expect(await done).toBe(0)
    expect(out.match(/TERM/g)).toHaveLength(1)
  })

  it("a child that ignores the signal holds the lock until its group is killed after the limit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "simetra-stack-lock-"))
    try {
      const lock = join(dir, "stack.lock")
      const signals = new EventEmitter()
      let ready!: () => void
      const started = new Promise<void>((resolve) => (ready = resolve))
      let code: number | undefined
      const run = withStackLock(lock, async () => {
        code = await runChild(
          "x",
          [],
          {
            signals,
            killAfterMs: 400,
            onStdout: (chunk: string) => {
              if (chunk.includes("ready")) ready()
            },
          },
          realChild("")
        )
      })
      await started
      const signalled = Date.now()
      signals.emit("SIGTERM", "SIGTERM")
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(existsSync(lock)).toBe(true)
      await run
      expect(Date.now() - signalled).toBeGreaterThanOrEqual(400)
      expect(code).toBe(128 + 9)
      expect(existsSync(lock)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// RFC 7677 §3: користувач `user`, пароль `pencil`
const RFC7677 = {
  salt: "W22ZaJ0SNY7soEsUEjb6gQ==",
  iterations: 4096,
  authMessage:
    "n=user,r=rOprNGfwEbeRWgbNEkqO,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096,c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0",
  proof: "dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=",
  serverSignature: "6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=",
}

const verifierOf = (password: string, salt = RFC7677.salt): string => {
  const keys = scramKeys(password, salt, 4096)
  return `SCRAM-SHA-256$4096:${salt}$${keys.storedKey}:${keys.serverKey}`
}

describe("SCRAM verifier check of a login role's password", () => {
  // Сервер так само перевіряє доказ клієнта: H(proof XOR HMAC(StoredKey, AM)) = StoredKey
  it("derives the keys of the RFC 7677 test vector", () => {
    const { storedKey, serverKey } = scramKeys(
      "pencil",
      RFC7677.salt,
      RFC7677.iterations
    )
    const hmac = (key: string, msg: string): Buffer =>
      createHmac("sha256", Buffer.from(key, "base64")).update(msg).digest()
    const signature = hmac(storedKey, RFC7677.authMessage)
    const proof = Buffer.from(RFC7677.proof, "base64")
    const clientKey = proof.map((b, i) => b ^ signature[i]!)
    expect(createHash("sha256").update(clientKey).digest("base64")).toBe(
      storedKey
    )
    expect(hmac(serverKey, RFC7677.authMessage).toString("base64")).toBe(
      RFC7677.serverSignature
    )
  })

  it.each([
    ["the same password", verifierOf("pencil"), true],
    ["another password", verifierOf("pen"), false],
    ["no password", "", false],
    ["an md5 password", "md5" + "0".repeat(32), false],
    ["a malformed verifier", "SCRAM-SHA-256$x", false],
  ])("%s → %s", (_title, verifier, expected) => {
    expect(passwordMatches(verifier, "pencil")).toBe(expected)
  })
})

type Call = {
  command: string
  args: readonly string[]
  options: SpawnOptions
  input: string
}

type Reply = { code?: number; stdout?: string }

const SERVICES = ["postgres", "garage", "centrifugo"] as const
const garageKeyId = /^GARAGE_DEV_KEY_ID=(\S+)$/m.exec(
  read("dev-secrets.env")
)![1]!
const loginSecrets = Object.fromEntries(
  [...read("login-secrets.env").matchAll(/^([A-Z0-9_]+)=(\S+)$/gm)].map((m) => [
    m[1]!,
    m[2]!,
  ])
)

/**
 * Підставний `spawn`: записує виклики й відповідає як стек. `running` — чи є
 * контейнери проєкту; `labels` — мітки контейнерів, типово такі, що збігаються.
 */
function fakeStack(
  o: {
    running?: boolean
    labels?: Partial<Record<(typeof SERVICES)[number], Record<string, string>>>
    verifiers?: Record<string, string>
    fail?: (call: Call) => boolean
  } = {}
) {
  const calls: Call[] = []
  const hashes = { postgres: "hp", garage: "hg", centrifugo: "hc" }
  const reply = (call: Call): Reply => {
    const { args } = call
    if (o.fail?.(call) === true) return { code: 1 }
    if (args.includes("config"))
      return {
        stdout: SERVICES.map((s) => `${s} ${hashes[s]}\n`).join(""),
      }
    if (args.includes("ps"))
      return { stdout: o.running === true ? "id-1\nid-2\nid-3\n" : "" }
    if (call.command === "docker" && args[0] === "inspect")
      return {
        stdout: JSON.stringify(
          SERVICES.map((s) => ({
            Config: {
              Labels: {
                "com.docker.compose.service": s,
                "com.docker.compose.config-hash": hashes[s],
                ...(s === "postgres"
                  ? { "simetra.stack-files-hash": stackFilesHash() }
                  : {}),
                ...o.labels?.[s],
              },
            },
          }))
        ),
      }
    const api = args.indexOf("json-api")
    if (api >= 0)
      return {
        stdout: JSON.stringify(
          {
            GetClusterStatus: { nodes: [{ id: "n1", role: { zone: "dc1" } }] },
            ListKeys: [{ id: garageKeyId }],
            ListBuckets: [{ globalAliases: ["simetra-dev"] }],
            GetBucketInfo: {
              keys: [
                {
                  accessKeyId: garageKeyId,
                  permissions: { read: true, write: true, owner: true },
                },
              ],
            },
          }[args[api + 1]!]
        ),
      }
    if (call.input.includes("pg_authid"))
      return {
        stdout: Object.entries(o.verifiers ?? {})
          .map(([role, v]) => `${role}|${v}\n`)
          .join(""),
      }
    return {}
  }
  const spawnFn = (
    command: string,
    args: readonly string[],
    options: SpawnOptions
  ): ChildProcess => {
    const child = new EventEmitter() as ChildProcess
    const stdio = options.stdio as string[]
    const stdin = new PassThrough()
    const stdout = stdio[1] === "pipe" ? new PassThrough() : null
    Object.assign(child, { pid: 2 ** 22 + 1, stdin, stdout })
    const call: Call = { command, args, options, input: "" }
    calls.push(call)
    stdin.on("data", (chunk: Buffer) => (call.input += chunk.toString()))
    const inputDone =
      stdio[0] === "pipe"
        ? new Promise((resolve) => stdin.on("end", resolve))
        : Promise.resolve()
    void inputDone.then(() => {
      const r = reply(call)
      stdout?.end(r.stdout ?? "")
      setImmediate(() => child.emit("close", r.code ?? 0, null))
    })
    return child
  }
  const ups = () => calls.filter((c) => c.args.includes("up"))
  const psqls = () =>
    calls.filter((c) => c.args.includes("exec") && c.args.includes("psql"))
  return { calls, spawnFn, ups, psqls }
}

const start = (stack: ReturnType<typeof fakeStack>, noBuild = false) =>
  startPostgres({
    spawnFn: stack.spawnFn,
    signals: new EventEmitter(),
    noBuild,
  })

describe("startPostgres", () => {
  const script = readFileSync(
    fileURLToPath(new URL("../../../../scripts/db-stack.mjs", import.meta.url)),
    "utf8"
  )

  it("db-stack.mjs has no STACK_DIR alias", () => {
    expect(script).not.toMatch(/\bSTACK_DIR\b/)
  })

  it("starts a fresh stack with --build and the stack-files hash as the build argument", async () => {
    const stack = fakeStack()
    await start(stack)
    const [up, ...more] = stack.ups()
    expect(more).toEqual([])
    expect(up!.args.slice(up!.args.indexOf("up"))).toEqual([
      "up",
      "-d",
      "--wait",
      "--build",
    ])
    expect(
      (up!.options.env as Record<string, string>).SIMETRA_STACK_FILES_HASH
    ).toBe(stackFilesHash())
  })

  it("starts a fresh stack without --build under --no-build", async () => {
    const stack = fakeStack()
    await start(stack, true)
    const [up] = stack.ups()
    expect(up!.args.slice(up!.args.indexOf("up"))).toEqual([
      "up",
      "-d",
      "--wait",
    ])
  })

  it("passes --no-recreate and no --build on a running stack of this branch", async () => {
    const stack = fakeStack({ running: true })
    await start(stack)
    const [up] = stack.ups()
    expect(up!.args.slice(up!.args.indexOf("up"))).toEqual([
      "up",
      "-d",
      "--wait",
      "--no-recreate",
    ])
    const config = stack.calls.find((c) => c.args.includes("config"))!
    expect(config.args.slice(config.args.indexOf("config"))).toEqual([
      "config",
      "--hash=*",
    ])
  })

  it.each([
    [
      "the config hash of a service",
      { garage: { "com.docker.compose.config-hash": "other" } },
    ],
    [
      "the stack-files hash",
      { postgres: { "simetra.stack-files-hash": "other" } },
    ],
    [
      "a missing stack-files hash",
      { postgres: { "simetra.stack-files-hash": "" } },
    ],
  ])(
    "refuses a running stack whose %s differs, without up",
    async (_title, labels) => {
      const stack = fakeStack({ running: true, labels })
      await expect(start(stack)).rejects.toThrow(
        "stopping the stack is the owner's call"
      )
      expect(stack.ups()).toEqual([])
      expect(stack.psqls()).toEqual([])
    }
  )

  it("files-hash postgres prints the hash the script builds with and compares", () => {
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(
          new URL("../../../../scripts/db-stack.mjs", import.meta.url)
        ),
        "files-hash",
        "postgres",
      ],
      { encoding: "utf8" }
    )
    expect(result.status).toBe(0)
    expect(result.stdout).toBe(`${stackFilesHash()}\n`)
    expect(stackFilesHash()).toMatch(/^[0-9a-f]{64}$/)
  })

  it("names its database sessions simetra_db_start: node steps by env, psql by exec -e", async () => {
    const stack = fakeStack()
    await start(stack)
    const nodeSteps = stack.calls.filter((c) => c.command === process.execPath)
    expect(nodeSteps).toHaveLength(2)
    for (const step of nodeSteps)
      expect((step.options.env as Record<string, string>).PGAPPNAME).toBe(
        "simetra_db_start"
      )
    expect(stack.psqls().length).toBeGreaterThan(0)
    for (const { args } of stack.psqls()) {
      const exec = args.indexOf("exec")
      expect(args.slice(exec, exec + 5)).toEqual([
        "exec",
        "-T",
        "-e",
        "PGAPPNAME=simetra_db_start",
        "postgres",
      ])
    }
  })

  it("runs roles, then passwords, then Better Auth, and terminates its backends last", async () => {
    const stack = fakeStack()
    await start(stack)
    const steps = stack.calls
      .filter(
        (c) =>
          c.args.includes("up") ||
          c.command === process.execPath ||
          c.args.includes("psql")
      )
      .map((c) =>
        c.args.includes("up")
          ? "up"
          : c.args.includes("roles")
            ? "roles"
            : c.command === process.execPath
              ? "better-auth"
              : c.input.includes("pg_terminate_backend")
                ? "terminate"
                : c.input.includes("ALTER ROLE")
                  ? "passwords"
                  : c.input.includes("pg_authid")
                    ? "verifiers"
                    : "psql"
      )
    expect(steps).toEqual([
      "up",
      "psql",
      "roles",
      "verifiers",
      "passwords",
      "better-auth",
      "terminate",
    ])
    const terminate = stack.psqls().at(-1)!
    expect(terminate.input).toContain("application_name = 'simetra_db_start'")
    expect(terminate.input).toContain("pg_backend_pid()")
  })

  it("terminates its backends when a step fails, then fails", async () => {
    const stack = fakeStack({ fail: (c) => c.args.includes("roles") })
    await expect(start(stack)).rejects.toThrow()
    expect(stack.psqls().at(-1)!.input).toContain("pg_terminate_backend")
    expect(stack.calls.some((c) => c.input.includes("ALTER ROLE"))).toBe(false)
  })

  it("sets only the passwords that differ from login-secrets.env", async () => {
    const owner = loginSecrets.SIMETRA_OWNER_DEV_PASSWORD!
    const stack = fakeStack({
      verifiers: {
        simetra_owner: verifierOf(owner),
        simetra_runtime: verifierOf("stale"),
        simetra_auth: "",
      },
    })
    await start(stack)
    const alter = stack.calls.find((c) => c.input.includes("ALTER ROLE"))!
    expect(alter.input).not.toContain("ALTER ROLE simetra_owner ")
    expect(alter.input).toContain("ALTER ROLE simetra_runtime ")
    expect(alter.input).toContain("ALTER ROLE simetra_auth ")
  })

  it("sets no password when every one already matches", async () => {
    const stack = fakeStack({
      verifiers: {
        simetra_owner: verifierOf(loginSecrets.SIMETRA_OWNER_DEV_PASSWORD!),
        simetra_runtime: verifierOf(loginSecrets.SIMETRA_RUNTIME_DEV_PASSWORD!),
        simetra_auth: verifierOf(loginSecrets.SIMETRA_AUTH_DEV_PASSWORD!),
      },
    })
    await start(stack)
    expect(stack.calls.some((c) => c.input.includes("ALTER ROLE"))).toBe(false)
  })

  // argv видно в `ps`: паролі лише в stdin, DSN — лише в середовищі
  it("puts no password and no DSN into any argv", async () => {
    const stack = fakeStack()
    await start(stack)
    const passwords = Object.values(loginSecrets)
    for (const { args } of stack.calls)
      for (const arg of args) {
        for (const password of passwords) expect(arg).not.toContain(password)
        expect(arg).not.toMatch(/postgresql:\/\//)
      }
  })
})
