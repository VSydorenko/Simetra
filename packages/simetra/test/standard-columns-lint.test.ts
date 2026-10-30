import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { ESLint } from "eslint"
import { beforeAll, describe, expect, it } from "vitest"

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..")
const eslint = new ESLint({ cwd: PKG })

// Холодний старт конфігу — разова ціна процесу, не перевірки (як у
// `tier-boundary.test.ts`).
beforeAll(async () => {
  await eslint.lintText("", {
    filePath: join(PKG, "src/compiler/index.ts"),
    warnIgnored: true,
  })
}, 60_000)

async function restricted(code: string, file: string): Promise<number> {
  const [result] = await eslint.lintText(code, {
    filePath: join(PKG, file),
    warnIgnored: true,
  })
  return (result?.messages ?? []).filter(
    (m) => m.ruleId === "no-restricted-syntax"
  ).length
}

const GENERATOR = "src/compiler/rights/__fixture.ts"

/**
 * Рб1-2: генератор знаходить стандартну колонку за визначенням реєстру, а не
 * літералом імені, — у snake_case-проєкті літерал camelCase-імені колонки не
 * знаходить.
 */
describe("standard column lookup rule", () => {
  it.each([
    ["a literal on the right", `c.origin.standard === "customRole"`],
    ["a literal on the left", `"customRole" !== c.origin.standard`],
    ["a one-word literal", `c.origin.standard == "ref"`],
    [
      "an object literal name",
      `standardLogicalName({ logicalName: "userKind" }, style)`,
    ],
    [
      "an object literal lookup",
      `standardColumn(table, { logicalName: "customRole" }, style)`,
    ],
    [
      "an object literal style-free lookup",
      `findStyleFreeColumn(table, { logicalName: "ref" })`,
    ],
  ])("rejects %s", async (_, expression) => {
    expect(
      await restricted(`export const x = ${expression}\n`, GENERATOR)
    ).toBe(1)
  })

  it.each([
    ["the non-standard check", `c.origin.standard === undefined`],
    ["an element id", `standardElementId(id, { logicalName })`],
    ["a registry definition", `standardLogicalName(def, style)`],
    [
      "a registry lookup",
      `standardColumn(table, RIGHTS_COLUMNS.customRole, style)`,
    ],
  ])("allows %s", async (_, expression) => {
    expect(
      await restricted(`export const x = ${expression}\n`, GENERATOR)
    ).toBe(0)
  })

  it.each([
    "src/compiler/__tests__/__fixture.ts",
    "src/model/kinds/__fixture.ts",
  ])("does not apply to %s", async (file) => {
    expect(
      await restricted(`export const x = c.origin.standard === "ref"\n`, file)
    ).toBe(0)
  })
})
