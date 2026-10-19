import { describe, expect, it } from "vitest"
// Скрипти релізу лежать у корені репо, де немає vitest; їхні чисті функції
// тестуються тут, у пакеті з тестовим раннером
import {
  distTagFor,
  publishedState,
} from "../../../scripts/release/registry.mjs"

describe("publishedState", () => {
  it.each([
    [{ code: 0, stdout: '"0.1.0"\n', stderr: "" }, "published"],
    // Пакет у реєстрі є, цієї версії — немає: npm view мовчить з кодом 0
    [{ code: 0, stdout: "", stderr: "" }, "absent"],
    // Пакета в реєстрі немає взагалі
    [{ code: 1, stdout: "", stderr: "npm error code E404\n" }, "absent"],
  ] as const)("%o → %s", (result, expected) => {
    expect(publishedState(result, "0.1.0")).toBe(expected)
  })

  it("throws on a registry error that is not 404", () => {
    expect(() =>
      publishedState(
        { code: 1, stdout: "", stderr: "npm error code ETIMEDOUT\n" },
        "0.1.0"
      )
    ).toThrow(/ETIMEDOUT/)
  })

  it("throws when the registry reports another version", () => {
    expect(() =>
      publishedState({ code: 0, stdout: '"0.0.9"\n', stderr: "" }, "0.1.0")
    ).toThrow()
  })
})

describe("distTagFor", () => {
  it.each([
    ["0.1.0", "latest"],
    ["1.0.0-rc.1", "next"],
  ])("%s → %s", (version, tag) => {
    expect(distTagFor(version)).toBe(tag)
  })
})
