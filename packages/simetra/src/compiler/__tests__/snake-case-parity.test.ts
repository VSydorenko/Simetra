import { describe, expect, it } from "vitest"
import { compile } from "../compile"
import {
  adminRoles,
  authorCarrier,
  commandCoreLayer,
  policyDomain,
  singleTenantRights,
  writeRoles,
} from "./fixtures/rights"
import { snakeCaseTwin } from "./fixtures/snake-case"

/**
 * Матриця «кожен генератор × стиль атрибутів» одним тестом: фізичні
 * імена від стилю не залежать, тож SQL близнюка в `snake_case` мусить
 * збігтися з camelCase одиниця в одиницю. Генератор, що шукає стандартну
 * колонку літералом camelCase-імені, тут або кидає `internal:`, або дає
 * інший SQL.
 */
describe("snake_case twin of a rights project", () => {
  it.each([
    [
      "policy domain with write and admin roles",
      () => policyDomain(writeRoles(), adminRoles()),
    ],
    [
      "command-core catalog with tabular section and hierarchy",
      () => policyDomain(writeRoles(), commandCoreLayer()),
    ],
    [
      "single-tenant rights with author carriers",
      () =>
        singleTenantRights({ ...authorCarrier(), ...authorCarrier("long") }),
    ],
  ])("%s compiles to the same SQL", async (_, files) => {
    const camel = await compile(files())
    expect(camel.diagnostics).toEqual([])
    const snake = await compile(snakeCaseTwin(files()))
    expect(snake.diagnostics).toEqual([])
    expect(snake.model!.project.naming.attributeCase).toBe("snake_case")
    const units = (result: typeof camel) =>
      new Map(result.model!.sqlUnits.map((u) => [u.identity, u.sql]))
    expect(units(snake)).toEqual(units(camel))
  })
})
