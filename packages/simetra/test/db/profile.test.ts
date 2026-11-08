import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  enterProvider,
  garageAdminToken,
  PROVIDER_ENV,
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
    const missing = join(mkdtempSync(join(tmpdir(), "profile-")), "none.env")
    expect(() => garageAdminToken(missing)).toThrow(missing)
  })
})
