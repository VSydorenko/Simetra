import { describe, expect, it } from "vitest"
import {
  DEMO_DATABASE,
  DEMO_MARK,
  busyMessage,
  demoStack,
  demoState,
  demoStep,
  noDemoMessage,
  stackNote,
  withStand,
  type DemoState,
} from "./demo.mts"

const SECRETS = {
  SIMETRA_OWNER_DEV_PASSWORD: "owner-pw",
  SIMETRA_AUTH_DEV_PASSWORD: "auth-pw",
  SIMETRA_RUNTIME_DEV_PASSWORD: "runtime-pw",
}

describe("demoState", () => {
  it.each<[{ comment: string | null } | undefined, DemoState]>([
    [undefined, "absent"],
    [{ comment: DEMO_MARK.ready }, "ready"],
    [{ comment: DEMO_MARK.incomplete }, "incomplete"],
    [{ comment: null }, "foreign"],
    [{ comment: "someone else's database" }, "foreign"],
  ])("%j → %s", (row, state) => {
    expect(demoState(row)).toBe(state)
  })
})

describe("demoStep", () => {
  it.each<["up" | "drop", Exclude<DemoState, "foreign">, string]>([
    ["up", "absent", "create"],
    ["up", "incomplete", "recreate"],
    ["up", "ready", "reuse"],
    ["drop", "absent", "nothing"],
    ["drop", "incomplete", "drop"],
    ["drop", "ready", "drop"],
  ])("%s on %s → %s", (command, state, step) => {
    expect(demoStep(command, state)).toBe(step)
  })

  it.each(["up", "drop"] as const)(
    "%s refuses a database the demo did not mark",
    (command) => {
      expect(() => demoStep(command, "foreign")).toThrow(
        /not created by the demo/
      )
    }
  )
})

describe("demoStack", () => {
  it("builds the role DSNs to the demo database of a local stack", () => {
    const { maintenanceUrl, dsns } = demoStack(
      "postgresql://postgres:postgres@127.0.0.1:54422/simetra",
      SECRETS
    )
    expect(new URL(maintenanceUrl).pathname).toBe("/postgres")
    for (const url of Object.values(dsns))
      expect(new URL(url).pathname).toBe(`/${DEMO_DATABASE}`)
    expect(new URL(dsns.SIMETRA_AUTH_DATABASE_URL).password).toBe("auth-pw")
  })

  it("builds the DSNs to the Postgres port of stack 2", () => {
    const { maintenanceUrl, dsns } = demoStack(
      "postgresql://postgres:postgres@127.0.0.1:54432/simetra",
      SECRETS
    )
    expect(new URL(maintenanceUrl).port).toBe("54432")
    for (const url of Object.values(dsns))
      expect(new URL(url).port).toBe("54432")
  })

  it("refuses a stack that is not on this machine", () => {
    expect(() =>
      demoStack(
        "postgresql://postgres:postgres@db.example.com:5432/simetra",
        SECRETS
      )
    ).toThrow(/not loopback/)
  })
})

describe("stack index in refusals", () => {
  it("keeps the stack 1 texts unchanged", () => {
    expect(stackNote(1)).toBe("")
    expect(busyMessage(1, "x")).toBe(
      "DB run in progress on the postgres stack, retry when it ends (x)"
    )
    expect(noDemoMessage(1)).toBe(
      `demo: no ${DEMO_DATABASE} database; nothing to drop`
    )
  })

  it("names the index for another stack", () => {
    expect(busyMessage(2, "x")).toContain("SIMETRA_STACK=2")
    expect(noDemoMessage(3)).toContain("SIMETRA_STACK=3")
  })
})

describe("withStand", () => {
  const stand = () => {
    const calls: string[] = []
    return {
      calls,
      down: () => {
        calls.push("down")
        return Promise.resolve()
      },
    }
  }

  it("removes the stand once when the work throws, and keeps the error", async () => {
    const s = stand()
    await expect(
      withStand(s, () => Promise.reject(new Error("key generation failed")))
    ).rejects.toThrow("key generation failed")
    expect(s.calls).toEqual(["down"])
  })

  it("removes the stand once after a normal exit and returns the result", async () => {
    const s = stand()
    await expect(withStand(s, () => Promise.resolve(7))).resolves.toBe(7)
    expect(s.calls).toEqual(["down"])
  })

  it("does not let a failing down hide the error of the work", async () => {
    await expect(
      withStand({ down: () => Promise.reject(new Error("docker gone")) }, () =>
        Promise.reject(new Error("server start failed"))
      )
    ).rejects.toThrow("server start failed")
  })
})
