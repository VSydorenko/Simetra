import { PROVIDER_API_ROLES } from "simetra/model"
import { describe, expect, it, vi } from "vitest"
import { ZodError } from "zod"
import { createCommandRuntime, readRoleOf } from "../runtime"
import { fakeDatabase, failureOf, type Answer } from "./fake-database"
import { catalog } from "./fixtures"

const BEGIN = {
  text: "BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY",
  params: [],
}
const MEMBER = {
  text: "SELECT pg_has_role(session_user, $1, 'SET') AS member",
  params: ["authenticated"],
}
const ROLE = { text: 'SET LOCAL ROLE "simetra_command"', params: [] }
const HASH = {
  text: 'SELECT "simetra"."applied_snapshot_hash"() AS hash',
  params: [],
}
const COMMIT = { text: "COMMIT", params: [] }
const ROLLBACK = { text: "ROLLBACK", params: [] }

/** Порт відповідає як база з моделлю каталогу; `override` — про що кейс. */
function create(
  override: (text: string) => Answer | undefined = () => undefined,
  options: { readFallback?: boolean; objectModules?: never } = {}
) {
  const db = fakeDatabase({
    query: (text) =>
      override(text) ??
      (text === HASH.text
        ? { rows: [{ hash: "hash-1" }] }
        : text === MEMBER.text
          ? { rows: [{ member: "t" }] }
          : {}),
  })
  const log = vi.fn()
  const runtime = createCommandRuntime({
    database: db.database,
    catalog,
    log,
    ...options,
  })
  return { db, runtime, log }
}

