import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"
import { runTool } from "../cli/command"
import { findMetadataDirs, stageMetadataDirs } from "../cli/metadata-dirs"
import { toolByName } from "../tools/catalog"
import { tmpProject } from "./helpers/tmp-project"

const exec = promisify(execFile)
const BIN = resolve(__dirname, "../../bin/simetra.mjs")
const compile = toolByName("compile")!
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true })))
})

const git = (cwd: string, ...args: string[]) => exec("git", args, { cwd })

async function emptyDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "simetra-designer-"))
  roots.push(root)
  return root
}

async function gitProject(): Promise<{ root: string; project: string }> {
  const p = await tmpProject()
  roots.push(p.root)
  await git(p.root, "init", "-q")
  await git(p.root, "config", "user.email", "t@example.com")
  await git(p.root, "config", "user.name", "t")
  await git(p.root, "add", "metadata")
  return { root: p.root, project: join(p.dir, "project.meta.json") }
}

const BROKEN = "{ not json"

/** `process.cwd()` — єдиний спосіб задати корінь для `--all`; тести ходять послідовно. */
async function runIn<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.cwd()
  process.chdir(cwd)
  try {
    return await fn()
  } finally {
    process.chdir(prev)
  }
}

describe("compile --all / --staged", () => {
  it("finds a root metadata dir and nested ones", async () => {
    const root = await emptyDir()
    await git(root, "init", "-q")
    for (const d of ["metadata", "apps/a/metadata"]) {
      await mkdir(join(root, d), { recursive: true })
      await writeFile(join(root, d, "project.meta.json"), "{}")
    }
    await git(root, "add", ".")
    expect((await findMetadataDirs(root)).sort()).toEqual([
      "apps/a/metadata",
      "metadata",
    ])
  })

  it("finds metadata dirs outside a git repo, skipping node_modules", async () => {
    const root = await emptyDir()
    for (const d of [
      "metadata",
      "apps/a/metadata",
      "node_modules/x/metadata",
    ]) {
      await mkdir(join(root, d), { recursive: true })
      await writeFile(join(root, d, "project.meta.json"), "{}")
    }
    expect(await findMetadataDirs(root)).toEqual([
      "apps/a/metadata",
      "metadata",
    ])
  })

  it("--all with explicit dirs exits 2", async () => {
    const r = await runTool(compile, { _: ["metadata"], all: true })
    expect(r.exitCode).toBe(2)
    expect(r.stderr).toContain("--all")
  })

  it("--staged outside a git repo exits 2 with a clear message", async () => {
    const root = await emptyDir()
    await mkdir(join(root, "metadata"))
    await writeFile(join(root, "metadata/project.meta.json"), "{}")
    const r = await runIn(root, () =>
      runTool(compile, { _: [], all: true, staged: true })
    )
    expect(r.exitCode).toBe(2)
    expect(r.stderr).toContain("not a git repository")
  })

  it("--all without metadata prints a note and exits 0", async () => {
    const root = await emptyDir()
    const r = await runIn(root, () => runTool(compile, { _: [], all: true }))
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain("no metadata directories found")
  })

  it("--staged checks the index, not the working tree", async () => {
    const { root, project } = await gitProject()
    const clean = await readFile(project, "utf8")

    // Індекс чистий, у робочому дереві зламано.
    await writeFile(project, BROKEN)
    const staged = await stageMetadataDirs(root, ["metadata"])
    try {
      const r = await runTool(compile, { _: staged.dirs })
      expect(r.exitCode).toBe(0)
    } finally {
      await staged.dispose()
    }
    const viaFlag = await runIn(root, () =>
      runTool(compile, { _: [], all: true, staged: true })
    )
    expect(viaFlag.exitCode).toBe(0)

    // Навпаки: індекс зламано, робоче дерево чисте.
    await git(root, "add", "metadata")
    await writeFile(project, clean)
    const broken = await runIn(root, () =>
      runTool(compile, { _: [], all: true, staged: true })
    )
    expect(broken.exitCode).toBe(1)
    const working = await runIn(root, () =>
      runTool(compile, { _: [], all: true })
    )
    expect(working.exitCode).toBe(0)
  }, 60_000)

  it("pnpm metadata:check --staged runs the real chain", async () => {
    const { root, project } = await gitProject()
    const clean = await readFile(project, "utf8")
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "chain",
        private: true,
        scripts: { "metadata:check": `node ${BIN} compile --all` },
      })
    )
    const run = () =>
      exec("pnpm", ["metadata:check", "--staged"], { cwd: root }).then(
        () => 0,
        (e: { code: number }) => e.code
      )

    await writeFile(project, BROKEN)
    expect(await run()).toBe(0)

    await git(root, "add", "metadata")
    await writeFile(project, clean)
    expect(await run()).toBe(1)
  }, 120_000)
})
