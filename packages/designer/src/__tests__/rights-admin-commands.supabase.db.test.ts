import { afterAll, beforeAll, describe } from "vitest"
import { pooledOf } from "./support/db"

import {
  commandsCases,
  type Env,
  heldEnv,
  heldLogin,
  type Pools,
} from "./rights-admin-commands.support"

/**
 * Команди адміністрування прав через пулер Supavisor у режимі транзакцій
 * (П4 §7.3): ті самі кейси, що й прямим портом у
 * `rights-admin-commands.db.test.ts`. Спільна підготовка —
 * `rights-admin-commands.support.ts`.
 */

describe("rights administration commands over a planned and applied target", () => {
  const target = heldEnv()
  let env: Env

  beforeAll(async () => {
    env = await target.open()
  }, 180_000)
  afterAll(() => target.close(), 60_000)

  describe("commands", () => {
    const login = heldLogin(() => env.url, true)
    let pools: Pools
    beforeAll(async () => {
      pools = await login.open()
    }, 60_000)
    afterAll(() => login.close(), 60_000)

    describe.each([["pooler", (p: Pools) => pooledOf(p.pooled)]] as const)(
      "%s",
      (_, poolOf) => {
        commandsCases({ env: () => env, pools: () => pools }, poolOf)
      }
    )
  })
})
