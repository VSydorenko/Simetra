import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { mcpInputSchema } from "../mcp/tools"
import { TOOLS, toolByName } from "../tools/catalog"

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "../..")
const skill = readFileSync(
  join(pkgDir, "skills/simetra-metadata/SKILL.md"),
  "utf8"
)

// Скіл їде до споживача, тож приклади в ньому не мають розходитися з каталогом.
describe("simetra-metadata skill", () => {
  it("every json example parses with its tool's input schema", () => {
    const examples = [
      ...skill.matchAll(/```json simetra:(\S+)\n([\s\S]*?)```/g),
    ]
    expect(examples.length).toBeGreaterThan(0)
    for (const [, name, body] of examples) {
      const tool = toolByName(name!)
      expect(tool, name).toBeDefined()
      expect(
        mcpInputSchema(tool!).safeParse(JSON.parse(body!)).success,
        name
      ).toBe(true)
    }
  })

  it("every shell example names an existing subcommand", () => {
    const known = new Set<string>([...TOOLS.map((t) => t.name), "mcp"])
    const blocks = [...skill.matchAll(/```sh\n([\s\S]*?)```/g)]
    expect(blocks.length).toBeGreaterThan(0)
    for (const [, body] of blocks) {
      for (const line of body!.split("\n")) {
        const m = /^(?:\S+\s+)*?simetra\s+(\S+)/.exec(line.trim())
        if (line.trim() === "" || line.trim().startsWith("#")) continue
        expect(m, line).not.toBeNull()
        expect(known.has(m![1]!), line).toBe(true)
      }
    }
  })

  it("every tool of the catalog is routed in the skill", () => {
    for (const t of TOOLS) expect(skill).toContain(`\`${t.name}\``)
  })

  it("the package ships the skills folder", () => {
    const pkg = JSON.parse(
      readFileSync(join(pkgDir, "package.json"), "utf8")
    ) as { files: string[] }
    expect(pkg.files).toContain("skills")
  })
})
