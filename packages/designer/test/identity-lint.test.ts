import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { ESLint } from "eslint"
import { beforeAll, describe, expect, it } from "vitest"

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..")
const eslint = new ESLint({ cwd: PKG })

beforeAll(async () => {
  await eslint.lintText("", {
    filePath: join(PKG, "src/tools/__fixture.ts"),
    warnIgnored: true,
  })
}, 60_000)

async function identityErrors(code: string, file: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, {
    filePath: join(PKG, file),
    warnIgnored: true,
  })
  const messages = result?.messages ?? []
  const broken = messages.filter((m) => m.fatal || m.ruleId === null)
  if (broken.length > 0)
    throw new Error(
      `lint did not run: ${broken.map((m) => m.message).join("; ")}`
    )
  return messages
    .filter((m) => m.ruleId === "no-restricted-syntax")
    .map((m) => m.message)
}

const TEMPLATE = "export const id = (t: string) => `trigger:${t}`\n"

describe("unit identity assembled only in simetra/compiler (#297, R4)", () => {
  it("rejects a template identity in production src", async () => {
    expect(
      await identityErrors(TEMPLATE, "src/tools/__fixture.ts")
    ).toHaveLength(1)
  })

  it("allows tests and support files", async () => {
    expect(await identityErrors(TEMPLATE, "src/tools/__tests__/x.ts")).toEqual(
      []
    )
    expect(await identityErrors(TEMPLATE, "src/tools/x.support.ts")).toEqual([])
  })
})
