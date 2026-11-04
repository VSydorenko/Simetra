import { lstat, readFile, readdir, readlink } from "node:fs/promises"
import { dirname, join, posix, resolve, win32 } from "node:path"
import { posixRelative } from "../io/package-path"
import { errorCode, probe, type Probe } from "./fs-probe"
import { packageSubpath } from "./own-path"
import type { InitPlan, InitRefusal } from "./types"

/** Теки скілів у корені проєкту — у спеці не прив'язані до агента (§4.2). */
export const SKILL_DIRS = [".agents/skills", ".claude/skills"] as const

/**
 * Чи ціль лінка — тека скіла пакета: рівно один сегмент під
 * `node_modules/@simetrajs/designer/skills/` після нормалізації. Будь-який
 * `node_modules` годиться, тож застарілий лінк (перенесений проєкт, інший
 * `node_modules`) теж власний і його можна виправити.
 */
export function isOwnSkillTarget(
  linkPath: string,
  target: string,
  platform: NodeJS.Platform
): boolean {
  const sub = packageSubpath(dirname(linkPath), target, platform)
  return sub?.length === 2 && sub[0] === "skills"
}

/**
 * Перевірка власності на диску перед видаленням: між планом і застосуванням
 * інший процес міг підмінити власний лінк чужим. Файл — розгорнутий git-ом
 * симлінк, тож його вміст судиться як ціль.
 */
export async function isOwnSkillEntry(
  path: string,
  platform: NodeJS.Platform
): Promise<boolean> {
  const s = await lstat(path)
  if (s.isSymbolicLink()) {
    return isOwnSkillTarget(path, await readlink(path), platform)
  }
  if (!s.isFile()) return false
  const content = (await readFile(path, "utf8")).trim()
  return isOwnSkillTarget(path, content, platform)
}

type SkillDir = { rel: string; path: string; existing: boolean }
type Entry =
  | { kind: "missing" | "match" | "stale" | "foreign" }
  | { kind: "refused"; refusal: InitRefusal }

/**
 * Як створити лінк скіла. Junction на Windows вимагає абсолютної цілі
 * (дослідження доставки §4); деінде ціль відносна, щоб закомічений лінк
 * пережив перенос репо.
 */
export function linkSpec(
  linkPath: string,
  targetDir: string,
  platform: NodeJS.Platform
): { target: string; type: "dir" | "junction" } {
  if (platform === "win32") return { type: "junction", target: targetDir }
  return { type: "dir", target: posixRelative(dirname(linkPath), targetDir) }
}

/**
 * Чи це та сама тека, лексично. Файлова система Windows не розрізняє регістру,
 * а `readlink` junction віддає шлях із хвостовим роздільником — без
 * нормалізації абсолютний junction вічно не збігався б з очікуваною текою.
 */
export function sameDir(
  a: string,
  b: string,
  platform: NodeJS.Platform
): boolean {
  if (platform === "win32") {
    const norm = (p: string) =>
      win32.normalize(p).replace(/\\+$/, "").toLowerCase()
    return norm(a) === norm(b)
  }
  const norm = (p: string) => posix.normalize(p).replace(/\/+$/, "")
  return norm(a) === norm(b)
}

/**
 * План лінків скілів пакета в теках скілів проєкту. Лише читає диск: будь-яка
 * проблема стає відмовою в плані, і тоді `init` не пише нічого (спека
 * designer §4.2).
 */
export async function planSkillLinks(
  root: string,
  pkgDir: string,
  platform: NodeJS.Platform
): Promise<InitPlan> {
  const plan: InitPlan = { actions: [], notes: [], refusals: [] }
  const skills = await packageSkills(pkgDir, plan)
  for (const rel of SKILL_DIRS) {
    const dir = await usableSkillDir(root, rel, plan, platform)
    if (dir) await planDir(dir, pkgDir, skills, plan, platform)
  }
  return plan
}

async function packageSkills(pkgDir: string, plan: InitPlan) {
  const dir = join(pkgDir, "skills")
  try {
    const names: string[] = []
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const md = await probe(join(dir, e.name, "SKILL.md"))
      if (e.isDirectory() && md.kind === "file") names.push(e.name)
    }
    return names.sort()
  } catch (e) {
    plan.refusals.push({ path: dir, reason: "unreadable", code: errorCode(e) })
    return []
  }
}

/**
 * Тека скілів, у якій можна планувати лінки. Симлінк-предок у межах кореня
 * відмовляє: відносна ціль, порахована від лексичного шляху, у чужій фізичній
 * теці не резолвилась би. Аліас на іншу теку скілів пропускається, бо дві дії
 * на один фізичний шлях дали б `EEXIST` посеред застосування.
 */
