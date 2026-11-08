import { existsSync } from "node:fs"
import { basename, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import designerConfig from "../../../designer/vitest.config"
import simetraConfig from "../../vitest.config"
import { TEST_STACKS, type TestProvider } from "./profile"
import { diff, leakMessage, leftoverReport, lockPath } from "./stack-guard"
import { manualSweepSql, stackMismatch } from "./sweep"

const PROVIDERS: TestProvider[] = ["supabase", "postgres"]

describe("lockPath", () => {
  it.each([
    ["supabase", "simetra-db-stack.lock"],
    ["postgres", "simetra-db-stack-postgres.lock"],
  ] as const)("lock path per provider: %s", (p, file) => {
    expect(basename(lockPath(p))).toBe(file)
  })

  // Різні шляхи — прогони різних стеків не чекають один одного
  it("differs between providers", () => {
    expect(lockPath("supabase")).not.toBe(lockPath("postgres"))
  })
})

describe("leakMessage", () => {
  it.each(PROVIDERS)(
    "names the %s superuser for dropping an added role",
    (p) => {
      const message = leakMessage(
        [{ kind: "roles", name: "simetra_probe_abc123", change: "added" }],
        p
      )
      expect(message).toContain(
        `  DROP ROLE "simetra_probe_abc123";  -- as ${TEST_STACKS[p].superuserName}`
      )
    }
  )
})

describe("external resources", () => {
  const empty = {
    databases: [],
    roles: [],
    schemas: [],
    extensions: [],
    containers: [],
    buckets: [],
  }

  it("a container or bucket left by the run is a leak with its cleanup", () => {
    const changes = diff(empty, {
      ...empty,
      containers: ["simetra-run-abc123-x"],
      buckets: ["run-abc123"],
    })
    expect(changes).toEqual([
      { kind: "containers", name: "simetra-run-abc123-x", change: "added" },
      { kind: "buckets", name: "run-abc123", change: "added" },
    ])
    const message = leakMessage(changes, "postgres")
    expect(message).toContain("  docker rm -f -v simetra-run-abc123-x")
    expect(message).toMatch(/run-abc123.*empty and delete in Garage/)
  })

  it("names leftover buckets under their run and leftover containers", () => {
    const lines = leftoverReport(
      {
        databases: [],
        roles: [],
        containers: ["stray"],
        buckets: ["run-abc123"],
      },
      "postgres"
    )
    expect(lines).toContainEqual(
      expect.stringMatching(/run abc123: bucket run-abc123/)
    )
    expect(lines).toContainEqual(
      expect.stringContaining("docker rm -f -v stray")
    )
  })
})

describe("manualSweepSql", () => {
  it.each(PROVIDERS)("runs as the %s superuser", (p) => {
    expect(manualSweepSql("abc123", p).split("\n")[0]).toBe(
      `-- as ${TEST_STACKS[p].superuserName}, connected to database postgres; run the generated statements`
    )
  })
})

describe("stackMismatch", () => {
  it.each([
    { p: "supabase", supabaseAdmin: true, mismatch: false },
    { p: "supabase", supabaseAdmin: false, mismatch: true },
    { p: "postgres", supabaseAdmin: false, mismatch: false },
    { p: "postgres", supabaseAdmin: true, mismatch: true },
  ] as const)(
    "$p stack with supabase_admin=$supabaseAdmin: mismatch $mismatch",
    ({ p, supabaseAdmin, mismatch }) => {
      const result = stackMismatch(p, { supabaseAdmin })
      if (mismatch) expect(result).toMatch(/SIMETRA_TEST_/)
      else expect(result).toBeNull()
    }
  )
})

describe("vitest configs", () => {
  const packages = [
    {
      dir: fileURLToPath(new URL("../..", import.meta.url)),
      config: simetraConfig,
    },
    {
      dir: fileURLToPath(new URL("../../../designer", import.meta.url)),
      config: designerConfig,
    },
  ]
  const files = packages.flatMap(({ dir, config }) =>
    (config.test?.projects ?? []).flatMap((project) => {
      if (typeof project !== "object" || !("test" in project)) return []
      const test = project.test ?? {}
      const name = `${basename(dir)}/${String(test.name)}`
      return [test.globalSetup, test.setupFiles]
        .flatMap((value) =>
          value === undefined ? [] : Array.isArray(value) ? value : [value]
        )
        .map((path) => ({ name, path: resolve(dir, path) }))
    })
  )

  // Перейменований чи видалений файл vitest помітив би лише на старті DB-проєкту
  it.each(files)("globalSetup paths exist: $name $path", ({ path }) => {
    expect(existsSync(path)).toBe(true)
  })

  // Проєкт без stack-guard ішов би на стек без замка й без звірки
  it("guards every DB project", () => {
    expect(
      new Set(
        files
          .filter(({ path }) => basename(path).startsWith("stack-guard"))
          .map(({ name }) => name)
      )
    ).toEqual(new Set(["simetra/db", "simetra/bench", "designer/db"]))
  })
})

describe("leftoverReport", () => {
  const NOW = Date.UTC(2026, 9, 15, 12, 0, 0)
  const stamp = (minutesAgo: number): string =>
    (NOW - minutesAgo * 60_000).toString(36)
  const sweepCommand = (p: TestProvider, tag: string): string =>
    `    cd packages/simetra && SIMETRA_TEST_PROVIDER=${p} node --import tsx test/db/sweep.ts ${tag}`

  it("is empty when no run objects are on the stack", () => {
    expect(
      leftoverReport(
        {
          databases: ["postgres", "metahub_copy", "p3_3_spike_a"],
          roles: ["postgres", "simetra_build_plan_owner"],
        },
        "supabase",
        NOW
      )
    ).toEqual([])
  })

  it.each(PROVIDERS)(
    "names tagged objects by tag with that tag's %s sweep command",
    (p) => {
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
        p,
        NOW
      )
      expect(lines).toEqual([
        expect.stringContaining("they are not removed"),
        `  run abc123: database pgdelta_shadow_${stamp(30)}_abc123_k3j2h1 (30 min old), database simetra_copy_abc123_q1w2e3, role simetra_build_plan_owner_abc123`,
        sweepCommand(p, "abc123"),
        "  run zz9zz9: database simetra_copy_zz9zz9_q1w2e3, role simetra_probe_zz9zz9",
        sweepCommand(p, "zz9zz9"),
      ])
    }
  )

  it("names untagged shadows with a DROP each, apart from tagged objects", () => {
    const untagged = `pgdelta_shadow_${stamp(90)}_6uepn5`
    const lines = leftoverReport(
      {
        databases: [untagged, "simetra_copy_abc123_q1w2e3"],
        roles: [],
      },
      "supabase",
      NOW
    )
    expect(lines.slice(-2)).toEqual([
      expect.stringContaining("they are not removed"),
      `  DROP DATABASE "${untagged}" WITH (FORCE);  -- 90 min old`,
    ])
    expect(lines.filter((line) => line.includes("sweep.ts"))).toEqual([
      sweepCommand("supabase", "abc123"),
    ])
  })
})
