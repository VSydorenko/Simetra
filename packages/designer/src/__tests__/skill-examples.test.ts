import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import {
  addElement,
  addElementInput,
  applyChanges,
  createObject,
  createObjectInput,
} from "simetra/compiler"
import { mcpInputSchema } from "../mcp/tools"
import { TOOLS, toolByName } from "../tools/catalog"

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "../..")
const read = (name: string) =>
  readFileSync(join(pkgDir, `skills/${name}/SKILL.md`), "utf8")
const skill = read("simetra-metadata")

// Скіли їдуть до споживача, тож приклади в них не мають розходитися з каталогом.
describe.each([
  ["simetra-metadata", skill],
  ["simetra-adoption", read("simetra-adoption")],
])("%s skill examples", (_name, text) => {
  it("every json example parses with its tool's input schema", () => {
    const examples = [...text.matchAll(/```json simetra:(\S+)\n([\s\S]*?)```/g)]
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
    const blocks = [...text.matchAll(/```sh\n([\s\S]*?)```/g)]
    expect(blocks.length).toBeGreaterThan(0)
    for (const [, body] of blocks) {
      for (const line of body!.split("\n")) {
        const m = /^(?:pnpm exec |npx )?simetra\s+(\S+)/.exec(line.trim())
        if (line.trim() === "" || line.trim().startsWith("#")) continue
        expect(m, line).not.toBeNull()
        expect(known.has(m![1]!), line).toBe(true)
      }
    }
  })
})

describe("simetra-adoption skill", () => {
  it("has examples of both database tools", () => {
    const text = read("simetra-adoption")
    expect(text).toContain("```json simetra:introspect")
    expect(text).toContain("```json simetra:diff")
  })
})

describe("simetra-metadata skill", () => {
  it("every tool of the catalog is routed in the skill", () => {
    for (const t of TOOLS) expect(skill).toContain(`\`${t.name}\``)
  })

  it("the create example and the add examples on it compile", async () => {
    // Приклад копіюють агенти-споживачі: розбору входу замало, результат
    // мусить пройти компіляцію (зарезервоване ім'я, тип, властивість).
    const examples = (tool: string) =>
      [
        ...skill.matchAll(
          new RegExp(`\`\`\`json simetra:${tool}\n([\\s\\S]*?)\`\`\``, "g")
        ),
      ].map(([, body]) => JSON.parse(body!) as unknown)
    const o = {
      schemaPath: () => "schema.json",
      newId: () => crypto.randomUUID(),
    }
    let files = new Map([
      [
        "project.meta.json",
        JSON.stringify({ name: "Demo", database: { provider: "supabase" } }),
      ],
    ])
    const [create] = examples("create")
    const created = await createObject(
      files,
      createObjectInput.parse(create),
      o
    )
    expect(created.diagnostics).toEqual([])
    files = applyChanges(files, created.changes)
    const adds = examples("add")
    expect(adds.length).toBeGreaterThan(0)
    for (const add of adds) {
      const result = await addElement(files, addElementInput.parse(add), o)
      expect(result.diagnostics, JSON.stringify(add)).toEqual([])
      files = applyChanges(files, result.changes)
    }
  })

  it("the package ships the skills folder", () => {
    const pkg = JSON.parse(
      readFileSync(join(pkgDir, "package.json"), "utf8")
    ) as { files: string[] }
    expect(pkg.files).toContain("skills")
  })
})
