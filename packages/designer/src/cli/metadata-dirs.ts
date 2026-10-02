import { spawn } from "node:child_process"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { UsageError } from "../io/usage-error"

const PROJECT_FILE = "project.meta.json"

interface GitResult {
  status: number
  stdout: string
  stderr: string
}

function git(cwd: string, args: string[], input?: string): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd })
    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout.on("data", (c: Buffer) => out.push(c))
    child.stderr.on("data", (c: Buffer) => err.push(c))
    child.on("error", reject)
    child.on("close", (status) =>
      resolve({
        status: status ?? 1,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      })
    )
    child.stdin.on("error", () => undefined)
    child.stdin.end(input)
  })
}

async function isGitRepo(cwd: string): Promise<boolean> {
  return (await git(cwd, ["rev-parse", "--is-inside-work-tree"])).status === 0
}

const nulList = (s: string): string[] => s.split("\0").filter(Boolean)

/** Обхід без Git: `node_modules` і `.git` не містять метаданих проєкту. */
async function walk(cwd: string): Promise<string[]> {
  const entries = await readdir(cwd, { recursive: true, withFileTypes: true })
  const found: string[] = []
  for (const e of entries) {
    if (!e.isFile() || e.name !== PROJECT_FILE) continue
    const dir = join(e.parentPath, ".")
    const rel = dir.slice(cwd.length).replace(/^[\\/]+/, "")
    const parts = rel.split(/[\\/]/)
    if (parts.includes("node_modules") || parts.includes(".git")) continue
    if (rel !== "" && basename(rel).endsWith("metadata")) found.push(rel)
  }
  return found.map((d) => d.split("\\").join("/")).sort()
}

/**
 * Теки метаданих репо: у Git — відстежені `*metadata/project.meta.json`
 * (pathspec `*` перетинає `/`, тож збігаються корінь і вкладені теки); поза
 * Git — обхід файлової системи.
 */
export async function findMetadataDirs(cwd: string): Promise<string[]> {
  if (!(await isGitRepo(cwd))) return walk(cwd)
  const r = await git(cwd, [
    "ls-files",
    "-z",
    "--",
    `*metadata/${PROJECT_FILE}`,
  ])
  if (r.status !== 0) throw new UsageError(r.stderr.trim())
  return nulList(r.stdout).map((f) => dirname(f))
}

/**
 * Вміст індексу Git для зазначених тек у тимчасовій теці: pre-commit перевіряє
 * те, що буде закомічено, а не робоче дерево. Поза Git індексу немає.
 */
export async function stageMetadataDirs(
  cwd: string,
  dirs: string[]
): Promise<{ root: string; dirs: string[]; dispose(): Promise<void> }> {
  if (!(await isGitRepo(cwd))) {
    throw new UsageError(`--staged: not a git repository: ${cwd}`)
  }
  const root = await mkdtemp(join(tmpdir(), "simetra-staged-"))
  const dispose = () => rm(root, { recursive: true, force: true })
  try {
    const list = await git(cwd, ["ls-files", "-z", "--cached", "--", ...dirs])
    if (list.status !== 0) throw new UsageError(list.stderr.trim())
    // Префікс мусить закінчуватись слешем; список іде через stdin (ліміт аргументів).
    const files = nulList(list.stdout)
    const out = await git(
      cwd,
      ["checkout-index", `--prefix=${root}/`, "-z", "--stdin"],
      files.length > 0 ? files.join("\0") + "\0" : ""
    )
    if (out.status !== 0) throw new UsageError(out.stderr.trim())
  } catch (error) {
    await dispose()
    throw error
  }
  return { root, dirs: dirs.map((d) => join(root, d)), dispose }
}
