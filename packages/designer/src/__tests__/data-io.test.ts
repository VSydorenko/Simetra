import { inspect } from "node:util"
import pg from "pg"
import { afterEach, describe, expect, it, vi } from "vitest"
import { DataGuardRefusal } from "../io/data-guard-refusal"
import {
  checkEnvName,
  dataResource,
  dataSession,
  isLocalHost,
  parseDataLaunch,
} from "../io/data"
import { DatabaseRefusal } from "../io/database"
import { UsageError } from "../io/usage-error"

const AS = "00000000-0000-4000-8000-0000000000a1"
const AGENT = "00000000-0000-4000-8000-0000000000a2"
/** Рядок підключення там, де чекають ім'я змінної чи UUID: не мусить потрапити в текст. */
const SECRET_URL = "postgresql://u:secret@h/x"

afterEach(() => {
  vi.restoreAllMocks()
})

describe("isLocalHost", () => {
  it.each([
    ["localhost", true],
    ["127.0.0.1", true],
    ["127.10.0.5", true],
    ["::1", true],
    ["/var/run/postgresql", true],
    ["/tmp", true],
    ["db.example.com", false],
    ["10.0.0.1", false],
    ["128.0.0.1", false],
    ["localhost.example.com", false],
    ["127.0.0.1,db.example.com", false],
    ["", false],
    [undefined, false],
  ])("%s → %s", (host, expected) => {
    expect(isLocalHost(host)).toBe(expected)
  })
})

describe("the host pg connects to", () => {
  // Запобіжник перевіряє те, що візьме `pg`, а не `new URL().hostname`:
  // `?host=` перекриває хост з authority
  it.each([
    ["postgresql://u:p@db.example.com/x", "db.example.com"],
    ["postgresql:///x?host=/tmp", "/tmp"],
    ["postgresql://u:p@127.0.0.1:54322/x", "127.0.0.1"],
    ["postgresql://u:p@localhost/x?host=db.example.com", "db.example.com"],
  ])("%s → %s", (connectionString, host) => {
    expect(new pg.Client({ connectionString }).host).toBe(host)
  })
})

describe("dataResource", () => {
  const open = (url: string) =>
    dataResource({ X: url }, { urlEnv: "X", as: AS })!.open("supabase")

  it("is absent without the variable", () => {
    expect(dataResource({}, { urlEnv: "X", as: AS })).toBeUndefined()
    expect(dataResource({ X: "" }, { urlEnv: "X", as: AS })).toBeUndefined()
  })

  it("describes the connection without credentials", () => {
    const r = dataResource(
      { X: "postgresql://u:secret@localhost:54322/app" },
      { urlEnv: "X", as: AS, agent: AGENT }
    )!
    expect(r).toMatchObject({
      describe: "localhost:54322/app",
      as: AS,
      agent: AGENT,
    })
  })

  it.each([
    "postgresql://u:secret@db.example.com:5432/x",
    "postgresql://u:secret@localhost/x?host=db.example.com",
  ])("refuses a remote host before any pool: %s", async (url) => {
    const pool = vi.spyOn(pg, "Pool")
    const error: unknown = await open(url).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DataGuardRefusal)
    expect((error as DataGuardRefusal).detail).toBe("not-local")
    expect((error as Error).message).not.toContain("secret")
    expect((error as Error).message).not.toContain("u:")
    expect(pool).not.toHaveBeenCalled()
  })

  it("refuses an invalid URL without quoting it", async () => {
    const pool = vi.spyOn(pg, "Pool")
    const error: unknown = await open("postgresql://u:secret@[bad/x").catch(
      (e: unknown) => e
    )
    expect(error).toBeInstanceOf(DatabaseRefusal)
    expect((error as Error).message).toContain("X")
    expect((error as Error).message).not.toContain("secret")
    expect(inspect(error)).not.toContain("secret")
    expect(pool).not.toHaveBeenCalled()
  })
})

describe("parseDataLaunch", () => {
  it("is absent when no data flag is given", () => {
    expect(parseDataLaunch({})).toBeUndefined()
  })

  it("returns the launch of a full set", () => {
    expect(parseDataLaunch({ dataUrlEnv: "APP_DATA", as: AS })).toEqual({
      urlEnv: "APP_DATA",
      as: AS,
    })
    expect(
      parseDataLaunch({ dataUrlEnv: "APP_DATA", as: AS, agent: AGENT })
    ).toEqual({ urlEnv: "APP_DATA", as: AS, agent: AGENT })
  })

  it.each([
    ["--as is not a UUID", { dataUrlEnv: "X", as: SECRET_URL }, "--as"],
    [
      "--agent is not a UUID",
      { dataUrlEnv: "X", as: AS, agent: SECRET_URL },
      "--agent",
    ],
    ["--as without --data-url-env", { as: AS }, "--data-url-env"],
    ["--data-url-env without --as", { dataUrlEnv: "X" }, "--as"],
    ["--agent without --as", { agent: AGENT }, "--agent"],
    [
      "--agent without --as, with --data-url-env",
      { dataUrlEnv: "X", agent: AGENT },
      "--agent",
    ],
    [
      "--data-url-env is not a variable name",
      { dataUrlEnv: SECRET_URL, as: AS },
      "--data-url-env",
    ],
  ])("%s → usage error naming the flag", (_, flags, flag) => {
    let error: unknown
    try {
      parseDataLaunch(flags)
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(UsageError)
    expect((error as Error).message).toContain(flag)
    expect((error as Error).message).not.toContain("secret")
  })
})

describe("checkEnvName", () => {
  it.each(["--database-url-env", "--shadow-url-env"])(
    "%s rejects a value that is not a variable name, without quoting it",
    (flag) => {
      for (const value of [SECRET_URL, "1X", "A-B", ""]) {
        let error: unknown
        try {
          checkEnvName(flag, value)
        } catch (e) {
          error = e
        }
        expect(error, value).toBeInstanceOf(UsageError)
        expect((error as Error).message).toContain(flag)
        expect((error as Error).message).not.toContain("secret")
      }
      for (const value of ["SIMETRA_DATABASE_URL", "_x1", "a"])
        expect(() => checkEnvName(flag, value)).not.toThrow()
    }
  )
})

describe("dataSession", () => {
  it("acts as the user and names the agent in act", () => {
    expect(dataSession("supabase", { as: AS, agent: AGENT })).toEqual({
      sub: AS,
      role: "authenticated",
      act: { sub: AGENT },
    })
  })

  it("has no act without an agent", () => {
    expect(dataSession("supabase", { as: AS })).toEqual({
      sub: AS,
      role: "authenticated",
    })
  })
})
