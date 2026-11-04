import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises"
import { dirname, join } from "node:path"
import { parseArgs } from "citty"
import { afterEach, describe, expect, it } from "vitest"
import { initArgs, runInit } from "../commands/init"
import { initProject, PKG, projectTree } from "./helpers/init-project"

const disposers: (() => Promise<void>)[] = []
afterEach(async () => {
  // Послідовно й у зворотному порядку: права кореня відновлюються до видалення
  for (const d of disposers.splice(0).reverse()) await d()
})

async function project(options?: Parameters<typeof initProject>[0]) {
  const p = await initProject(options)
  disposers.push(p.dispose)
  return p.root
}

// Аргументи розбирає сам citty з оголошення команди: так тест бачить ті самі
// ключі (зокрема camelCase-аліаси й невідомі прапорці), що й справжній запуск
const run = (root: string, ...raw: string[]) =>
  runInit(parseArgs(raw, initArgs), root, "linux")

async function put(root: string, rel: string, content: string): Promise<void> {
  await mkdir(dirname(join(root, rel)), { recursive: true })
  await writeFile(join(root, rel), content)
}

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false
  )

const LINKS = [".agents/skills/a", ".claude/skills/a"]

describe("simetra init", () => {
  it("init creates links and the default config", async () => {
    const root = await project()
    const result = await run(root)
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    for (const l of LINKS) {
      expect(await readFile(join(root, l, "SKILL.md"), "utf8")).toBe("# a")
    }
    const config = JSON.parse(await readFile(join(root, ".mcp.json"), "utf8"))
    expect(config.mcpServers.simetra.args).toEqual([
      `${PKG}/dist/main.js`,
      "mcp",
    ])
    for (const absent of [".vscode", ".cursor", ".codex"]) {
      expect(await exists(join(root, absent))).toBe(false)
    }
    expect(result.stdout).toContain(
      `link .claude/skills/a -> ../../${PKG}/skills/a`
    )
    expect(result.stdout).toContain("write .mcp.json")
    expect(result.stdout).toContain("--read-only")
    expect(result.stdout).toContain("npx simetra compile --all --staged")
  })

  it("second init changes nothing", async () => {
    const root = await project()
    await run(root)
    await utimes(join(root, ".mcp.json"), 0, 0)
    const inodes = await Promise.all(
      LINKS.map(async (l) => (await lstat(join(root, l))).ino)
    )
    const result = await run(root)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("Nothing to change")
    expect(result.stdout).not.toMatch(/^(link|relink|remove|write) /m)
    expect((await stat(join(root, ".mcp.json"))).mtimeMs).toBe(0)
    for (const [i, l] of LINKS.entries()) {
      expect((await lstat(join(root, l))).ino).toBe(inodes[i])
    }
  })

  it("--check is green after init and red on drift", async () => {
    const root = await project()
    await run(root)
    const green = await run(root, "--check")
    expect(green).toMatchObject({ exitCode: 0, stderr: "" })
    await rm(join(root, ".claude/skills/a"))
    const before = await projectTree(root)
    const red = await run(root, "--check")
    expect(red.exitCode).toBe(1)
    expect(red.stdout).toContain(".claude/skills/a")
    expect(await projectTree(root)).toEqual(before)
  })

  it("--check prints neither the read-only hint nor the pre-commit line", async () => {
    const root = await project()
    const result = await run(root, "--check")
    expect(result.stdout).not.toContain("--read-only")
    expect(result.stdout).not.toContain("compile --all --staged")
  })

  it("--check is red when a selected config lacks the entry", async () => {
    const root = await project()
    await run(root)
    const result = await run(root, "--check", "--agents", "claude,cursor")
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain(".cursor/mcp.json")
    expect(await exists(join(root, ".cursor"))).toBe(false)
  })

  it("--check with a refusal exits 2", async () => {
    const root = await project()
    await put(root, ".mcp.json", "// comment\n{}")
    const result = await run(root, "--check")
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain("error: .mcp.json: invalid-json")
  })

  it("--dry-run writes nothing", async () => {
    const root = await project()
    const result = await run(root, "--dry-run")
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("link .agents/skills/a")
    expect(result.stdout).toContain("write .mcp.json")
    for (const absent of [".claude", ".agents", ".mcp.json"]) {
      expect(await exists(join(root, absent))).toBe(false)
    }
  })

  it("refuses and writes nothing", async () => {
    const root = await project()
    await put(root, ".vscode/mcp.json", "{ // comment\n}")
    const result = await run(root, "--agents", "claude,vscode")
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain("error: .vscode/mcp.json: invalid-json")
    expect(result.stdout).toBe("")
    expect(await projectTree(root)).toEqual([".vscode", ".vscode/mcp.json"])
  })

  it("aliased skill dirs init cleanly", async () => {
    const root = await project()
    await mkdir(join(root, ".claude"))
    await symlink("../.agents/skills", join(root, ".claude/skills"), "dir")
    expect(await run(root)).toMatchObject({ exitCode: 0, stderr: "" })
    for (const l of LINKS) {
      expect(await readFile(join(root, l, "SKILL.md"), "utf8")).toBe("# a")
    }
    const again = await run(root)
    expect(again.exitCode).toBe(0)
    expect(again.stdout).toContain("Nothing to change")
  })

  it("fails outside a project", async () => {
    const root = await project({ installed: false })
    const result = await run(root)
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain("@simetrajs/designer is not installed")
    expect(await projectTree(root)).toEqual([])
  })

  it.each([
    { raw: ["--agents", "claude,emacs"], names: "emacs" },
    { raw: ["--agents", ""], names: "--agents has an empty item" },
    { raw: ["--agents", "claude,"], names: "--agents has an empty item" },
    { raw: ["--agent", "codex"], names: "--agent\n" },
    { raw: ["extra"], names: '"extra"' },
    { raw: ["--check", "--dry-run"], names: "--check" },
  ])(
    "rejects bad arguments before looking for the package: $raw",
    async ({ raw, names }) => {
      const root = await project({ installed: false })
      const result = await run(root, ...raw)
      expect(result.exitCode).toBe(2)
      expect(result.stderr).toContain(names)
      expect(result.stderr).not.toContain("not installed")
    }
  )

  it("removes an own orphan link on disk", async () => {
    const root = await project()
    await mkdir(join(root, ".claude/skills"), { recursive: true })
    await symlink(`../../${PKG}/skills/old`, join(root, ".claude/skills/old"))
    const result = await run(root)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("remove .claude/skills/old")
    await expect(lstat(join(root, ".claude/skills/old"))).rejects.toMatchObject(
      { code: "ENOENT" }
    )
    expect((await run(root, "--check")).exitCode).toBe(0)
  })

  it("does not touch AGENTS.md or CLAUDE.md", async () => {
    const root = await project()
    const text = { "AGENTS.md": "# agents\n", "CLAUDE.md": "@AGENTS.md\n" }
    for (const [name, content] of Object.entries(text)) {
      await put(root, name, content)
    }
    expect((await run(root)).exitCode).toBe(0)
    for (const [name, content] of Object.entries(text)) {
      expect(await readFile(join(root, name), "utf8")).toBe(content)
    }
  })

  it("reports a file-system error while applying with code 2", async () => {
    const root = await project()
    // Корінь лише для читання: план чистий, а перший же запис падає — так
    // виглядає гонка з іншим процесом між планом і застосуванням
    await chmod(root, 0o555)
    disposers.push(() => chmod(root, 0o755))
    const result = await run(root)
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toMatch(/^error: \.agents\/skills\/a: EACCES$/m)
  })
})
