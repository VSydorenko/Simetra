import { describe, expect, it } from "vitest"
import { inScopeTarget } from "../rights/carriers"

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
