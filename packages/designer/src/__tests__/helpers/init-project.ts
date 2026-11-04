import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { DESIGNER_PACKAGE } from "../../init/skills"

export const PKG = `node_modules/${DESIGNER_PACKAGE}`

/**
 * Тимчасовий корінь проєкту споживача для `simetra init`: пакет-фікстура
 * designer у `node_modules` зі скілами й маніфестом з `bin.simetra`, або —
 * з `installed: false` — порожня тека, як поза проєктом.
 */
export async function initProject(
  options: { skills?: string[]; installed?: boolean } = {}
): Promise<{ root: string; dispose(): Promise<void> }> {
  const { skills = ["a"], installed = true } = options
  const root = await mkdtemp(join(tmpdir(), "simetra-init-cmd-"))
  if (installed) {
    for (const s of skills) {
      await mkdir(join(root, PKG, "skills", s), { recursive: true })
      await writeFile(join(root, PKG, "skills", s, "SKILL.md"), `# ${s}`)
    }
    await mkdir(join(root, PKG), { recursive: true })
    await writeFile(
      join(root, PKG, "package.json"),
      JSON.stringify({ bin: { simetra: "./dist/main.js" } })
    )
  }
  return { root, dispose: () => rm(root, { recursive: true }) }
}

/** Дерево проєкту без `node_modules`: те, що могла б змінити команда. */
export async function projectTree(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = []
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name === "node_modules") continue
    const rel = prefix + e.name
    out.push(rel)
    if (e.isDirectory())
      out.push(...(await projectTree(join(dir, e.name), rel + "/")))
  }
  return out.sort()
}

/** Файл проєкту разом із теками-предками. */
export async function put(
  root: string,
  rel: string,
  content: string
): Promise<void> {
  await mkdir(dirname(join(root, rel)), { recursive: true })
  await writeFile(join(root, rel), content)
}
