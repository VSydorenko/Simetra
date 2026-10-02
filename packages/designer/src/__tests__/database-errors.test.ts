import { describe, expect, it } from "vitest"
import {
  DatabaseRefusal,
  connectionErrorMessage,
  databaseResource,
  describeConnection,
  withDatabase,
} from "../io/database"
import { shadowServerRefusal } from "../schema-engine/pg-delta/adapter"

/**
 * Облікові дані не витікають (план E2b, Review Focus 3): межа
 * `connectionErrorMessage` складає текст лише зі стабільних фраз, адреси
 * `host:port/db` і коду помилки. Рядки нижче досить незвичні, щоб пошук
 * підрядка доводив їхню відсутність.
 */
const USER = "leaky_user_q7x"
const PASSWORD = "S3cret-pa55-Zq9"
const URL_ = `postgresql://${USER}:${PASSWORD}@db.example.test:6543/app_db`
const DESCRIBE = describeConnection(URL_)

function pgError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

const leaks = (text: string) =>
  [USER, PASSWORD, URL_].filter((secret) => text.includes(secret))

describe("describeConnection", () => {
  it("shows host, port and database only", () => {
    expect(DESCRIBE).toBe("db.example.test:6543/app_db")
    expect(leaks(DESCRIBE)).toEqual([])
  })

  it("defaults the port and never quotes an unparsable string", () => {
    expect(describeConnection("postgres://u:p@h/db")).toBe("h:5432/db")
    expect(describeConnection(PASSWORD)).toBe("the configured database")
  })
})

describe("connectionErrorMessage", () => {
  const cases: [string, unknown, RegExp][] = [
    [
      "a bad password",
      pgError("28P01", `password authentication failed for user "${USER}"`),
      /Authentication to the database at db\.example\.test:6543\/app_db failed/,
    ],
    [
      "an unreachable host",
      pgError("ECONNREFUSED", `connect ECONNREFUSED ${URL_}`),
      /is unreachable \(ECONNREFUSED\)/,
    ],
    [
      "an unknown host",
      pgError("ENOTFOUND", `getaddrinfo ENOTFOUND ${USER}`),
      /is unreachable \(ENOTFOUND\)/,
    ],
    [
      "a missing database",
      pgError("3D000", `database "${PASSWORD}" does not exist`),
      /does not exist/,
    ],
    [
      "any other SQLSTATE",
      pgError("25006", `cannot execute CREATE TABLE ${URL_}`),
      /\(SQLSTATE 25006\)/,
    ],
    ["an error without a code", new Error(`boom ${URL_}`), /failed \(Error\)/],
    [
      "a failed shadow cleanup",
      new AggregateError(
        [pgError("28P01", USER), new Error(PASSWORD)],
        `shadow run failed ${URL_}`
      ),
      /Authentication to the database/,
    ],
    ["a non-error", `${USER}:${PASSWORD}`, /failed\. Nothing changed\.$/],
  ]
  for (const [name, error, expected] of cases) {
    it(`redacts ${name}`, () => {
      const text = connectionErrorMessage(error, DESCRIBE)
      expect(text).toMatch(expected)
      expect(leaks(text)).toEqual([])
    })
  }

  it("lets our own refusals through as they are", () => {
    expect(
      connectionErrorMessage(new DatabaseRefusal("safe text"), DESCRIBE)
    ).toBe("safe text")
  })
})

describe("databaseResource", () => {
  it("is absent without the variable named at launch", () => {
    expect(databaseResource({}, { url: "APP_DB" })).toBeUndefined()
    expect(databaseResource({ APP_DB: "" }, { url: "APP_DB" })).toBeUndefined()
    // Типова змінна не підміняє названу
    expect(
      databaseResource({ SIMETRA_DATABASE_URL: URL_ }, { url: "APP_DB" })
    ).toBeUndefined()
  })

  it("reads the named variable and describes it without credentials", async () => {
    const resource = databaseResource({ APP_DB: URL_ }, { url: "APP_DB" })!
    expect(resource.describe).toBe(DESCRIBE)
    expect(await resource.connect()).toEqual({
      target: { url: URL_ },
      describe: DESCRIBE,
    })
  })

  it("adds the shadow server named at launch", async () => {
    const resource = databaseResource(
      { APP_DB: URL_, APP_SHADOW: "postgres://s/x" },
      { url: "APP_DB", shadow: "APP_SHADOW" }
    )!
    expect((await resource.connect()).shadowBase).toEqual({
      url: "postgres://s/x",
    })
  })

  it("refuses a shadow variable named at launch but not set", async () => {
    const resource = databaseResource(
      { APP_DB: URL_ },
      { url: "APP_DB", shadow: "APP_SHADOW" }
    )!
    await expect(resource.connect()).rejects.toThrow(
      /APP_SHADOW named by --shadow-url-env is not set/
    )
  })
})

describe("withDatabase", () => {
  it("turns any failure into a redacted refusal", async () => {
    const resource = databaseResource({ APP_DB: URL_ }, { url: "APP_DB" })!
    const error = await withDatabase(resource, () =>
      Promise.reject(
        pgError("28P01", `password authentication failed for user "${USER}"`)
      )
    ).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DatabaseRefusal)
    expect(leaks((error as Error).message)).toEqual([])
    expect((error as Error).cause).toBeUndefined()
  })
})

describe("shadow on another server", () => {
  it("is accepted with the same major version", () => {
    expect(shadowServerRefusal(17, 17)).toBeUndefined()
  })

  it("is refused with another major version", () => {
    // Другого сервера іншої мажорної версії локально немає: перевірку
    // версії адаптер робить саме цією функцією, тож версії впорскуються
    expect(shadowServerRefusal(17, 16)).toBe(
      "The shadow server runs PostgreSQL 16, the target runs PostgreSQL 17; the shadow must run the same major version. Nothing changed."
    )
  })
})
