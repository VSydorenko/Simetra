import {
  type ChildProcess,
  spawn,
  type SpawnOptions,
  spawnSync,
} from "node:child_process"
import { createHmac, createHash } from "node:crypto"
import { EventEmitter } from "node:events"
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { PassThrough } from "node:stream"
import { fileURLToPath } from "node:url"
import {
  LOGIN_ROLE_SETTINGS,
  loginRoleParentNames,
  PLATFORM_LOGIN_ROLES,
  PROVIDER_LOGIN_ROLES,
  PROVIDER_OWNER_ROLES,
  type PlatformLoginPurpose,
} from "simetra/model"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  assertServerVersion,
  betterAuthCommand,
  imageTagVersion,
  passwordMatches,
  POSTGRES_LOCK_FILE,
  POSTGRES_LOCK_PATH,
  POSTGRES_PSQL_ARGS,
  runChild,
  rolesSupabaseInput,
  scramKeys,
  signalsDsn,
  STACK_LOCK_ENV,
  STACK_REFUSAL,
  SUPABASE_LOCK_PATH,
  stackFilesHash,
  startPostgres,
  withStackLock,
} from "../../../../scripts/db-stack.mjs"
import { SIGNALS_JWKS_PATH } from "simetra/server/signals"
import {
  centrifugoConfig,
  centrifugoConfigRefusals,
  SIGNAL_CONSUMER_ENV,
} from "../../../designer/src/tools/signals-config"
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
  {
    title: "postgres stack",
    dir: STACK_DIR,
    project: "simetra-pg",
    script: "postgres",
    signalsPort: "8100",
  },
  {
    title: "supabase-signals stack",
    dir: dockerDir("supabase-signals"),
    project: "simetra-sb",
    script: "supabase-signals",
    signalsPort: "8101",
  },
] as const

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

/**
 * Блоки сервісів секції `services:` за іменем: рядки від `  <name>:` до
 * наступного сервісу. Ключ поза блоком сервісу (верхній рівень, `volumes:`)
 * до жодного блоку не потрапляє.
 */
