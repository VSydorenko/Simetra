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
  profileStack,
  stackEnvPrefix,
  testProvider,
  testStack,
} from "./profile"

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("testProvider", () => {
  it("defaults to postgres when the variable is not set", () => {
    vi.stubEnv(PROVIDER_ENV, "")
    delete process.env[PROVIDER_ENV]
    expect(testProvider()).toBe("postgres")
  })

  it("reads the profile from the variable", () => {
    vi.stubEnv(PROVIDER_ENV, "postgres")
    expect(testProvider()).toBe("postgres")
    expect(testStack()).toEqual(profileStack("postgres"))
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
    enterProvider("postgres")
    expect(() => enterProvider("supabase")).toThrow(PROVIDER_ENV)
  })

  it("accepts the same profile twice", () => {
    vi.stubEnv(PROVIDER_ENV, "postgres")
    expect(() => enterProvider("postgres")).not.toThrow()
  })
})

describe("profileStack", () => {
  it.each(["postgres", "supabase"] as const)(
    "%s: every address is on 127.0.0.1",
    (name) => {
      const stack = profileStack(name)
      const urls = [
        stack.databaseUrl,
        stack.superuserUrl,
        stack.poolerUrl,
        stack.garageAdminUrl,
        stack.garageS3Url,
      ].filter((u) => u !== null)
      for (const url of urls) expect(new URL(url).hostname).toBe("127.0.0.1")
    }
  )

  // База тестів `simetra`, а стартовий параметр — роль власника на
  // кожному новому з'єднанні з адреси тестів
  it("postgres: tests run in database simetra as the owner, the superuser without options", () => {
    const tests = new URL(profileStack("postgres").databaseUrl)
    expect(tests.pathname).toBe("/simetra")
    expect(tests.searchParams.getAll("options")).toEqual([
      `-c role=${PROVIDER_OWNER_ROLES.postgres}`,
    ])
    const superuser = new URL(profileStack("postgres").superuserUrl)
    expect(superuser.pathname).toBe("/simetra")
    expect(superuser.searchParams.has("options")).toBe(false)
    expect(superuser.username).toBe(profileStack("postgres").superuserName)
  })

  it("gives each profile its own lock file, keeping the Supabase name", () => {
    expect(profileStack("supabase").lockFile).toBe("simetra-db-stack.lock")
    expect(profileStack("postgres").lockFile).not.toBe(
      profileStack("supabase").lockFile
    )
  })
})

// Інваріант 1 (адреси): індекс читається на виклик, не при імпорті
describe("profileStack and the stack index", () => {
  it("stack 1 keeps today's addresses, key and lock file", () => {
    vi.stubEnv("SIMETRA_STACK", undefined)
    const s = profileStack("postgres")
    expect(s.index).toBe(1)
    expect(s.key).toBe("postgres")
    expect(s.superuserUrl).toBe(
      "postgresql://postgres:postgres@127.0.0.1:54422/simetra"
    )
    expect(
      s.databaseUrl.startsWith(
        "postgresql://postgres:postgres@127.0.0.1:54422/simetra?options="
      )
    ).toBe(true)
    expect(s.garageAdminUrl).toBe("http://127.0.0.1:3903")
    expect(s.garageS3Url).toBe("http://127.0.0.1:3900")
    expect(s.lockFile).toBe("simetra-db-stack-postgres.lock")
  })

  it("SIMETRA_STACK=2: every address, the key and the lock are stack 2's", () => {
    vi.stubEnv("SIMETRA_STACK", "2")
    const s = profileStack("postgres")
    expect(s.index).toBe(2)
    expect(s.key).toBe("postgres-2")
    expect(new URL(s.databaseUrl).port).toBe("54432")
    expect(new URL(s.superuserUrl).port).toBe("54432")
    expect(s.garageAdminUrl).toBe("http://127.0.0.1:3913")
    expect(s.garageS3Url).toBe("http://127.0.0.1:3910")
    expect(s.lockFile).toBe("simetra-db-stack-postgres-2.lock")
  })

  it("follows the variable on every call, not at import", () => {
    vi.stubEnv("SIMETRA_STACK", "2")
    const second = profileStack("postgres")
    vi.stubEnv("SIMETRA_STACK", "3")
    expect(profileStack("postgres").key).toBe("postgres-3")
    expect(second.key).toBe("postgres-2")
  })

  it("an invalid SIMETRA_STACK is an error naming the variable, not stack 1", () => {
    vi.stubEnv("SIMETRA_STACK", "0")
    expect(() => profileStack("postgres")).toThrow("SIMETRA_STACK")
  })

  it("supabase has no index: refused under SIMETRA_STACK=2 and a pool, unchanged otherwise", () => {
    vi.stubEnv("SIMETRA_STACK", "2")
    expect(() => profileStack("supabase")).toThrow("ADR-0117")
    vi.stubEnv("SIMETRA_STACK", undefined)
    vi.stubEnv("SIMETRA_STACK_POOL", "1,2")
    expect(() => profileStack("supabase")).toThrow("ADR-0117")
    vi.stubEnv("SIMETRA_STACK_POOL", undefined)
    expect(profileStack("supabase").key).toBe("supabase")
    expect(profileStack("supabase").garageS3Url).toBeNull()
  })

  it("prefixes printed commands with SIMETRA_STACK only for N other than 1", () => {
    vi.stubEnv("SIMETRA_STACK", undefined)
    expect(stackEnvPrefix(profileStack("postgres"))).toBe("")
    expect(stackEnvPrefix(profileStack("supabase"))).toBe("")
    vi.stubEnv("SIMETRA_STACK", "3")
    expect(stackEnvPrefix(profileStack("postgres"))).toBe("SIMETRA_STACK=3 ")
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
    expect(fresh.profileStack("postgres").databaseUrl).toBe(
      profileStack("postgres").databaseUrl
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
