import { beforeAll, describe, expect, it } from "vitest"
import { PLATFORM_SCHEMA } from "simetra/model"
import type { CompiledModel } from "simetra/compiler"
import { AUTHOR_FUNCTION, authorUpdateTriggerName } from "../author-units"
import { KEY_FUNCTION } from "../key-units"
import {
  MECHANICS_FUNCTION,
  mechanicsUpdateTriggerName,
} from "../mechanics-units"
import {
  SHARED_TRIGGER_FUNCTIONS,
  platformTriggers,
  type PlatformTrigger,
  type PlatformTriggerFamily,
} from "../platform-triggers"
import {
  adminRoles,
  authorCarrier,
  commandCoreLayer,
  compileRights,
  policyDomain,
  singleTenantRights,
  writeRoles,
} from "./fixtures/rights"
import { expectClean } from "./helpers"

const FAMILIES: readonly PlatformTriggerFamily[] = [
  "mechanics",
  "author",
  "key",
  "carriers",
  "hierarchy",
  "effects",
  "rightsGuards",
]

const GENERATORS: ReadonlySet<string> = new Set<PlatformTrigger["generator"]>([
  "mechanics",
  "key",
  "carriers",
  "effects",
  "rightsGuards",
])

let models: CompiledModel[]
beforeAll(async () => {
  models = []
  for (const files of [
    // Носії, ефекти, запобіжники; `Ticket` з авторством та ієрархією
    policyDomain(writeRoles(), adminRoles(), commandCoreLayer()),
    // Оновлення механіки й авторства з умовою змісту — таблиця з копіями
    singleTenantRights(authorCarrier()),
  ]) {
    const result = await compileRights(files)
    expectClean(result)
    models.push(result.model!)
  }
})

/** Функція тригера з дерева `CreateTrigStmt` одиниці. */
function triggerFunction(tree: unknown, schema: string) {
  const node = (tree as { CreateTrigStmt: { funcname: unknown[] } })
    .CreateTrigStmt
  const names = node.funcname.map(
    (n) => (n as { String: { sval: string } }).String.sval
  )
  return {
    schema: names.length > 1 ? names.at(-2)! : schema,
    name: names.at(-1)!,
  }
}

describe("platformTriggers", () => {
  it("names every platform trigger of compiled models", () => {
    const families = new Set<PlatformTriggerFamily>()
    for (const model of models) {
      // Таблиці схеми `simetra` (черга прав `rights_tx_pending` з її тригером)
      // поза межею звірки reverse і промоції, тож реєстр таблиць виду їх не
      // описує свідомо
      const tables = model.physical.tables.filter(
        (t) => t.schema !== PLATFORM_SCHEMA
      )
      let checked = 0
      for (const table of tables) {
        const registry = platformTriggers(table)
        const units = model.sqlUnits.filter(
          (u) =>
            u.class === "trigger" &&
            u.generator !== undefined &&
            GENERATORS.has(u.generator) &&
            u.identity.startsWith(`trigger:${table.schema}.${table.name}.`)
        )
        for (const unit of units) {
          const entry = registry.find((e) => e.trigger === unit.name)
          expect(entry, unit.identity).toBeDefined()
          expect(
            {
              function: entry!.function,
              generator: entry!.generator,
            },
            unit.identity
          ).toEqual({
            function: triggerFunction(unit.tree, unit.schema),
            generator: unit.generator,
          })
          families.add(entry!.family)
          checked++
        }
      }
      expect(checked).toBeGreaterThan(0)
    }
    expect([...families].sort()).toEqual([...FAMILIES].sort())
  })

  it("marks only update triggers of mechanics and author as content-bound", () => {
    const table = { schema: "public", name: "note" }
    expect(
      platformTriggers(table)
        .filter((e) => e.contentUpdate)
        .map((e) => e.trigger)
        .sort()
    ).toEqual(
      [
        mechanicsUpdateTriggerName(table.name),
        authorUpdateTriggerName(table.name),
      ].sort()
    )
  })

  it("lists the shared functions", () => {
    expect(SHARED_TRIGGER_FUNCTIONS).toEqual([
      MECHANICS_FUNCTION,
      AUTHOR_FUNCTION,
      KEY_FUNCTION,
    ])
  })
})
