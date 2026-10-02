import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { ESLint } from "eslint"
import { describe, expect, it } from "vitest"

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..")
const eslint = new ESLint({ cwd: PKG })

async function restricted(code: string, file: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, {
    filePath: join(PKG, file),
    warnIgnored: true,
  })
  return (result?.messages ?? [])
    .filter((m) => m.ruleId === "no-restricted-imports")
    .map((m) => m.message)
}
const importOf = (s: string) =>
  `import { probe } from "${s}"\nexport const used = probe\n`

const START = [
  "@tanstack/react-start",
  "@tanstack/react-start/server",
  "@tanstack/start",
  "@tanstack/start-server-core",
]

describe("studio zone", () => {
  it("rejects TanStack Start outside src/studio", async () => {
    for (const file of [
      "src/cli/x.ts",
      "src/tools/x.ts",
      "src/x.tsx",
      "src/schema-engine/__tests__/x.test.ts",
    ])
      for (const spec of START) {
        const msgs = await restricted(importOf(spec), file)
        expect(msgs, `${file}: ${spec}`).toHaveLength(1)
        expect(msgs[0]).toContain("Framework boundary")
      }
    expect(
      await restricted(
        `import type { X } from "@tanstack/react-start"\nexport type Y = X\n`,
        "src/mcp/x.ts"
      )
    ).toHaveLength(1)
  })

  it("allows TanStack Start inside src/studio", async () => {
    for (const spec of START)
      expect(
        await restricted(importOf(spec), "src/studio/x.tsx"),
        spec
      ).toEqual([])
    expect(
      await restricted(importOf("@tanstack/react-router"), "src/cli/x.ts"),
      "router is not the host framework"
    ).toEqual([])
  })
})
