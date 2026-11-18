import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const SEED = fileURLToPath(new URL("../scripts/seed.mjs", import.meta.url))

describe("seed script", () => {
  it("refuses a remote host before connecting", () => {
    // 192.0.2.1 (TEST-NET-1) не відповідає: без відмови до `connect()` скрипт
    // завис би до таймауту, а пароль власника пішов би на чужий хост
    const run = spawnSync(process.execPath, [SEED, "1"], {
      env: {
        ...process.env,
        SIMETRA_OWNER_DATABASE_URL: "postgres://owner:secret@192.0.2.1:5432/db",
      },
      encoding: "utf8",
      timeout: 5000,
    })
    expect(run.status).toBe(1)
    expect(run.stderr).toContain("not loopback")
  })
})
