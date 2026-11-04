import { randomUUID } from "node:crypto"
import {
  mkdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { installedPackageDir } from "../io/package-path"
import { errorCode } from "./fs-probe"
import { type Agent, mcpLaunch, planMcpConfigs } from "./mcp-config"
import { DESIGNER_PACKAGE } from "./own-path"
import { isOwnSkillEntry, planSkillLinks } from "./skills"
import type { InitAction, InitPlan } from "./types"

/**
 * Повний план `init`: лише читає диск. Пакет шукається вгору від кореня тим
 * самим механізмом, що й `$schema` (спека designer §4.2); його відсутність —
 * `UsageError` з назвою пакета.
 */
export async function planInit(
  root: string,
  agents: readonly Agent[],
  platform: NodeJS.Platform
): Promise<InitPlan> {
  const pkgDir = installedPackageDir(root, DESIGNER_PACKAGE)
  const skills = await planSkillLinks(root, pkgDir, platform)
  const configs = await planMcpConfigs(
    root,
    agents,
    await mcpLaunch(root, pkgDir),
    platform
  )
  return {
    actions: [...skills.actions, ...configs.actions],
    notes: [...skills.notes, ...configs.notes],
    refusals: [...skills.refusals, ...configs.refusals],
  }
}

/**
 * Збій посеред застосування чистого плану — гонка з іншим процесом. `code` —
 * код помилки ФС або `changed-since-plan`, коли власний лінк перед
 * видаленням уже не наш.
 */
export class InitApplyError extends Error {
  override name = "InitApplyError"
  constructor(
    readonly path: string,
    readonly code: string
  ) {
    super(`${path}: ${code}`)
  }
}

/**
 * Застосовує план без відмов. Кожна дія вже перевірена планом, тож тут лише
 * механіка; будь-який збій зупиняє застосування й називає шлях дії. Уже
 * виконані дії лишаються: повторний `init` доробить решту (спека designer
 * §4.2).
 */
export async function applyInit(
  plan: InitPlan,
  platform: NodeJS.Platform
): Promise<void> {
  for (const action of plan.actions) {
    try {
      await applyAction(action, platform)
    } catch (e) {
      if (e instanceof InitApplyError) throw e
      throw new InitApplyError(action.path, errorCode(e))
    }
  }
}

async function applyAction(
  action: InitAction,
  platform: NodeJS.Platform
): Promise<void> {
  switch (action.kind) {
    case "unlink":
      await assertOwnSkill(action.path, platform)
      return unlink(action.path)
    case "link":
      // Застарілий власний лінк (чи розгорнутий git-ом файл) іде першим:
      // `symlink` поверх наявного шляху дав би `EEXIST`
      if (action.replaces) {
        await assertOwnSkill(action.path, platform)
        await unlink(action.path)
      }
      await mkdir(dirname(action.path), { recursive: true })
      return symlink(action.target, action.path, action.type)
    case "write":
      await mkdir(dirname(action.path), { recursive: true })
      return writeAtomic(action.path, action.content)
  }
}

// План бачив власний лінк, але до видалення інший процес міг покласти на його
// місце чуже — видаляємо лише те, що наше й зараз
async function assertOwnSkill(
  path: string,
  platform: NodeJS.Platform
): Promise<void> {
  if (!(await isOwnSkillEntry(path, platform))) {
    throw new InitApplyError(path, "changed-since-plan")
  }
}

/**
 * Запис через тимчасовий файл у тій самій теці й `rename`: обірваний запис не
 * лишає напівконфігу. Симлінк конфігу резолвиться заздалегідь, бо `rename`
 * поверх самого лінка замінив би його звичайним файлом; права файлу
 * зберігаються.
 */
async function writeAtomic(path: string, content: string): Promise<void> {
  const target = await realpath(path).catch((e: unknown) => {
    if (errorCode(e) === "ENOENT") return path
    throw e
  })
  const mode = await stat(target).then(
    (s) => s.mode & 0o777,
    () => undefined
  )
  const temp = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`)
  try {
    const options = mode === undefined ? { flag: "wx" } : { flag: "wx", mode }
    await writeFile(temp, content, options)
    await rename(temp, target)
  } catch (e) {
    await rm(temp, { force: true })
    throw e
  }
}