async function usableSkillDir(
  root: string,
  rel: string,
  plan: InitPlan,
  platform: NodeJS.Platform
): Promise<SkillDir | undefined> {
  const segments = rel.split("/")
  for (let i = 1; i < segments.length; i++) {
    const ancestor = join(root, ...segments.slice(0, i))
    const p = await probe(ancestor)
    if (p.kind === "missing")
      return { rel, path: join(root, rel), existing: false }
    if (p.kind !== "dir") return void plan.refusals.push(refusal(ancestor, p))
  }
  const path = join(root, rel)
  const p = await probe(path)
  if (p.kind === "missing" || p.kind === "dir") {
    return { rel, path, existing: p.kind === "dir" }
  }
  if (p.kind === "symlink" && (await aliasesOther(root, rel, platform))) {
    return void plan.notes.push({ kind: "aliased-skill-dir", path })
  }
  plan.refusals.push(refusal(path, p))
}

// Ціль лексично, без `realpath`: висячий аліас (друга тека ще не створена)
// мусить розпізнаватися так само, як наявний
async function aliasesOther(
  root: string,
  rel: string,
  platform: NodeJS.Platform
): Promise<boolean> {
  const path = join(root, rel)
  try {
    const resolved = resolve(dirname(path), await readlink(path))
    return SKILL_DIRS.some(
      (other) => other !== rel && sameDir(resolved, join(root, other), platform)
    )
  } catch {
    return false
  }
}

function refusal(path: string, p: Probe): InitRefusal {
  if (p.kind === "symlink") return { path, reason: "skill-dir-is-a-link" }
  if (p.kind !== "error") return { path, reason: "not-a-directory" }
  const reason = p.code === "ENOTDIR" ? "not-a-directory" : "unreadable"
  return { path, reason, code: p.code }
}

async function planDir(
  dir: SkillDir,
  pkgDir: string,
  skills: string[],
  plan: InitPlan,
  platform: NodeJS.Platform
): Promise<void> {
  const existing = dir.existing ? await entries(dir.path, plan) : []
  if (!existing) return
  for (const name of skills) {
    const path = join(dir.path, name)
    const expected = join(pkgDir, "skills", name)
    const entry = await classify(path, expected, platform)
    if (entry.kind === "refused") plan.refusals.push(entry.refusal)
    if (entry.kind === "foreign")
      plan.notes.push({ kind: "foreign-skill", path })
    if (entry.kind === "missing" || entry.kind === "stale") {
      const replaces = entry.kind === "stale"
      const spec = linkSpec(path, expected, platform)
      plan.actions.push({ kind: "link", path, ...spec, replaces })
    }
  }
  await planOrphans(dir.path, existing, skills, pkgDir, plan, platform)
}

// Власний лінк на скіл, якого в пакеті вже немає, прибирається — інакше агент
// бачив би битий скіл після оновлення пакета. Чужі імена не чіпаються
async function planOrphans(
  dirPath: string,
  existing: string[],
  skills: string[],
  pkgDir: string,
  plan: InitPlan,
  platform: NodeJS.Platform
): Promise<void> {
  for (const name of existing.filter((n) => !skills.includes(n))) {
    const path = join(dirPath, name)
    const entry = await classify(path, join(pkgDir, "skills", name), platform)
    if (entry.kind === "match" || entry.kind === "stale") {
      plan.actions.push({ kind: "unlink", path })
    }
  }
}

async function entries(path: string, plan: InitPlan) {
  try {
    return (await readdir(path)).sort()
  } catch (e) {
    plan.refusals.push({ path, reason: "unreadable", code: errorCode(e) })
  }
}

async function classify(
  path: string,
  expected: string,
  platform: NodeJS.Platform
): Promise<Entry> {
  const p = await probe(path)
  if (p.kind === "missing") return { kind: "missing" }
  if (p.kind === "dir") return { kind: "foreign" }
  if (p.kind === "error") return { kind: "refused", refusal: refusal(path, p) }
  try {
    return p.kind === "symlink"
      ? await classifyLink(path, expected, platform)
      : await classifyFile(path, expected)
  } catch (e) {
    const refused = { path, reason: "unreadable" as const, code: errorCode(e) }
    return { kind: "refused", refusal: refused }
  }
}

// Збіг — за резолвом цілі, а не за її формою: абсолютний junction з Windows і
// відносний лінк з POSIX у спільному репо інакше вічно дрейфували б
async function classifyLink(
  path: string,
  expected: string,
  platform: NodeJS.Platform
): Promise<Entry> {
  const target = await readlink(path)
  if (!isOwnSkillTarget(path, target, platform)) return { kind: "foreign" }
  const same = sameDir(resolve(dirname(path), target), expected, platform)
  return { kind: same ? "match" : "stale" }
}

// git на Windows без `core.symlinks` розгортає закомічений симлінк у файл з
// ціллю всередині — такий файл наш і замінюється справжнім лінком
async function classifyFile(path: string, expected: string): Promise<Entry> {
  const content = (await readFile(path, "utf8")).trim()
  const own = content === posixRelative(dirname(path), expected)
  return { kind: own ? "stale" : "foreign" }
}
