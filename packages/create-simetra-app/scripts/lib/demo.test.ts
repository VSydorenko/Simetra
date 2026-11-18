import { describe, expect, it } from "vitest"
import {
  DEMO_DATABASE,
  DEMO_MARK,
  demoStack,
  demoState,
  demoStep,
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

  it("refuses a stack that is not on this machine", () => {
    expect(() =>
      demoStack(
        "postgresql://postgres:postgres@db.example.com:5432/simetra",
        SECRETS
      )
    ).toThrow(/not loopback/)
  })
})
