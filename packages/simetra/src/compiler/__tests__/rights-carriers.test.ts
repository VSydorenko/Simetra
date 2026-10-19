import { describe, expect, it } from "vitest"
import { fieldForeignKey, inScopeTarget } from "../rights/carriers"

const scoped = { scopeKinds: [{}] } as never
const single = { scopeKinds: [] } as never

describe("inScopeTarget", () => {
  it("accepts only a composite key in a project with scope kinds", () => {
    expect(inScopeTarget({ columns: ["org_id", "ledger_id"] }, scoped)).toBe(
      true
    )
    expect(inScopeTarget({ columns: ["ledger_id"] }, scoped)).toBe(false)
    expect(inScopeTarget(undefined, scoped)).toBe(false)
  })

  it("accepts any reference in a project without scope kinds", () => {
    expect(inScopeTarget({ columns: ["ledger_id"] }, single)).toBe(true)
  })
})

describe("fieldForeignKey", () => {
  const column = (name: string, scope = false) => ({
    name,
    origin: scope ? { scopeKindId: "org" } : {},
  })
  const fk = (name: string, columns: string[]) => ({
    name,
    columns,
    references: { schema: "public", table: name, columns: ["id"] },
  })
  const table = {
    columns: [column("org_id", true), column("assignee_id")],
    foreignKeys: [
      fk("member", ["org_id", "assignee_id"]),
      fk("organization", ["org_id"]),
    ],
  } as never

  it("takes the foreign key of exactly the field column plus scope columns", () => {
    expect(fieldForeignKey(table, "assignee_id")?.name).toBe("member")
    // Скоуп-колонка входить і в складений FK поля, але її власний FK — на корінь.
    expect(fieldForeignKey(table, "org_id")?.name).toBe("organization")
    expect(fieldForeignKey(table, "note")).toBe(undefined)
  })
})
