import { describe, expect, it } from "vitest"
import { classifyDatabaseError } from "../../io/database"
import { ShadowBaseUnsupportedError } from "../errors"
import { createPgDeltaEngine } from ".."

// Юніт-рівень: відмова йде до будь-якого підключення, тож адреси нікуди не ведуть
describe("shadowBase on the postgres profile", () => {
  const o = {
    target: { url: "postgres://127.0.0.1:1/target" },
    shadowBase: { url: "postgres://127.0.0.1:1/shadow" },
  }
  const scope = { schemas: ["app"], provider: "postgres" as const }

  it.each([
    [
      "withDesiredShadow",
      () =>
        createPgDeltaEngine().withDesiredShadow(o, "select 1", scope, () =>
          Promise.resolve(1)
        ),
    ],
    [
      "withTargetClone",
      () =>
        createPgDeltaEngine().withTargetClone(
          o,
          { catalog: { scopeKey: "x" } } as never,
          scope,
          () => Promise.resolve(1)
        ),
    ],
  ])("%s refuses without touching a database", async (_name, run) => {
    const error = await run().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ShadowBaseUnsupportedError)
    expect(classifyDatabaseError(error, { target: "t" }).kind).toBe("refusal")
  })
})