describe("createCommandRuntime", () => {
  it("checks membership, role and hash in one read-only transaction", async () => {
    const { db, runtime } = create()
    await runtime
    expect(db.calls).toEqual([
      { connect: true },
      BEGIN,
      MEMBER,
      ROLE,
      HASH,
      COMMIT,
      { release: false },
    ])
  })

  it("rejects another applied hash with both hashes", async () => {
    const { runtime } = create((text) =>
      text === HASH.text ? { rows: [{ hash: "hash-0" }] } : undefined
    )
    expect(await failureOf(runtime)).toEqual({
      code: "command.model-mismatch",
      hashes: { catalog: "hash-1", applied: "hash-0" },
    })
  })

  it.each([
    ["no marker", { rows: [{ hash: null }] }],
    ["no hash function (42883)", { error: { code: "42883", message: "x" } }],
    ["no platform schema (3F000)", { error: { code: "3F000", message: "x" } }],
  ])("rejects %s as a mismatch with applied null", async (_, answer) => {
    const { db, runtime } = create((text) =>
      text === HASH.text ? (answer as Answer) : undefined
    )
    expect(await failureOf(runtime)).toEqual({
      code: "command.model-mismatch",
      hashes: { catalog: "hash-1", applied: null },
    })
    expect(db.calls).toEqual([
      { connect: true },
      BEGIN,
      MEMBER,
      ROLE,
      HASH,
      "error" in answer ? ROLLBACK : COMMIT,
      { release: false },
    ])
  })

  it("rejects a missing request role membership with the role", async () => {
    const { runtime } = create((text) =>
      text === MEMBER.text ? { rows: [{ member: "f" }] } : undefined
    )
    expect(await failureOf(runtime)).toEqual({
      code: "command.read-role-missing",
      role: "authenticated",
    })
  })

  it("treats a request role absent from the database (42704) as missing", async () => {
    const absent = (text: string): Answer | undefined =>
      text === MEMBER.text
        ? { error: { code: "42704", message: "x" } }
        : undefined
    const { db, runtime } = create(absent)
    expect(await failureOf(runtime)).toEqual({
      code: "command.read-role-missing",
      role: "authenticated",
    })
    // Перервана транзакція — хеш звіряє друга, без кроку членства.
    expect(db.calls).toEqual([
      { connect: true },
      BEGIN,
      MEMBER,
      ROLLBACK,
      { release: false },
      { connect: true },
      BEGIN,
      ROLE,
      HASH,
      COMMIT,
      { release: false },
    ])
    await expect(
      create(absent, { readFallback: true }).runtime
    ).resolves.toHaveProperty("run")
  })

  it("lets readFallback replace the missing membership", async () => {
    const { runtime } = create(
      (text) =>
        text === MEMBER.text ? { rows: [{ member: "f" }] } : undefined,
      { readFallback: true }
    )
    await expect(runtime).resolves.toHaveProperty("run")
  })

  it("maps a failed connect to command.unavailable and logs the original error", async () => {
    const raw = new Error("refused")
    const db = fakeDatabase({
      query: () => ({}),
      connect: () => ({ error: raw }),
    })
    const log = vi.fn()
    const runtime = createCommandRuntime({
      database: db.database,
      catalog,
      log,
    })
    expect(await failureOf(runtime)).toEqual({ code: "command.unavailable" })
    expect(db.calls).toEqual([{ connect: true }])
    expect(log.mock.calls).toEqual([[{ kind: "database", error: raw }]])
  })

  it("destroys the connection on an error without SQLSTATE and logs it", async () => {
    const raw = new TypeError("driver bug")
    const { db, runtime, log } = create((text) =>
      text === HASH.text ? { error: raw } : undefined
    )
    expect(await failureOf(runtime)).toEqual({ code: "command.unavailable" })
    expect(db.calls).toEqual([
      { connect: true },
      BEGIN,
      MEMBER,
      ROLE,
      HASH,
      { release: true },
    ])
    expect(log.mock.calls).toEqual([[{ kind: "database", error: raw }]])
  })

  it("maps a refused SET LOCAL ROLE to command.internal and logs it", async () => {
    const raw = { code: "42501", message: "permission denied to set role" }
    const { db, runtime, log } = create((text) =>
      text === ROLE.text ? { error: raw } : undefined
    )
    expect(await failureOf(runtime)).toEqual({ code: "command.internal" })
    expect(log).toHaveBeenCalledWith({ kind: "database", error: raw })
    expect(db.calls).toEqual([
      { connect: true },
      BEGIN,
      MEMBER,
      ROLE,
      ROLLBACK,
      { release: false },
    ])
  })

  it.each([
    ["an unknown object", { "Catalog.Nope": {} }],
    [
      "a key outside OBJECT_MODULE_KEYS",
      { "Catalog.Client": { beforeDelete: () => {} } },
    ],
  ])("rejects %s before the database", async (_, objectModules) => {
    const db = fakeDatabase({ query: () => ({}) })
    await expect(
      createCommandRuntime({
        database: db.database,
        catalog,
        objectModules: objectModules as never,
      })
    ).rejects.toThrow(/objectModules/)
    expect(db.calls).toEqual([])
  })

  it("rejects an invalid catalog before the database", async () => {
    const db = fakeDatabase({ query: () => ({}) })
    await expect(
      createCommandRuntime({
        database: db.database,
        catalog: { ...catalog, format: 2 },
      })
    ).rejects.toBeInstanceOf(ZodError)
    expect(db.calls).toEqual([])
  })

  it.each([
    ["maxAttempts", 0],
    ["maxAttempts", 1.5],
    ["maxDepth", 0],
  ])("rejects %s = %s before the database", async (option, value) => {
    const db = fakeDatabase({ query: () => ({}) })
    await expect(
      createCommandRuntime({ database: db.database, catalog, [option]: value })
    ).rejects.toBeInstanceOf(ZodError)
    expect(db.calls).toEqual([])
  })
})

describe("readRoleOf", () => {
  it.each([
    [["user"] as const, "authenticated"],
    [[] as const, undefined],
  ])("reads purposes %j as %s", (purposes, role) => {
    expect(
      readRoleOf("supabase", { supabase: purposes }, PROVIDER_API_ROLES)
    ).toBe(role)
  })
})
