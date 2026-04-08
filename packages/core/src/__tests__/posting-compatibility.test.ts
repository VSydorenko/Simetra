import { describe, it, expect } from "vitest"
import { isPostingCompatible } from "../posting-compatibility"
import { formatValidationMessage } from "../validation-message"
import type { AccumulationRegister, InformationRegister } from "../schemas"

/** Мінімальний AccumulationRegister для тестів */
function makeAccumulationRegister(
  registerType: "Balance" | "Turnover"
): AccumulationRegister {
  return {
    kind: "AccumulationRegister",
    name: "TestRegister",
    registerType,
    recorderTypes: [],
    standardAttributeOverrides: {},
    dimensions: [],
    resources: [],
    attributes: [],
  }
}

/** Мінімальний InformationRegister для тестів */
function makeInformationRegister(
  writeMode: "Independent" | "RecorderSubordinate"
): InformationRegister {
  return {
    kind: "InformationRegister",
    name: "TestInfoRegister",
    periodicity: "NonPeriodic",
    writeMode,
    recorderTypes: [],
    standardAttributeOverrides: {},
    dimensions: [],
    resources: [],
    attributes: [],
  }
}

describe("isPostingCompatible", () => {
  it("AccumulationRegister Balance -> compatible", () => {
    const result = isPostingCompatible(makeAccumulationRegister("Balance"))
    expect(result.compatible).toBe(true)
    expect(result.reason).toBeUndefined()
  })

  it("AccumulationRegister Turnover -> compatible", () => {
    const result = isPostingCompatible(makeAccumulationRegister("Turnover"))
    expect(result.compatible).toBe(true)
    expect(result.reason).toBeUndefined()
  })

  it("InformationRegister RecorderSubordinate -> compatible", () => {
    const result = isPostingCompatible(
      makeInformationRegister("RecorderSubordinate")
    )
    expect(result.compatible).toBe(true)
    expect(result.reason).toBeUndefined()
  })

  it("InformationRegister Independent -> incompatible with reason", () => {
    const result = isPostingCompatible(makeInformationRegister("Independent"))
    expect(result.compatible).toBe(false)
    expect(formatValidationMessage(result.reason ?? "")).toContain(
      "writeMode=Independent"
    )
    expect(formatValidationMessage(result.reason ?? "")).toContain(
      "cannot be used as a posting target"
    )
  })
})
