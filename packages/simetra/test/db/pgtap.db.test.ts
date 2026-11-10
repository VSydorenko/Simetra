// Набори pgTAP профілю прогону: базовий стан стека — у Postgres, і перевірити
// його можна лише на стеку
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { testSuperuserUrl } from "./connection"
import { runPgTap } from "./pgtap"
import { testProvider } from "./profile"

const provider = testProvider()
const dir = fileURLToPath(new URL(`./pgtap/${provider}/`, import.meta.url))
const suites = existsSync(dir)
  ? readdirSync(dir)
      .filter((file) => file.endsWith(".pgtap.sql"))
      .sort()
  : []

describe(`pgTAP suites of the ${provider} stack`, () => {
  // Видалений чи перейменований набір інакше мовчки дав би зелений прогін
  if (provider === "postgres")
    it("include the stack base state", () => {
      expect(suites).toContain("stack-base-state.pgtap.sql")
    })
  else if (suites.length === 0)
    it.skip("none here: `supabase test db` checks the Supabase base state", () => {})

  it.each(suites)("%s", async (file) => {
    // Базовий стан — у базі `postgres` (кластерні факти й
    // `simetra.environment` стоять там), а не в базі тестів профілю
    const url = new URL(testSuperuserUrl())
    url.pathname = "/postgres"
    const result = await runPgTap(
      url.toString(),
      readFileSync(join(dir, file), "utf8")
    )

    expect(result.failed).toEqual([])
    expect(result.bailOut).toBeNull()
    expect(result.passed).toHaveLength(result.planned ?? -1)
  })
})
