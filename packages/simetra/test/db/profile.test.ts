import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PROVIDER_OWNER_ROLES } from "simetra/model"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  DEV_SECRETS_FILE,
  devSecret,
  enterProvider,
  garageAdminToken,
  LOGIN_SECRETS_FILE,
  PROVIDER_ENV,
  SUPERUSER_PRELUDE,
  TEST_STACKS,
  testProvider,
  testStack,
} from "./profile"

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("testProvider", () => {
  it("defaults to supabase when the variable is not set", () => {
    vi.stubEnv(PROVIDER_ENV, "")
    delete process.env[PROVIDER_ENV]
    expect(testProvider()).toBe("supabase")
  })

  it("reads the profile from the variable", () => {
    vi.stubEnv(PROVIDER_ENV, "postgres")
    expect(testProvider()).toBe("postgres")
    expect(testStack()).toBe(TEST_STACKS.postgres)
  })

  it("rejects an unknown profile and names the variable", () => {
    vi.stubEnv(PROVIDER_ENV, "pg")
    expect(() => testProvider()).toThrow(PROVIDER_ENV)
  })
})

describe("enterProvider", () => {
  it("refuses a second, different profile in the same process", () => {
    vi.stubEnv(PROVIDER_ENV, "")
    delete process.env[PROVIDER_ENV]
    enterProvider("supabase")
    expect(() => enterProvider("postgres")).toThrow(PROVIDER_ENV)
  })

  it("accepts the same profile twice", () => {
    vi.stubEnv(PROVIDER_ENV, "postgres")
    expect(() => enterProvider("postgres")).not.toThrow()
  })
})

describe("TEST_STACKS", () => {
  it.each(Object.entries(TEST_STACKS))(
    "%s: every address is on 127.0.0.1",
    (_name, stack) => {
      const urls = [
        stack.databaseUrl,
        stack.superuserUrl,
        stack.poolerUrl,
        stack.garageAdminUrl,
      ].filter((u) => u !== null)
      for (const url of urls) expect(new URL(url).hostname).toBe("127.0.0.1")
    }
  )

  // Р2: база тестів `simetra`, а стартовий параметр — роль власника на
  // кожному новому з'єднанні з адреси тестів
  it("postgres: tests run in database simetra as the owner, the superuser without options", () => {
    const tests = new URL(TEST_STACKS.postgres.databaseUrl)
    expect(tests.pathname).toBe("/simetra")
    expect(tests.searchParams.getAll("options")).toEqual([
      `-c role=${PROVIDER_OWNER_ROLES.postgres}`,
    ])
    const superuser = new URL(TEST_STACKS.postgres.superuserUrl)
    expect(superuser.pathname).toBe("/simetra")
    expect(superuser.searchParams.has("options")).toBe(false)
    expect(superuser.username).toBe(TEST_STACKS.postgres.superuserName)
  })

  it("gives each profile its own lock file, keeping the Supabase name", () => {
    expect(TEST_STACKS.supabase.lockFile).toBe("simetra-db-stack.lock")
    expect(TEST_STACKS.postgres.lockFile).not.toBe(
      TEST_STACKS.supabase.lockFile
    )
  })
})

describe("garageAdminToken", () => {
  it("reads a non-empty token from the stack secrets file", () => {
    expect(garageAdminToken()).not.toBe("")
  })

  it("names the file in the error when it is missing", () => {
    // Шлях, який ніколи не створюється: тест не лишає тек у системній temp
    const missing = join(
      tmpdir(),
      `simetra-missing-${randomUUID()}`,
      "none.env"
    )
    expect(() => garageAdminToken(missing)).toThrow(missing)
  })

  it("names the file in the error when it has no token line", () => {
    const dir = mkdtempSync(join(tmpdir(), "profile-"))
    try {
      const file = join(dir, "no-token.env")
      writeFileSync(file, "GARAGE_RPC_SECRET=x\n")
      expect(() => garageAdminToken(file)).toThrow(file)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("devSecret", () => {
  const withFile = <T>(content: string, fn: (file: string) => T): T => {
    const dir = mkdtempSync(join(tmpdir(), "profile-"))
    try {
      const file = join(dir, "secrets.env")
      writeFileSync(file, content)
      return fn(file)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it("reads the value of the variable from the file", () => {
    withFile(
      "# comment\nA_DEV_PASSWORD=one\nB_DEV_PASSWORD= two \n",
      (file) => {
        expect(devSecret("A_DEV_PASSWORD", file)).toBe("one")
        expect(devSecret("B_DEV_PASSWORD", file)).toBe("two")
      }
    )
  })

  it("names the variable when the file lacks it", () => {
    withFile("A_DEV_PASSWORD=one\n", (file) => {
      expect(() => devSecret("C_DEV_PASSWORD", file)).toThrow("C_DEV_PASSWORD")
    })
  })

  it("names the variable and the file when the file is missing", () => {
    const missing = join(tmpdir(), `simetra-missing-${randomUUID()}`, "x.env")
    expect(() => devSecret("C_DEV_PASSWORD", missing)).toThrow("C_DEV_PASSWORD")
    expect(() => devSecret("C_DEV_PASSWORD", missing)).toThrow(missing)
  })

  it("finds the owner's login password in login-secrets.env", () => {
    expect(
      devSecret("SIMETRA_OWNER_DEV_PASSWORD", LOGIN_SECRETS_FILE)
    ).not.toBe("")
    expect(() => devSecret("SIMETRA_OWNER_DEV_PASSWORD")).toThrow(
      DEV_SECRETS_FILE
    )
  })
})

describe("profile.ts import", () => {
  afterEach(() => {
    vi.doUnmock("node:fs")
    vi.resetModules()
  })

  // Прогін на Supabase не потребує файлів секретів стека `postgres`
  it("reads neither dev-secrets.env nor login-secrets.env", async () => {
    const reads: string[] = []
    vi.resetModules()
    vi.doMock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>()
      return {
        ...actual,
        readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
          reads.push(String(args[0]))
          return actual.readFileSync(...args)
        },
      }
    })
    const fresh = await import("./profile")
    expect(fresh.TEST_STACKS.postgres.databaseUrl).toBe(
      TEST_STACKS.postgres.databaseUrl
    )
    expect(reads.filter((path) => path.endsWith("secrets.env"))).toEqual([])
    // Підстава справжня: виклик читає файл через ту саму підміну
    fresh.devSecret("SIMETRA_OWNER_DEV_PASSWORD", fresh.LOGIN_SECRETS_FILE)
    expect(reads).toContain(fresh.LOGIN_SECRETS_FILE)
  })
})

describe("SUPERUSER_PRELUDE", () => {
  it("drops any start role and pins search_path to the catalog", () => {
    expect(SUPERUSER_PRELUDE).toEqual([
      "SET ROLE NONE",
      "SET search_path = pg_catalog, pg_temp",
    ])
  })
})
