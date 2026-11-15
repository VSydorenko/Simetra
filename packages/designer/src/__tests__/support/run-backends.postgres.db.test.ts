import pg from "pg"
import { describe, expect, it } from "vitest"
import type { EngineScope } from "simetra/schema"
import {
  runApplicationName,
  runTag,
  testProvider,
} from "../../../../simetra/test/support"
import { inTarget, withCopy } from "./db"
import { waitForRunBackendsGone } from "./shadows"

/**
 * Очікування бекендів прогону перед видаленням цілі. Закритий клієнт `pg`
 * повертається раніше, ніж його бекенд іде з сервера, а рушій видаляє ціль
 * `WITH (FORCE)` від власника профілю, який не може завершити бекенд входу
 * суперкористувача (`42501` на `postgres`). Тож прибирання тіні з шаблону
 * в обліку тіней (`db-setup.ts`, `awaitRunBackends`) чекає, доки бекенди
 * прогону підуть із неї, а не змагається з ними.
 */

const scope: EngineScope = { schemas: ["app"], provider: testProvider() }

describe("backends of the run on a target", () => {
  it("waitForRunBackendsGone names a backend of this run still on the database, then passes once it left", async () => {
    await withCopy("", async (url, name) => {
      const client = new pg.Client({ connectionString: url })
      await client.connect()
      let ended = false
      try {
        const { rows } = await client.query<{ pid: number }>(
          "SELECT pg_backend_pid() AS pid"
        )
        await expect(waitForRunBackendsGone(name, 500)).rejects.toThrow(
          `backends of this run are still connected to ${name} after 500 ms: ${rows[0]!.pid} (${runApplicationName(runTag())})`
        )
        await client.end()
        ended = true
        await waitForRunBackendsGone(name)
      } finally {
        if (!ended) await client.end()
      }
    })
  }, 30_000)

  // Клієнт, що закривається вже після повернення колбека, — найгірший
  // випадок гонки: без очікування `inTarget` повернувся б раніше за нього
  it("inTarget returns only after the run's backends left the target", async () => {
    let ended = false
    let closing: Promise<void> | undefined
    await inTarget("select 1;", scope, async (url) => {
      const client = new pg.Client({ connectionString: url })
      await client.connect()
      closing = new Promise<void>((resolve) => setTimeout(resolve, 500))
        .then(() => client.end())
        .then(() => {
          ended = true
        })
    })
    expect(ended).toBe(true)
    await closing
  }, 60_000)
})
