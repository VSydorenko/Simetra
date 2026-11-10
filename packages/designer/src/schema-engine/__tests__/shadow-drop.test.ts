import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  classifyDatabaseError,
  databaseResource,
  failureDiagnostics,
  withDatabase,
} from "../../io/database"
import { ShadowServerError } from "../errors"
import { createPgDeltaEngine } from ".."
import { dropAfter } from "../pg-delta/adapter"
import type { ProvisionedShadow } from "../pg-delta/template-shadow"

/**
 * Невидалена тінь не зникає мовчки (прибиральника тіней `pgdelta_shadow_*`
 * немає): `DROP`, що не вдався, — попередження `engine.shadow-drop-failed` з
 * іменем тіні в результаті або поле `shadowDrop` винятку. Юніт-рівень: сервер
 * замінює підмінений `pg`, відповідь якого задає кожен тест.
 */

/** Відповідь підміненого сервера на запит; виняток — збій запиту. */
let respond: (sql: string) => { rows: unknown[] } = () => ({ rows: [] })

vi.mock("pg", () => {
  class Pool {
    on(): void {}
    async query(sql: string): Promise<{ rows: unknown[] }> {
      return respond(sql)
    }
    async end(): Promise<void> {}
  }
  return { default: { Pool } }
})

const pgError = (code: string): Error =>
  Object.assign(new Error("server error"), { code })

/**
 * Тінь з шаблону на підміненому сервері: створення вдається, перше
 * підключення до тіні падає (`08006`), а `DROP` — як задано.
 */
function unreachableShadow(dropFails: boolean) {
  return (sql: string) => {
    if (sql.includes("rolcreatedb")) return { rows: [{ can: true }] }
    if (sql.includes("datistemplate")) return { rows: [{ ok: true }] }
    if (sql.startsWith("CREATE DATABASE")) return { rows: [] }
    if (sql === "select 1") throw pgError("08006")
    if (sql.startsWith("DROP DATABASE")) {
      if (dropFails) throw pgError("55006")
      return { rows: [] }
    }
    throw new Error(`unexpected query: ${sql}`)
  }
}

const probeFailure = () =>
  createPgDeltaEngine()
    .withDesiredShadow(
      { target: { url: "postgres://u:p@db.test:5432/app" } },
      "select 1",
      { schemas: ["app"], provider: "postgres" },
      () => Promise.resolve(1)
    )
    .catch((e: unknown) => e)

const failedDrop = (name: string): ProvisionedShadow => ({
  url: `postgres://127.0.0.1:1/${name}`,
  name,
  cleanup: () => Promise.resolve({ shadow: name, sqlstate: "55006" }),
})

const WARNING = {
  code: "engine.shadow-drop-failed",
  severity: "warning",
  params: { shadow: "pgdelta_shadow_t1", sqlstate: "55006" },
}

beforeEach(() => {
  respond = () => ({ rows: [] })
})

describe("a shadow that could not be dropped", () => {
  it("is a warning in the result of a run that succeeded", async () => {
    const outcome = await dropAfter(failedDrop("pgdelta_shadow_t1"), () =>
      Promise.resolve({ status: "loaded", value: 1, diagnostics: [] })
    )
    expect(outcome).toMatchObject({ status: "loaded", value: 1 })
    expect(outcome.diagnostics).toMatchObject([WARNING])
  })

  it("rides on the same error of a run that failed and is rendered beside it", async () => {
    const cause = pgError("XX000")
    const error = await dropAfter(failedDrop("pgdelta_shadow_t1"), () =>
      Promise.reject(cause)
    ).catch((e: unknown) => e)
    expect(error).toBe(cause)
    expect(error).toMatchObject({ shadowDrop: WARNING })
    const resource = databaseResource(
      { APP_DB: "postgres://u:p@db.test:5432/app" },
      { url: "APP_DB" }
    )!
    const outcome = await withDatabase(resource, "plan", () =>
      Promise.reject(error)
    )
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(failureDiagnostics(outcome).map((d) => d.code)).toEqual([
      "database.failed",
      "engine.shadow-drop-failed",
    ])
    expect(failureDiagnostics(outcome)[1]!.message).toContain(
      "pgdelta_shadow_t1"
    )
  })

  it("rides on ShadowServerError when the new shadow cannot be reached", async () => {
    respond = unreachableShadow(true)
    const error = await probeFailure()
    expect(error).toBeInstanceOf(ShadowServerError)
    const drop = (error as ShadowServerError).shadowDrop
    expect(drop).toMatchObject({
      code: "engine.shadow-drop-failed",
      severity: "warning",
      params: { sqlstate: "55006" },
    })
    expect(drop?.params.shadow).toMatch(/^pgdelta_shadow_/)
    const c = classifyDatabaseError(error, { target: "db.test:5432/app" })
    expect(c.kind).toBe("refusal")
    if (c.kind === "refusal")
      expect(c.message).toContain(String(drop?.params.shadow))
  })

  it("names no shadow when the drop succeeds", async () => {
    respond = unreachableShadow(false)
    const error = await probeFailure()
    expect(error).toBeInstanceOf(ShadowServerError)
    expect((error as ShadowServerError).shadowDrop).toBeUndefined()
  })
})
