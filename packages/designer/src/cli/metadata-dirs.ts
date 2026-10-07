import { spawn } from "node:child_process"
import { mkdtemp, readdir, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
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
    child.on("error", (error) =>
      reject(
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? new UsageError("git is not installed or not on PATH")
          : error
      )
    )
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

/** Обхід без Git: у `node_modules` і `.git` не спускаємось — метаданих проєкту там немає. */
async function walk(cwd: string, rel = ""): Promise<string[]> {
  const entries = await readdir(join(cwd, rel), { withFileTypes: true })
  const found: string[] = []
  if (
    rel !== "" &&
    basename(rel).endsWith("metadata") &&
    entries.some((e) => e.isFile() && e.name === PROJECT_FILE)
  ) {
    found.push(rel)
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name === "node_modules" || e.name === ".git") {
      continue
    }
    found.push(...(await walk(cwd, rel === "" ? e.name : `${rel}/${e.name}`)))
  }
  return found.sort()
}

/**
 * Теки метаданих у поточній теці й нижче: у Git — відстежені `*metadata/project.meta.json`
 * (pathspec `*` перетинає `/`, тож збігаються корінь і вкладені теки); поза
 * Git — обхід файлової системи.
 */
export async function findMetadataDirs(cwd: string): Promise<string[]> {
  // Без бінарника git `--all` (без `--staged`) працює як поза репозиторієм:
  // перевірці метаданих Git не потрібен, потрібен лише `--staged`.
  const inGit = await isGitRepo(cwd).catch((error: unknown) => {
    if (error instanceof UsageError) return false
    throw error
  })
  if (!inGit) return walk(cwd)
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
  // `ls-files` дає шляхи від cwd, а `checkout-index --prefix` пише від кореня
  // репо: тому йдемо через повні імена й запускаємо checkout-index з кореня.
  const top = await git(cwd, ["rev-parse", "--show-toplevel", "--show-prefix"])
  if (top.status !== 0) throw new UsageError(top.stderr.trim())
  const [toplevel = cwd, prefix = ""] = top.stdout.split("\n")
  const root = await mkdtemp(join(tmpdir(), "simetra-staged-"))
  const dispose = () => rm(root, { recursive: true, force: true })
  try {
    const list = await git(cwd, [
      "ls-files",
      "-z",
      "--cached",
      "--full-name",
      "--",
      ...dirs,
    ])
    if (list.status !== 0) throw new UsageError(list.stderr.trim())
    // Префікс мусить закінчуватись слешем; список іде через stdin (ліміт аргументів).
    const files = nulList(list.stdout)
    const out = await git(
      toplevel,
      ["checkout-index", `--prefix=${root}/`, "-z", "--stdin"],
      files.length > 0 ? files.join("\0") + "\0" : ""
    )
    if (out.status !== 0) throw new UsageError(out.stderr.trim())
  } catch (error) {
    await dispose()
    throw error
  }
  return { root, dirs: dirs.map((d) => join(root, prefix, d)), dispose }
}

/** Ті самі файли, що й у `readMetadataDir`: решта теки компілятора не стосується. */
const METADATA_SUFFIXES = [".meta.json", ".sql", ".module.ts"]

/**
 * Один запуск `git cat-file --batch` на всі блоби: формат відповіді —
 * `<sha> blob <size>\n<content>\n`, тож розбираємо за довжиною в байтах.
 */
async function readBlobs(cwd: string, shas: string[]): Promise<string[]> {
  const out = await new Promise<Buffer>((res, rej) => {
    const child = spawn("git", ["cat-file", "--batch"], { cwd })
    const chunks: Buffer[] = []
    child.stdout.on("data", (c: Buffer) => chunks.push(c))
    child.on("error", rej)
    child.on("close", (status) =>
      status === 0
        ? res(Buffer.concat(chunks))
        : rej(new UsageError("git cat-file failed"))
    )
    child.stdin.on("error", () => undefined)
    child.stdin.end(shas.map((s) => `${s}\n`).join(""))
  })
  const texts: string[] = []
  let at = 0
  for (const sha of shas) {
    const eol = out.indexOf(0x0a, at)
    const header = out.subarray(at, eol).toString("utf8").split(" ")
    if (header[0] !== sha || header[1] !== "blob") {
      throw new UsageError(`git cat-file: unexpected object ${sha}`)
    }
    const size = Number(header[2])
    texts.push(out.subarray(eol + 1, eol + 1 + size).toString("utf8"))
    at = eol + 1 + size + 1
  }
  return texts
}

/**
 * Базовий стан теки метаданих — її вміст у коміті `HEAD`: за ним компілятор
 * перевіряє поля, призначені раз. `undefined` — поза git (перевірки немає);
 * порожня мапа — коміту ще немає або теки в ньому немає (усе нове). Ключі —
 * шляхи відносно теки, як у `readMetadataDir`.
 */
export async function readHeadMetadata(
  cwd: string,
  dir: string
): Promise<ReadonlyMap<string, string> | undefined> {
  // Git запускаємо з самої теки: вона може лежати поза репозиторієм `cwd`
  // (явний шлях), а префікс від кореня репо тоді дає сам git.
  const at = resolve(cwd, dir)
  if (
    !(await stat(at).then(
      (s) => s.isDirectory(),
      () => false
    ))
  ) {
    return undefined
  }
  const inGit = await isGitRepo(at).catch((error: unknown) => {
    if (error instanceof UsageError) return false
    throw error
  })
  if (!inGit) return undefined
  const top = await git(at, ["rev-parse", "--show-prefix"])
  if (top.status !== 0) throw new UsageError(top.stderr.trim())
  // `--full-name` дає шляхи від кореня репо, тож префікс теки — той самий.
  const prefix = top.stdout.trim().replace(/\/$/, "")
  const tree = await git(at, [
    "ls-tree",
    "-r",
    "-z",
    "--full-name",
    "HEAD",
    "--",
    ".",
  ])
  if (tree.status !== 0) {
    // Без коміту `HEAD` не існує; будь-яка інша причина — справжня помилка.
    const head = await git(at, ["rev-parse", "--verify", "-q", "HEAD"])
    if (head.status !== 0) return new Map()
    throw new UsageError(tree.stderr.trim())
  }
  const entries: { key: string; sha: string }[] = []
  for (const record of nulList(tree.stdout)) {
    const tab = record.indexOf("\t")
    const [, type, sha] = record.slice(0, tab).split(" ")
    const path = record.slice(tab + 1)
    if (type !== "blob" || sha === undefined) continue
    const key = prefix === "" ? path : path.slice(prefix.length + 1)
    if (!METADATA_SUFFIXES.some((suffix) => key.endsWith(suffix))) continue
    entries.push({ key, sha })
  }
  const texts =
    entries.length === 0
      ? []
      : await readBlobs(
          cwd,
          entries.map((e) => e.sha)
        )
  return new Map(entries.map((e, i) => [e.key, texts[i] ?? ""]))
}
