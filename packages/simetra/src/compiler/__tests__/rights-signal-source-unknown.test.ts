import { describe, expect, it, vi } from "vitest"
import {
  BENCH_ZONE_TABLE,
  compileRights,
  snapshotSourcesDomain,
} from "./fixtures/rights"

/**
 * Т3 через конвеєр: таблиця фактів, яку читає згенерований код і яка не має
 * відомої форми, — помилка `rights.signal-source-unknown`, а не тихий
 * пропуск. Жодна фікстура такої форми сьогодні не дає (усі генеровані
 * читання — довідники прав, членство, «Користувачі», зв'язки, контейнери),
 * тож аналіз підставлено: `zone` читає лише дослівна функція, і мок знімає з
 * неї ознаку `verbatimOnly`, ніби її читав генерований код.
 */
vi.mock("../rights/snapshot-sources", async (actual) => {
  const module = await actual<typeof import("../rights/snapshot-sources")>()
  return {
    ...module,
    snapshotSources: (input: Parameters<typeof module.snapshotSources>[0]) => {
      const found = module.snapshotSources(input)
      return {
        ...found,
        sources: found.sources.map((s) =>
          s.table.name === BENCH_ZONE_TABLE ? { ...s, verbatimOnly: false } : s
        ),
      }
    },
  }
})

describe("rights.signal-source-unknown", () => {
  it("fails the compilation on a facts table of an unknown shape", async () => {
    const result = await compileRights(snapshotSourcesDomain())
    expect(result.ok).toBe(false)
    expect(
      result.diagnostics
        .filter((d) => d.code === "rights.signal-source-unknown")
        .map((d) => ({ severity: d.severity, params: d.params }))
    ).toEqual([
      {
        severity: "error",
        params: { table: `public.${BENCH_ZONE_TABLE}`, facts: "values" },
      },
    ])
  })
})
