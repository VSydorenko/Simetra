import { describe, expect, it } from "vitest"
import { RIGHTS_COLUMNS, keyColumn } from "simetra/model"
import {
  findStandardColumn,
  standardColumn,
  styleFreeColumn,
} from "../standard-column"

/** Таблиця з колонкою кастомної ролі, чий `origin.standard` — у стилі `standard`. */
const assignments = (standard: string) => ({
  name: "org_role_assignments",
  columns: [
    { name: "id", origin: { standard: "ref" } },
    { name: "custom_role", origin: { standard } },
  ],
})

describe("standard column lookup", () => {
  it.each([
    ["snake_case", "custom_role"],
    ["camelCase", "customRole"],
  ] as const)("finds the registry column by its %s name", (style, standard) => {
    expect(
      standardColumn(assignments(standard), RIGHTS_COLUMNS.customRole, style)
        .name
    ).toBe("custom_role")
  })

  it("misses a column whose name is in the other style", () => {
    expect(
      findStandardColumn(
        assignments("customRole"),
        RIGHTS_COLUMNS.customRole,
        "snake_case"
      )
    ).toBeUndefined()
    expect(() =>
      standardColumn(
        assignments("customRole"),
        RIGHTS_COLUMNS.customRole,
        "snake_case"
      )
    ).toThrow(
      /^internal: missing standard column org_role_assignments\.customRole$/
    )
  })

  it("finds a style-free column without the project style and refuses a styled one", () => {
    expect(
      styleFreeColumn(assignments("custom_role"), keyColumn(false)).name
    ).toBe("id")
    expect(() =>
      styleFreeColumn(assignments("custom_role"), RIGHTS_COLUMNS.customRole)
    ).toThrow(
      /^internal: standard column customRole depends on the attribute case$/
    )
  })
})
