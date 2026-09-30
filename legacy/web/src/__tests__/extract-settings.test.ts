import { describe, expect, it } from "vitest"
import type { MetadataObject } from "@simetra/core"
import { extractStandardAttributeSettings } from "../lib/extract-settings"

describe("extractStandardAttributeSettings", () => {
  it("повертає recorderTypes для InformationRegister", () => {
    const recorderTypes = [{ kind: "Document", name: "SalesOrder" }] as const
    const object = {
      kind: "InformationRegister",
      name: "Prices",
      periodicity: "Month",
      writeMode: "RecorderSubordinate",
      recorderTypes: [...recorderTypes],
    } as MetadataObject

    expect(
      extractStandardAttributeSettings("InformationRegister", object)
    ).toEqual({
      periodicity: "Month",
      writeMode: "RecorderSubordinate",
      recorderTypes: [...recorderTypes],
    })
  })

  it("повертає recorderTypes для AccumulationRegister", () => {
    const recorderTypes = [{ kind: "Document", name: "SalesOrder" }] as const
    const object = {
      kind: "AccumulationRegister",
      name: "StockBalance",
      registerType: "Balance",
      recorderTypes: [...recorderTypes],
    } as MetadataObject

    expect(
      extractStandardAttributeSettings("AccumulationRegister", object)
    ).toEqual({
      registerType: "Balance",
      recorderTypes: [...recorderTypes],
    })
  })
})
