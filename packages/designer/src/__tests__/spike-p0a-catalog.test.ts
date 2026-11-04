import { writeFileSync } from "node:fs"
import { expect, it } from "vitest"
import { buildRuntimeCatalog, compile } from "simetra/compiler"
import { policyDomain, runtimeValuesLayer } from "../../../simetra/test/support"

/**
 * Спайк П0 (а), крок 8: каталог рантайму для host-а — та сама модель, що в
 * `command-runtime.db.test.ts`. Host імпортує його в збірку об'єктом (Рт17).
 * Лише в спайк-гілці; без `SPIKE_CATALOG_OUT` — пропуск.
 */
it.skipIf(!process.env.SPIKE_CATALOG_OUT)(
  "spike P0 (a): writes the runtime catalog",
  async () => {
    const result = await compile(policyDomain(runtimeValuesLayer()))
    expect(result.diagnostics).toEqual([])
    const catalog = buildRuntimeCatalog(result.model!)
    writeFileSync(
      process.env.SPIKE_CATALOG_OUT!,
      JSON.stringify(catalog, null, 2)
    )
  }
)