function serviceBlocks(compose: string): Map<string, string> {
  const section = /^services:\n((?: {2}.*\n| *#.*\n|\s*\n)*)/m.exec(
    compose
  )?.[1]
  if (section === undefined) throw new Error("compose.yaml: no services:")
  const blocks = new Map<string, string>()
  for (const m of section.matchAll(
    /^ {2}([\w-]+):\n((?: {4}.*\n| *#.*\n|\s*\n)*)/gm
  ))
    blocks.set(m[1]!, m[2]!)
  return blocks
}

/** Значення ключа `network_mode` у тексті, у будь-якому записі ключа. */
const networkModes = (text: string): string[] =>
  [
    ...text.matchAll(
      /^\s*["']?network_mode["']?\s*:\s*["']?([^"'\s#]*)["']?\s*(?:#.*)?$/gm
    ),
  ].map((m) => m[1]!)

/** Пари `KEY: value` блоку `environment:` сервісу, без лапок значення. */
function environmentOf(block: string): Record<string, string> {
  const m = /^ {4}environment:\n((?: {6}.*\n| *#.*\n)*)/m.exec(block)
  if (m === null) return {}
  return Object.fromEntries(
    [...m[1]!.matchAll(/^ {6}([A-Z0-9_]+):\s*(.*?)\s*$/gm)].map((e) => [
      e[1]!,
      e[2]!.replace(/^"(.*)"$/, "$1"),
    ])
  )
}

describe.each(STACKS)("compose.yaml of the $title", ({ dir, project }) => {
  const compose = read("compose.yaml", dir)
  const services = serviceBlocks(compose)

  it("names the compose project", () => {
    expect(compose).toMatch(new RegExp(`^name: ${project}$`, "m"))
  })

  it("publishes every port on 127.0.0.1 only and never the Garage RPC port", () => {
    const ports = publishedPorts(compose)
    for (const port of ports) expect(port).toMatch(/^127\.0\.0\.1:\d+:\d+$/)
    expect(ports.some((p) => /:3901(:|$)/.test(p))).toBe(false)
  })

  // Р17: мережа хоста дозволена лише Centrifugo, і лише `host`; решта
  // сервісів публікує порти Docker-ом на 127.0.0.1
  it("has network_mode only on centrifugo, and only host", () => {
    expect(services.has("centrifugo")).toBe(true)
    for (const [name, block] of services)
      expect(networkModes(block), name).toEqual(
        name === "centrifugo" ? ["host"] : []
      )
    // Ключ поза блоками сервісів теж не проходить
    expect(networkModes(compose)).toEqual(["host"])
  })

  it("publishes no port of centrifugo: it is on the host network", () => {
    expect(services.get("centrifugo")).not.toMatch(/^\s*["']?ports["']?\s*:/m)
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

describe.each(STACKS)("Centrifugo of the $title", ({ dir, signalsPort }) => {
  const block = serviceBlocks(read("compose.yaml", dir)).get("centrifugo")!

  // HTTP лише на 127.0.0.1 і на своєму порту стека; DSN — лише інтерполяцією
  // середовища процесу compose (Р16), іншого ключа (слухача) немає
  it("listens on 127.0.0.1 at its own port and takes the DSNs from the compose environment", () => {
    const dsn = expect.stringMatching(/^\$\{SIMETRA_SIGNALS_DSN:\?[^}]*\}$/)
    expect(environmentOf(block)).toEqual({
      CENTRIFUGO_HTTP_SERVER_ADDRESS: "127.0.0.1",
      CENTRIFUGO_HTTP_SERVER_PORT: signalsPort,
      [SIGNAL_CONSUMER_ENV.dsn]: dsn,
      [SIGNAL_CONSUMER_ENV.notificationDsn]: dsn,
    })
  })

  it("passes no flag to centrifugo but the config file", () => {
    expect(block).toMatch(
      /^ {4}command: \["centrifugo", "-c", "\/centrifugo\/config\.json"\]$/m
    )
  })

  it("checks health on its own port", () => {
    const urls = [...block.matchAll(/"(http:\/\/[^"]+)"/g)].map((m) => m[1])
    expect(urls).toEqual([`http://127.0.0.1:${signalsPort}/health`])
  })

  it("has no env_file", () => {
    expect(block).not.toMatch(/^\s*env_file\s*:/m)
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

describe("the postgres image version", () => {
  const dockerfile = read("Dockerfile")
  const fromTag = /^FROM\s+postgres:(\d+\.\d+)-/m.exec(dockerfile)?.[1]

  it("the tag of the stack image is the version of the base image", () => {
    expect(fromTag).toBeDefined()
    expect(imageTagVersion()).toBe(fromTag)
  })

  it("every apt package is installed with an explicit version", () => {
    // Усі токени кожного `apt-get install`, не лише `postgresql-*`: прапорці
    // (`-y`, `--no-…`) пропускаються, решта — пакети
    const installs = dockerfile
      .replace(/\\\n/g, " ")
      .split(/&&|\|\||;|\n/)
      .map((part) => /apt-get install\s(.*)$/.exec(part.trim())?.[1])
      .filter((args): args is string => args !== undefined)
    expect(installs.length).toBeGreaterThan(0)
    const packages = installs.flatMap((args) =>
      args
        .split(/\s+/)
        .filter((token) => token !== "" && !token.startsWith("-"))
        .map((token) => token.split("=") as [string, string?])
    )
    expect(packages.map(([name]) => name)).toEqual([
      "ca-certificates",
      "postgresql-17-pgtap",
      "postgresql-17-plpgsql-check",
    ])
    // Єдиний виняток, іменований: `ca-certificates` лише дає довіру TLS під час
    // збірки й не впливає на версію сервера чи розширень. Його пін живе тільки
    // в trixie-security і зникає з індексу після наступного оновлення безпеки,
    // що зламало б збірку. Решта пакетів мають версію
    const UNPINNED = "ca-certificates"
    for (const [name, version] of packages) {
      if (name === UNPINNED) {
        expect(version, name).toBeUndefined()
        continue
      }
      expect(version, name).toMatch(/^\d[\w.+~-]*$/)
    }
  })

  it("does not install the server package: it comes from the base image", () => {
    expect(dockerfile).not.toMatch(/^\s+postgresql-17(=|\s|\\|$)/m)
  })
})

// Адреси Centrifugo стеків (Р17): host `pnpm demo` на 127.0.0.1:3000 дає і
// JWKS, і origin; ім'я проєкту (аудиторія токена) — файл проєкту стека
const STACK_HOST_ORIGIN = "http://127.0.0.1:3000"
const STACK_PROJECT_NAME = (
  JSON.parse(read("project/project.meta.json")) as { name: string }
).name

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

  // Файл стека — вихід генератора з адресами стека (Р17): правка руками
  // розійшлася б із білим списком і з тим, що генерує інструмент
  it("is the output of the config generator with the addresses of the stack", () => {
    expect(config).toEqual(
      centrifugoConfig({
        projectName: STACK_PROJECT_NAME,
        origin: STACK_HOST_ORIGIN,
        issuer: STACK_HOST_ORIGIN,
        jwksUrl: `${STACK_HOST_ORIGIN}${SIGNALS_JWKS_PATH}`,
      })
    )
    expect(centrifugoConfigRefusals(config)).toEqual([])
  })

  it("holds no login password", () => {
    const text = read("centrifugo.json", dir)
    for (const password of Object.values(loginSecrets))
      expect(text).not.toContain(password)
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
    "SIMETRA_SIGNALS_DEV_PASSWORD",
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
      PLATFORM_LOGIN_ROLES.signals,
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
    const step = betterAuthCommand(secrets)
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
    // Міграція йде від ролі `auth`: DSN суперкористувача дочірній процес не дістає
    expect(Object.keys(step.env)).toEqual(["SIMETRA_AUTH_URL"])
    expect(script).toContain("SIMETRA_DATABASE_URL")
  })

  // Р16: пароль споживача — лише в DSN середовища процесу compose, звідки
  // compose-файл інтерполює його в середовище Centrifugo
  it("gives each Centrifugo the DSN of simetra_signals at its stack database", () => {
    const password = loginSecrets.SIMETRA_SIGNALS_DEV_PASSWORD!
    expect(signalsDsn("postgres")).toBe(
      `postgresql://${PLATFORM_LOGIN_ROLES.signals}:${password}@127.0.0.1:54422/simetra`
    )
    expect(signalsDsn("supabase-signals")).toBe(
      `postgresql://${PLATFORM_LOGIN_ROLES.signals}:${password}@127.0.0.1:54322/postgres`
    )
  })

  it("no stack file but login-secrets.env holds a login password", () => {
    const passwords = Object.values(loginSecrets)
    for (const { dir } of STACKS)
      for (const file of ["compose.yaml", "centrifugo.json"])
        for (const password of passwords)
          expect(read(file, dir), file).not.toContain(password)
  })

  it("db:roles sets the signals password through stdin after roles.sql", () => {
    const password = loginSecrets.SIMETRA_SIGNALS_DEV_PASSWORD!
    const input = rolesSupabaseInput()
    const roles = readFileSync(
      fileURLToPath(new URL("../../../../supabase/roles.sql", import.meta.url)),
      "utf8"
    )
    expect(input.startsWith(roles)).toBe(true)
    expect(input.slice(roles.length)).toBe(
      `\n\\set pw '${password}'\nALTER ROLE ${PLATFORM_LOGIN_ROLES.signals} PASSWORD :'pw';\n`
    )
  })
})

/**
 * GRANT-и roles.sql, що стоять не під доведеною формою. Список дозволів, а не
 * перелік заборонених форм: із файла прибираються цілі блоки `IF … END IF;`
 * рівно двох форм, і кожен GRANT, що лишився деінде (верхній рівень, тіло DO,
 * ELSE, інший IF), — порушення.
 * (1) створення: `IF NOT EXISTS (… pg_roles … 'r') THEN` рівно один `CREATE ROLE r`,
 *     далі лише `PERFORM set_config` і GRANT … TO r, без ELSE/ELSIF/вкладених IF;
 * (2) членство: `IF NOT EXISTS (… pg_auth_members … 'X' … 'Y') THEN` один
 *     оператор `GRANT X TO Y`, без ELSE/ELSIF/вкладених IF.
 */
function unguardedGrants(sql: string): string[] {
  const code = sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
  const ifBlock =
    /\bIF NOT EXISTS\s*\(([\s\S]*?)\)\s*THEN([\s\S]*?)\bEND IF\s*;/g
  const grantTarget = /^GRANT\s+([\s\S]+?)\s+TO\s+(\w+)(?:\s+WITH\b[\s\S]*)?$/
  const proven = (cond: string, body: string): boolean => {
    if (/\b(ELSE|ELSIF|IF)\b/i.test(body)) return false
    const statements = body
      .split(";")
      .map((st) => st.trim())
      .filter((st) => st !== "")
    const created =
      /^\s*SELECT FROM pg_catalog\.pg_roles WHERE rolname = '(\w+)'\s*$/.exec(
        cond
      )?.[1]
    if (created !== undefined) {
      const creates = statements.filter((st) =>
        new RegExp(`^CREATE ROLE ${created}\\b`).test(st)
      )
      return (
        creates.length === 1 &&
        statements.every(
          (st) =>
            creates.includes(st) ||
            /^PERFORM pg_catalog\.set_config\(/.test(st) ||
            grantTarget.exec(st)?.[2] === created
        )
      )
    }
    const named =
      /^\s*SELECT FROM pg_catalog\.pg_auth_members\s+WHERE roleid = '(\w+)'::pg_catalog\.regrole\s+AND member = '(\w+)'::pg_catalog\.regrole\s*$/.exec(
        cond
      )
    if (named === null || statements.length !== 1) return false
    const grant = /^GRANT\s+(\w+)\s+TO\s+(\w+)(?:\s+WITH\b[\s\S]*)?$/.exec(
      statements[0]!
    )
    return grant?.[1] === named[1] && grant?.[2] === named[2]
  }
  const rest = code.replace(ifBlock, (whole, cond: string, body: string) =>
    proven(cond, body) ? "" : whole
  )
  return rest.match(/\bGRANT\b[^;]*;/gi) ?? []
}

/**
 * Пари (роль входу, група) налаштування `role` з даних T0: налаштування
 * `LOGIN_ROLE_SETTINGS`, а група — серед батьків ролі за `LOGIN_ROLE_PARENTS`
 * (профіль `supabase`, бо файл — його). Пара поза обома даними не дозволена.
 */
const ROLE_SETTING_PAIRS: readonly (readonly [string, string])[] = (
  Object.entries(LOGIN_ROLE_SETTINGS) as [
    PlatformLoginPurpose,
    { role: string },
  ][]
)
  .filter(([purpose, { role }]) =>
    loginRoleParentNames(purpose, "supabase").includes(role)
  )
  .map(([purpose, { role }]) => [PLATFORM_LOGIN_ROLES[purpose], role] as const)

/**
 * `ALTER|DROP ROLE|USER|OWNED` roles.sql, що стоять не під доведеною формою
 * (архітектурне рішення К1). Єдина дозволена: `ALTER ROLE r SET role = 'g'` у
 * блоці створення тієї самої ролі (`IF NOT EXISTS (… pg_roles … 'r') THEN`
 * рівно один `CREATE ROLE r`, без ELSE/ELSIF/вкладених IF) і з парою (r, g) з
 * `pairs`. Наявну роль файл так не змінить: блок виконується лише при
 * створенні. Решта — порушення, де б вона не стояла.
 */
function unguardedRoleChanges(
  sql: string,
  pairs: readonly (readonly [string, string])[] = ROLE_SETTING_PAIRS
): string[] {
  const code = sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
  const ifBlock =
    /\bIF NOT EXISTS\s*\(([\s\S]*?)\)\s*THEN([\s\S]*?)\bEND IF\s*;/g
  const rest = code.replace(ifBlock, (whole, cond: string, body: string) => {
    const created =
      /^\s*SELECT FROM pg_catalog\.pg_roles WHERE rolname = '(\w+)'\s*$/.exec(
        cond
      )?.[1]
    if (created === undefined || /\b(ELSE|ELSIF|IF)\b/i.test(body)) return whole
    const statements = body.split(";").map((st) => st.trim())
    if (
      statements.filter((st) =>
        new RegExp(`^CREATE ROLE ${created}\\b`).test(st)
      ).length !== 1
    )
      return whole
    // Блок створення лишається для інших перевірок без дозволених налаштувань
    return statements
      .filter((st) => {
        const setting = /^ALTER ROLE (\w+) SET role = '(\w+)'$/.exec(st)
        return !(
          setting !== null &&
          setting[1] === created &&
          pairs.some(([r, g]) => r === setting[1] && g === setting[2])
        )
      })
      .join("; ")
  })
  return rest.match(/\b(ALTER|DROP)\s+(ROLE|USER|OWNED)\b[^;]*/gi) ?? []
}

// `pnpm db:roles` повторно виконує файл на наявному стеку: кожне членство мусить
// бути або в блоці створення своєї ролі, або під власною перевіркою
describe("supabase/roles.sql is additive and idempotent", () => {
  const sql = readFileSync(
    fileURLToPath(new URL("../../../../supabase/roles.sql", import.meta.url)),
    "utf8"
  )

  it("never alters or drops a role, except the role setting of a login role it creates", () => {
    expect(unguardedRoleChanges(sql)).toEqual([])
  })

  it("sets the role setting of every login role with one in the T0 data", () => {
    expect(ROLE_SETTING_PAIRS.length).toBe(
      Object.keys(LOGIN_ROLE_SETTINGS).length
    )
    for (const [r, g] of ROLE_SETTING_PAIRS)
      expect(sql).toContain(`ALTER ROLE ${r} SET role = '${g}';`)
  })

  it("guards every GRANT … TO by role creation or a pg_auth_members check", () => {
    expect(sql).toMatch(/\bGRANT\b/)
    expect(unguardedGrants(sql)).toEqual([])
  })

  const ROLE =
    "IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'r')"
  const MEMBER =
    "IF NOT EXISTS (SELECT FROM pg_catalog.pg_auth_members WHERE roleid = 'a'::pg_catalog.regrole AND member = 'b'::pg_catalog.regrole)"
  const wrap = (inner: string): string => `DO $$ BEGIN ${inner} END $$;`

  describe("the role setting", () => {
    const [pair] = ROLE_SETTING_PAIRS
    const [r, g] = pair!
    const created = (name: string, inner: string): string =>
      wrap(
        `IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = '${name}') THEN CREATE ROLE ${name} LOGIN; ${inner} END IF;`
      )

    it("accepts the setting of the T0 data inside the creation block of its role", () => {
      expect(
        unguardedRoleChanges(created(r, `ALTER ROLE ${r} SET role = '${g}';`))
      ).toEqual([])
    })

    it.each([
      [
        "the setting outside the creation block",
        `${created(r, "")}\nALTER ROLE ${r} SET role = '${g}';`,
      ],
      [
        "the setting of another role in a creation block",
        created(r, `ALTER ROLE other_role SET role = '${g}';`),
      ],
      [
        "the setting of another role in its own creation block",
        created("other_role", `ALTER ROLE other_role SET role = '${g}';`),
      ],
      [
        "a pair outside the T0 data",
        created(r, `ALTER ROLE ${r} SET role = 'simetra_command';`),
      ],
      [
        "another ALTER in the creation block",
        created(r, `ALTER ROLE ${r} SUPERUSER;`),
      ],
      ["a DROP ROLE", "DROP ROLE x;"],
      ["a DROP OWNED", created(r, "DROP OWNED BY x;")],
      [
        "the setting in an ELSE of the creation block",
        created(r, `ELSE ALTER ROLE ${r} SET role = '${g}';`),
      ],
    ])("rejects %s", (_name, sqlText) => {
      expect(unguardedRoleChanges(sqlText).length).toBeGreaterThan(0)
    })
  })

  it("accepts the two proven shapes", () => {
    expect(
      unguardedGrants(
        wrap(`${ROLE} THEN CREATE ROLE r; GRANT x TO r WITH SET TRUE; END IF;`)
      )
    ).toEqual([])
    expect(
      unguardedGrants(
        wrap(`${MEMBER} THEN GRANT a TO b WITH SET TRUE; END IF;`)
      )
    ).toEqual([])
  })

  it.each([
    [
      "a bare GRANT before a guarded DO",
      `GRANT x TO y;\n${wrap(`${ROLE} THEN CREATE ROLE r; END IF;`)}`,
    ],
    [
      "a GRANT in a DO outside its IF",
      wrap(`${ROLE} THEN CREATE ROLE r; END IF; GRANT x TO y;`),
    ],
    [
      "a creation-block GRANT to another role",
      wrap(`${ROLE} THEN CREATE ROLE r; GRANT x TO other; END IF;`),
    ],
    [
      "a creation check that creates another role",
      wrap(`${ROLE} THEN CREATE ROLE q; GRANT x TO q; END IF;`),
    ],
    [
      "a GRANT in an ELSE of a creation block",
      wrap(`${ROLE} THEN CREATE ROLE r; ELSE GRANT x TO y; END IF;`),
    ],
    [
      "a GRANT in an ELSIF of a membership block",
      wrap(
        `${MEMBER} THEN GRANT a TO b; ELSIF true THEN GRANT x TO y; END IF;`
      ),
    ],
    [
      "two GRANTs in one membership IF",
      wrap(`${MEMBER} THEN GRANT a TO b; GRANT c TO d; END IF;`),
    ],
    [
      "a membership GRANT that differs from its condition",
      wrap(`${MEMBER} THEN GRANT c TO d; END IF;`),
    ],
    [
      "a nested IF",
      wrap(`${MEMBER} THEN IF true THEN GRANT a TO b; END IF; END IF;`),
    ],
  ])("rejects %s", (_name, sqlText) => {
    expect(unguardedGrants(sqlText).length).toBeGreaterThan(0)
  })
})

describe("withStackLock", () => {
  // Команда стека й DB-прогін мусять брати один замок: інакше `stop` зупинив
  // би стек посеред прогону
  it("the script locks the same file as the guard of the postgres stack", () => {
    expect(POSTGRES_LOCK_FILE).toBe(TEST_STACKS.postgres.lockFile)
    expect(basename(SUPABASE_LOCK_PATH)).toBe(TEST_STACKS.supabase.lockFile)
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

const SCRIPT_URL = new URL("../../../../scripts/db-stack.mjs", import.meta.url)

describe("stack-files hash wiring of the postgres stack", () => {
  /** Блок сервісу в compose.yaml: рядки від `  <name>:` до наступного сервісу. */
  const serviceBlock = (name: string): string => {
    const compose = read("compose.yaml")
    const m = new RegExp(`^  ${name}:\\n((?:    .*\\n|\\s*\\n)*)`, "m").exec(
      compose
    )
    expect(m, name).not.toBeNull()
    return m![1]!
  }

  it("the Dockerfile labels the image with the build argument, after the packages", () => {
    const dockerfile = read("Dockerfile")
    const arg = dockerfile.indexOf("ARG SIMETRA_STACK_FILES_HASH\n")
    const label = dockerfile.indexOf(
      "LABEL simetra.stack-files-hash=$SIMETRA_STACK_FILES_HASH\n"
    )
    expect(arg).toBeGreaterThan(dockerfile.indexOf("RUN apt-get"))
    expect(label).toBeGreaterThan(arg)
  })

  it("compose passes the hash as the build argument of postgres", () => {
    expect(serviceBlock("postgres")).toMatch(
      /^ {6}args:\n {8}SIMETRA_STACK_FILES_HASH: \$\{SIMETRA_STACK_FILES_HASH:-\}$/m
    )
  })

  it.each(["garage", "centrifugo"])(
    "compose labels the %s container with the hash",
    (name) => {
      expect(serviceBlock(name)).toMatch(
        /^ {4}labels:\n(?: {6}#.*\n)* {6}simetra\.stack-files-hash: \$\{SIMETRA_STACK_FILES_HASH:-\}$/m
      )
    }
  )

  // Мітку має кожен сервіс: образ postgres — зі збірки, решта — з compose
  it("every service of compose.yaml is covered", () => {
    // Лише секція `services:`: ключі `volumes:` теж мають відступ у два пробіли
    const section = /^services:\n((?: {2}.*\n|\n)*)/m.exec(
      read("compose.yaml")
    )?.[1]
    expect(section, "compose.yaml has no services: section").toBeDefined()
    const services = [...section!.matchAll(/^ {2}([\w-]+):$/gm)].map(
      (m) => m[1]
    )
    expect(services.sort()).toEqual(["centrifugo", "garage", "postgres"])
  })
})

describe("stack lock path", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  // Сесії з різним TMPDIR інакше брали б різні файли й не виключали б одна одну
  // Шлях скрипту обчислюється при імпорті: імпорт — у процесі з іншим TMPDIR
  it("is /tmp/<lockFile> in the script whatever TMPDIR is", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { POSTGRES_LOCK_PATH } from ${JSON.stringify(SCRIPT_URL.href)}; process.stdout.write(POSTGRES_LOCK_PATH)`,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, TMPDIR: "/var/tmp/some-session" },
      }
    )
    expect(result.status).toBe(0)
    expect(result.stdout).toBe(`/tmp/${TEST_STACKS.postgres.lockFile}`)
    expect(POSTGRES_LOCK_PATH).toBe(result.stdout)
  })

  it("is /tmp/<lockFile> in the guard whatever TMPDIR is", () => {
    vi.stubEnv("TMPDIR", "/var/tmp/some-session")
    expect(lockPath("postgres")).toBe(`/tmp/${TEST_STACKS.postgres.lockFile}`)
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

describe("runChild with a grandchild in the group", () => {
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  // Прямий дочірній виходить на сигнал, а нащадок у його групі — ні: замок
  // тримається до SIGKILL групи
  it("keeps the lock until the whole group is gone after a forwarded signal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "simetra-stack-lock-"))
    let grandchild = 0
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
            killAfterMs: 500,
            onStdout: (chunk: string) => {
              const m = /grandchild (\d+)/.exec(chunk)
              if (m !== null) {
                grandchild = Number(m[1])
                ready()
              }
            },
          },
          (_command, _args, options) =>
            spawn(
              process.execPath,
              [
                "-e",
                `const { spawn } = require("node:child_process");
                 const g = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
                 process.on("SIGTERM", () => process.exit(0));
                 setInterval(() => {}, 1000);
                 setTimeout(() => process.stdout.write("grandchild " + g.pid + "\\n"), 100)`,
              ],
              options
            )
        )
      })
      await started
      const signalled = Date.now()
      signals.emit("SIGTERM", "SIGTERM")
      await new Promise((resolve) => setTimeout(resolve, 250))
      expect(alive(grandchild)).toBe(true)
      expect(existsSync(lock)).toBe(true)
      await run
      expect(Date.now() - signalled).toBeGreaterThanOrEqual(500)
      expect(code).toBe(0)
      expect(alive(grandchild)).toBe(false)
      expect(existsSync(lock)).toBe(false)
    } finally {
      if (grandchild > 0) {
        try {
          process.kill(grandchild, "SIGKILL")
        } catch {
          // уже вбито
        }
      }
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("runChild when the group cannot be signalled", () => {
  // EPERM зі слухача сигналу чи таймера SIGKILL не має стати неперехопленим
  // винятком і не тримає замок без кінця
  it("warns and stops waiting instead of throwing", async () => {
    const realKill = process.kill.bind(process)
    const kill = vi
      .spyOn(process, "kill")
      .mockImplementation((pid: number, signal?: string | number) => {
        if (pid < 0) throw Object.assign(new Error("EPERM"), { code: "EPERM" })
        return realKill(pid, signal)
      })
    const warn = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true)
    try {
      const signals = new EventEmitter()
      const child = new EventEmitter() as ChildProcess
      Object.assign(child, { pid: 4242 })
      const done = runChild("x", [], { signals, killAfterMs: 20 }, () => child)
      signals.emit("SIGTERM", "SIGTERM")
      // Таймер SIGKILL спрацьовує, поки дочірній ще живий
      await new Promise((resolve) => setTimeout(resolve, 60))
      child.emit("close", 0, null)
      expect(await done).toBe(0)
      expect(kill).toHaveBeenCalledWith(-4242, "SIGKILL")
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("cannot signal process group 4242 (EPERM)")
      )
    } finally {
      kill.mockRestore()
      warn.mockRestore()
    }
  })
})

describe("runChild when the group survives SIGKILL", () => {
  // Зомбі чи процес у D-стані SIGKILL не бере: очікування порожньої групи
  // має межу, а не тримає замок стека без кінця
  it("warns and settles after the limit instead of waiting forever", async () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true)
    const warn = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true)
    try {
      const signals = new EventEmitter()
      const child = new EventEmitter() as ChildProcess
      Object.assign(child, { pid: 4243 })
      const done = runChild(
        "x",
        [],
        { signals, killAfterMs: 20, groupGoneAfterKillMs: 100 },
        () => child
      )
      signals.emit("SIGTERM", "SIGTERM")
      child.emit("close", 0, null)
      const started = Date.now()
      expect(await done).toBe(0)
      expect(Date.now() - started).toBeGreaterThanOrEqual(100)
      expect(kill).toHaveBeenCalledWith(-4243, "SIGKILL")
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("process group 4243 survived SIGKILL")
      )
    } finally {
      kill.mockRestore()
      warn.mockRestore()
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
    /** `undefined` — мітки немає на контейнері. */
    labels?: Partial<
      Record<(typeof SERVICES)[number], Record<string, string | undefined>>
    >
    verifiers?: Record<string, string>
    /** Що вертає `current_setting('server_version')`; типово версія з тегу. */
    serverVersion?: string
    fail?: (call: Call) => boolean
    /** Справжній дочірній замість підставного для виклику, що підходить. */
    real?: (call: Call) => ChildProcess | undefined
    /** Тека й хеш конфігу, з якими створено контейнери. */
    createdFrom?: { dir: string; configHash: string }
  } = {}
) {
  const calls: Call[] = []
  const reply = (call: Call): Reply => {
    const { args } = call
    if (o.fail?.(call) === true) return { code: 1 }
    if (args.includes("config"))
      return { stdout: SERVICES.map((s) => `${s}\n`).join("") }
    if (args.includes("ps"))
      return { stdout: o.running === true ? "id-1\nid-2\nid-3\n" : "" }
    if (call.command === "docker" && args[0] === "inspect")
      return {
        stdout: JSON.stringify(
          SERVICES.map((s) => ({
            Config: {
              Labels: {
                "com.docker.compose.service": s,
                "com.docker.compose.config-hash":
                  o.createdFrom?.configHash ?? `${s}-hash`,
                "com.docker.compose.project.working_dir":
                  o.createdFrom?.dir ?? STACK_DIR,
                "simetra.stack-files-hash": stackFilesHash(),
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
    if (call.input.includes("server_version"))
      return { stdout: `${o.serverVersion ?? imageTagVersion()}\n` }
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
    const real = o.real?.({ command, args, options, input: "" })
    if (real !== undefined) {
      calls.push({ command, args, options, input: "" })
      return real
    }
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
    // Другий `up` — лише Centrifugo, після ролей і паролів
    const [up, signals, ...more] = stack.ups()
    expect(more).toEqual([])
    expect(up!.args.slice(up!.args.indexOf("up"))).toEqual([
      "up",
      "-d",
      "--wait",
      "--build",
      "postgres",
      "garage",
    ])
    expect(signals!.args.at(-1)).toBe("centrifugo")
    expect(signals!.args).not.toContain("--build")
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
      "postgres",
      "garage",
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
      "postgres",
      "garage",
    ])
    const config = stack.calls.find((c) => c.args.includes("config"))!
    expect(config.args.slice(config.args.indexOf("config"))).toEqual([
      "config",
      "--services",
    ])
  })

  // Хеш конфігу compose містить абсолютний шлях bind-монтувань: ті самі файли
  // з іншого checkout-а не мають давати відмову
  it("accepts a running stack created from the same files in another checkout", async () => {
    const copy = mkdtempSync(join(tmpdir(), "simetra-other-checkout-"))
    try {
      cpSync(STACK_DIR, copy, { recursive: true })
      expect(stackFilesHash(copy)).toBe(stackFilesHash())
      const stack = fakeStack({
        running: true,
        createdFrom: { dir: copy, configHash: "hash-of-another-path" },
      })
      await start(stack)
      const [up] = stack.ups()
      expect(up!.args).toContain("--no-recreate")
    } finally {
      rmSync(copy, { recursive: true, force: true })
    }
  })

  it("refuses a running stack created with another garage.toml, without up", async () => {
    const copy = mkdtempSync(join(tmpdir(), "simetra-other-checkout-"))
    try {
      cpSync(STACK_DIR, copy, { recursive: true })
      writeFileSync(
        join(copy, "garage.toml"),
        `${read("garage.toml")}\n# changed\n`
      )
      const other = stackFilesHash(copy)
      expect(other).not.toBe(stackFilesHash())
      const stack = fakeStack({
        running: true,
        labels: { garage: { "simetra.stack-files-hash": other } },
      })
      await expect(start(stack)).rejects.toMatchObject({
        code: STACK_REFUSAL.differs,
        message: expect.stringContaining("garage: simetra.stack-files-hash"),
      })
      expect(stack.ups()).toEqual([])
    } finally {
      rmSync(copy, { recursive: true, force: true })
    }
  })

  it.each([
    [
      "a differing stack-files label of postgres",
      { postgres: { "simetra.stack-files-hash": "other" } },
      STACK_REFUSAL.differs,
    ],
    [
      "a missing container",
      { garage: { "com.docker.compose.service": "other" } },
      STACK_REFUSAL.differs,
    ],
    [
      "no stack-files label on any container (built before the label)",
      Object.fromEntries(
        SERVICES.map((s) => [s, { "simetra.stack-files-hash": undefined }])
      ),
      STACK_REFUSAL.unlabelled,
    ],
    [
      "an empty stack-files label of centrifugo",
      { centrifugo: { "simetra.stack-files-hash": "" } },
      STACK_REFUSAL.unlabelled,
    ],
    [
      "one unlabelled container beside a differing one",
      {
        postgres: { "simetra.stack-files-hash": "other" },
        garage: { "simetra.stack-files-hash": undefined },
      },
      STACK_REFUSAL.unlabelled,
    ],
  ])(
    "refuses a running stack with %s, without up",
    async (_title, labels, code) => {
      const stack = fakeStack({ running: true, labels })
      await expect(start(stack)).rejects.toMatchObject({ code })
      expect(stack.ups()).toEqual([])
      expect(stack.psqls()).toEqual([])
    }
  )

  it("accepts a server whose version is the tag of the image", async () => {
    await start(fakeStack({ serverVersion: `${imageTagVersion()} (Debian)` }))
  })

  it.each(["17.11", "", "17.120"])(
    "refuses a server reporting %j instead of the tag version, before any change",
    async (reported) => {
      const stack = fakeStack({ serverVersion: reported })
      await expect(start(stack)).rejects.toMatchObject({
        code: STACK_REFUSAL.serverVersion,
        message: expect.stringContaining(imageTagVersion()),
      })
      expect(stack.calls.some((c) => c.command === process.execPath)).toBe(
        false
      )
      expect(stack.psqls().some((c) => c.input.includes("pg_authid"))).toBe(
        false
      )
    }
  )

  it("assertServerVersion compares the first token only", () => {
    expect(() =>
      assertServerVersion("17.12 (Debian 17.12-1.pgdg13+1)\n", "17.12")
    ).not.toThrow()
    expect(() => assertServerVersion("17.12", "17.11")).toThrow(
      /server_version is 17\.12/
    )
  })

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
    // `roles`, міграція Better Auth, повторний `roles`
    expect(nodeSteps).toHaveLength(3)
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

  // Порядок старту (задача 12 плану B2, Р16): Centrifugo — останнім, коли
  // роль `simetra_signals` уже має пароль його DSN
  it("runs roles, then passwords, then Better Auth, then roles again, terminates its backends, and starts Centrifugo last", async () => {
    const stack = fakeStack()
    await start(stack)
    const steps = stack.calls
      .filter(
        (c) =>
          c.args.includes("up") ||
          c.args.includes("create") ||
          c.command === process.execPath ||
          c.args.includes("psql")
      )
      .map((c) =>
        c.args.includes("up")
          ? c.args.at(-1) === "centrifugo"
            ? "up centrifugo"
            : "up"
          : c.args.includes("create")
            ? "create centrifugo"
            : c.args.includes("roles")
              ? "roles"
              : c.command === process.execPath
                ? "better-auth"
                : c.input.includes("server_version")
                  ? "server-version"
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
      "create centrifugo",
      "server-version",
      "psql",
      "roles",
      "verifiers",
      "passwords",
      "better-auth",
      "roles",
      "terminate",
      "up centrifugo",
    ])
    const create = stack.calls.find((c) => c.args.includes("create"))!
    expect(create.args.slice(create.args.indexOf("create"))).toEqual([
      "create",
      "--no-recreate",
      "centrifugo",
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
    // Centrifugo без пароля свого DSN не стартує
    expect(stack.ups().some((c) => c.args.includes("centrifugo"))).toBe(false)
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
        simetra_signals: verifierOf(loginSecrets.SIMETRA_SIGNALS_DEV_PASSWORD!),
      },
    })
    await start(stack)
    expect(stack.calls.some((c) => c.input.includes("ALTER ROLE"))).toBe(false)
  })

  const matching = (stale: string[] = []) =>
    Object.fromEntries(
      [
        ["simetra_owner", "SIMETRA_OWNER_DEV_PASSWORD"],
        ["simetra_runtime", "SIMETRA_RUNTIME_DEV_PASSWORD"],
        ["simetra_auth", "SIMETRA_AUTH_DEV_PASSWORD"],
        ["simetra_signals", "SIMETRA_SIGNALS_DEV_PASSWORD"],
      ].map(([role, secret]) => [
        role!,
        verifierOf(stale.includes(role!) ? "stale" : loginSecrets[secret!]!),
      ])
    )
  const signalsUp = (stack: ReturnType<typeof fakeStack>) => {
    const up = stack.ups().at(-1)!
    expect(up.args.at(-1)).toBe("centrifugo")
    return up
  }

  it("starts Centrifugo with the DSN of simetra_signals in the compose environment only", async () => {
    const stack = fakeStack()
    await start(stack)
    const up = signalsUp(stack)
    expect((up.options.env as Record<string, string>).SIMETRA_SIGNALS_DSN).toBe(
      signalsDsn("postgres")
    )
    expect(signalsDsn("postgres")).toContain(
      loginSecrets.SIMETRA_SIGNALS_DEV_PASSWORD
    )
  })

  it("keeps a running Centrifugo when the signals password is unchanged", async () => {
    const stack = fakeStack({
      running: true,
      verifiers: matching(["simetra_runtime"]),
    })
    await start(stack)
    expect(signalsUp(stack).args).toContain("--no-recreate")
    expect(signalsUp(stack).args).not.toContain("--force-recreate")
  })

  it("recreates only Centrifugo when the signals password changed", async () => {
    const stack = fakeStack({
      running: true,
      verifiers: matching(["simetra_signals"]),
    })
    await start(stack)
    const [first] = stack.ups()
    expect(first!.args).toContain("--no-recreate")
    expect(first!.args).not.toContain("centrifugo")
    expect(signalsUp(stack).args).toContain("--force-recreate")
  })

  const isTerminate = (c: Call): boolean =>
    c.args.includes("psql") && c.args.includes("-q")

  // Другий Ctrl-C не має вбити прибирання бекендів
  it("the backend cleanup does not hear the signals of the script", async () => {
    const signals = new EventEmitter()
    let listening: number | undefined
    const stack = fakeStack({
      real: (call) => {
        // Після повернення spawnFn: runChild підписується вже після нього
        if (isTerminate(call))
          setImmediate(() => (listening = signals.listenerCount("SIGINT")))
        return undefined
      },
    })
    await startPostgres({ spawnFn: stack.spawnFn, signals })
    // Лише слухач контексту команди, що записує сигнал
    expect(listening).toBe(1)
  })

  it("the backend cleanup stops a hung psql after its own timeout and warns", async () => {
    const warn = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true)
    try {
      const stack = fakeStack({
        real: (call) =>
          isTerminate(call)
            ? spawn(
                process.execPath,
                ["-e", "setInterval(() => {}, 1000)"],
                call.options
              )
            : undefined,
      })
      const began = Date.now()
      await startPostgres({
        spawnFn: stack.spawnFn,
        signals: new EventEmitter(),
        cleanupTimeoutMs: 200,
      })
      expect(Date.now() - began).toBeLessThan(5_000)
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("could not stop the backends")
      )
    } finally {
      warn.mockRestore()
    }
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
