import { describe, expect, it, vi } from "vitest"
import { compile } from "../compile"
import { adminRoles, policyDomain, writeRoles } from "./fixtures/rights"

// Місце рендеру, що «забуло» опцію: тригерна функція прав без
// `SET search_path = ''`. Окремий файл — мок діє на весь модуль.
vi.mock("../rights/definer", async (orig) => {
  const real = await orig<typeof import("../rights/definer")>()
  return {
    ...real,
    definerTrigger: (...args: Parameters<typeof real.definerTrigger>) =>
      real.definerTrigger(...args).replace("SET search_path = ''\n", ""),
  }
})

/**
 * Інваріант стоїть у самому конвеєрі (Рб1-5): компіляція відмовляє, а не
 * тихо видає функцію з шляхом сесії.
 */
describe("compile with a generated function without search_path", () => {
  it("throws internal instead of emitting the function", async () => {
    await expect(
      compile(policyDomain(writeRoles(), adminRoles()))
    ).rejects.toThrow(
      /^internal: generated function .* without SET search_path = ''$/
    )
  })
})
