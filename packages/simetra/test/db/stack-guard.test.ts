import { describe, expect, it } from "vitest"
import { leftoverReport } from "./stack-guard"

describe("leftoverReport", () => {
  const NOW = Date.UTC(2026, 9, 15, 12, 0, 0)
  const stamp = (minutesAgo: number): string =>
    (NOW - minutesAgo * 60_000).toString(36)

  it("is empty when no run objects are on the stack", () => {
    expect(
      leftoverReport(
        {
          databases: ["postgres", "metahub_copy", "p3_3_spike_a"],
          roles: ["postgres", "simetra_build_plan_owner"],
        },
        NOW
      )
    ).toEqual([])
  })

  it("names tagged objects by tag with that tag's sweep command", () => {
    const lines = leftoverReport(
      {
        databases: [
          "postgres",
          `pgdelta_shadow_${stamp(30)}_abc123_k3j2h1`,
          "simetra_copy_abc123_q1w2e3",
          "simetra_copy_zz9zz9_q1w2e3",
        ],
        roles: ["simetra_build_plan_owner_abc123", "simetra_probe_zz9zz9"],
      },
      NOW
    )
    expect(lines).toEqual([
      expect.stringContaining("they are not removed"),
      `  run abc123: database pgdelta_shadow_${stamp(30)}_abc123_k3j2h1 (30 min old), database simetra_copy_abc123_q1w2e3, role simetra_build_plan_owner_abc123`,
      "    cd packages/simetra && node --import tsx test/db/sweep.ts abc123",
      "  run zz9zz9: database simetra_copy_zz9zz9_q1w2e3, role simetra_probe_zz9zz9",
      "    cd packages/simetra && node --import tsx test/db/sweep.ts zz9zz9",
    ])
  })

  it("names untagged shadows with a DROP each, apart from tagged objects", () => {
    const untagged = `pgdelta_shadow_${stamp(90)}_6uepn5`
    const lines = leftoverReport(
      {
        databases: [untagged, "simetra_copy_abc123_q1w2e3"],
        roles: [],
      },
      NOW
    )
    expect(lines.slice(-2)).toEqual([
      expect.stringContaining("they are not removed"),
      `  DROP DATABASE "${untagged}" WITH (FORCE);  -- 90 min old`,
    ])
    expect(lines.filter((line) => line.includes("sweep.ts"))).toEqual([
      "    cd packages/simetra && node --import tsx test/db/sweep.ts abc123",
    ])
  })
})
