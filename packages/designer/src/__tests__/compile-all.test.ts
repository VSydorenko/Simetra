import { execFile } from "node:child_process"
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises"
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

const noStdin = async (): Promise<string> => ""
const runAll = (cwd: string, extra: { staged?: boolean } = {}) =>
  runTool(compile, { _: [], all: true, ...extra }, noStdin, cwd)

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
    const r = await runAll(root, { staged: true })
    expect(r.exitCode).toBe(2)
    expect(r.stderr).toContain("not a git repository")
  })

  it("--all without metadata prints a note and exits 0", async () => {
    const root = await emptyDir()
    const r = await runAll(root)
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
    const viaFlag = await runAll(root, { staged: true })
    expect(viaFlag.exitCode).toBe(0)

    // Навпаки: індекс зламано, робоче дерево чисте.
    await git(root, "add", "metadata")
    await writeFile(project, clean)
    const broken = await runAll(root, { staged: true })
    expect(broken.exitCode).toBe(1)
    const working = await runAll(root)
    expect(working.exitCode).toBe(0)
  }, 60_000)

  it("--all and --all --staged scope to the current subdirectory", async () => {
    const { root, project } = await gitProject()
    const sub = join(root, "sub")
    await mkdir(sub)
    await rename(join(root, "metadata"), join(sub, "metadata"))
    // Зламана тека поза `sub/`, але в індексі: на результат впливати не має.
    await mkdir(join(root, "other/metadata"), { recursive: true })
    await writeFile(join(root, "other/metadata/project.meta.json"), BROKEN)
    await git(root, "add", "-A")
    const moved = join(sub, "metadata/project.meta.json")
    const clean = await readFile(moved, "utf8")
    expect(project).not.toBe(moved)

    expect(await findMetadataDirs(sub)).toEqual(["metadata"])
    expect((await findMetadataDirs(root)).sort()).toEqual([
      "other/metadata",
      "sub/metadata",
    ])
    expect((await runAll(sub)).exitCode).toBe(0)
    expect((await runAll(sub, { staged: true })).exitCode).toBe(0)

    // Індекс чистий, робоче дерево зламано.
    await writeFile(moved, BROKEN)
    expect((await runAll(sub, { staged: true })).exitCode).toBe(0)
    expect((await runAll(sub)).exitCode).toBe(1)

    // Навпаки.
    await git(root, "add", "-A")
    await writeFile(moved, clean)
    expect((await runAll(sub, { staged: true })).exitCode).toBe(1)
    expect((await runAll(sub)).exitCode).toBe(0)
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
