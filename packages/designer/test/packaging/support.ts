import { execFile } from "node:child_process"
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"

export const exec = promisify(execFile)

export const REPO = resolve(import.meta.dirname, "../../../..")

const temps: string[] = []

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  temps.push(dir)
  return dir
}

/** Прибирає tarball-и й проєкти споживача цього прогону. */
export async function removeTemps(): Promise<void> {
  await Promise.all(
    temps.splice(0).map((d) => rm(d, { recursive: true, force: true }))
  )
}

const PACKAGES = {
  simetra: join(REPO, "packages/simetra"),
  designer: join(REPO, "packages/designer"),
} as const

/**
 * Tarball-и обох пакетів так, як їх побачить реєстр: `pnpm pack` переписує
 * `workspace:*` на версію і бере поля `publishConfig`, тож гейт перевіряє
 * рівно те, що поїде в публікацію, а не робочу копію.
 */
export async function packWorkspace(): Promise<{
  simetra: string
  designer: string
}> {
  const out = await tempDir("simetra-pack-")
  for (const dir of Object.values(PACKAGES)) {
    await exec("pnpm", ["pack", "--pack-destination", out], { cwd: dir })
  }
  const tarballs = await readdir(out)
  const find = (prefix: string): string => {
    const name = tarballs.find(
      (f) => f.startsWith(prefix) && f.endsWith(".tgz")
    )
    if (!name) throw new Error(`no ${prefix}*.tgz in ${out}`)
    return join(out, name)
  }
  return { simetra: find("simetra-"), designer: find("simetrajs-designer-") }
}

export async function readPackedManifest(
  tarball: string
): Promise<Record<string, unknown>> {
  const { stdout } = await exec("tar", [
    "-xOzf",
    tarball,
    "package/package.json",
  ])
  return JSON.parse(stdout) as Record<string, unknown>
}

export async function listPackedFiles(tarball: string): Promise<string[]> {
  const { stdout } = await exec("tar", ["-tzf", tarball])
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((f) => f.replace(/^package\//, ""))
}

/**
 * Тимчасовий проєкт споживача, якому пакети ставить `npm`, а не pnpm: так
 * перевіряється розкладка `node_modules` без симлінків workspace. `overrides`
 * ведуть залежність designer на `simetra` у той самий tarball — до першої
 * публікації цієї версії в реєстрі немає.
 */
export async function installConsumer(tarballs: string[]): Promise<string> {
  const dir = await tempDir("simetra-consumer-")
  const dependencies: Record<string, string> = {}
  for (const tarball of tarballs) {
    const manifest = await readPackedManifest(tarball)
    dependencies[manifest.name as string] = `file:${tarball}`
  }
  const overrides = "simetra" in dependencies ? { simetra: "$simetra" } : {}
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ private: true, type: "module", dependencies, overrides })
  )
  await exec("npm", ["install", "--no-audit", "--no-fund"], { cwd: dir })
  return dir
}
