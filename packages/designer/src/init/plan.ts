import { mkdir, symlink, unlink, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { installedPackageDir } from "../io/package-path"
import { errorCode } from "./fs-probe"
import { type Agent, mcpLaunch, planMcpConfigs } from "./mcp-config"
import { DESIGNER_PACKAGE, planSkillLinks } from "./skills"
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
    await mcpLaunch(root, pkgDir)
  )
  return {
    actions: [...skills.actions, ...configs.actions],
    notes: [...skills.notes, ...configs.notes],
    refusals: [...skills.refusals, ...configs.refusals],
  }
}

/** Збій ФС посеред застосування чистого плану — гонка з іншим процесом. */
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
 * механіка; будь-який збій зупиняє застосування й називає шлях дії.
 */
export async function applyInit(plan: InitPlan): Promise<void> {
  for (const action of plan.actions) {
    try {
      await applyAction(action)
    } catch (e) {
      throw new InitApplyError(action.path, errorCode(e))
    }
  }
}

async function applyAction(action: InitAction): Promise<void> {
  switch (action.kind) {
    case "unlink":
      return unlink(action.path)
    case "link":
      // Застарілий власний лінк (чи розгорнутий git-ом файл) іде першим:
      // `symlink` поверх наявного шляху дав би `EEXIST`
      if (action.replaces) await unlink(action.path)
      await mkdir(dirname(action.path), { recursive: true })
      return symlink(action.target, action.path, action.type)
    case "write":
      await mkdir(dirname(action.path), { recursive: true })
      return writeFile(action.path, action.content)
  }
}
