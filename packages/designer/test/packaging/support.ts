import { execFile } from "node:child_process"
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
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
 * Що споживач має понад tarball-и: залежності з реєстру (peer-и `simetra`,
 * стек host-а) і власні файли (вхід бандлера). Файли генеруються в
 * тимчасовій теці: з імпортами `vite` чи `@tanstack/*` (router, start) у дереві designer вони
 * зламали б його `typecheck` і `lint`.
 */
export interface ConsumerHost {
  dependencies?: Record<string, string>
  files?: Record<string, string>
}

/**
 * Тимчасовий проєкт споживача поза репо (у `os.tmpdir()`), тож ні npm, ні pnpm
 * не бачать workspace репо. `npm` перевіряє розкладку `node_modules` без
 * симлінків, `pnpm` — ізольовану розкладку `.pnpm`, у якій пакет видно лише
 * крізь симлінк. Залежність designer на `simetra` ведеться в той самий
 * tarball — до першої публікації цієї версії в реєстрі немає: npm — полем
 * `overrides`, pnpm 11 — `overrides` у `pnpm-workspace.yaml` (поле `pnpm` у
 * `package.json` він не читає, а `$`-посилання вважає застарілим).
 */
export async function installConsumer(
  tarballs: string[],
  manager: "npm" | "pnpm" = "npm",
  host: ConsumerHost = {}
): Promise<string> {
  const dir = await tempDir("simetra-consumer-")
  for (const [file, content] of Object.entries(host.files ?? {})) {
    await mkdir(dirname(join(dir, file)), { recursive: true })
    await writeFile(join(dir, file), content)
  }
  const dependencies: Record<string, string> = { ...host.dependencies }
  for (const tarball of tarballs) {
    const manifest = await readPackedManifest(tarball)
    dependencies[manifest.name as string] = `file:${tarball}`
  }
  const manifest: Record<string, unknown> = {
    private: true,
    type: "module",
    dependencies,
  }
  if (manager === "npm") {
    manifest.overrides =
      "simetra" in dependencies ? { simetra: "$simetra" } : {}
  } else if ("simetra" in dependencies) {
    await writeFile(
      join(dir, "pnpm-workspace.yaml"),
      `overrides:\n  simetra: ${JSON.stringify(dependencies.simetra)}\n`
    )
  }
  await writeFile(join(dir, "package.json"), JSON.stringify(manifest))
  if (manager === "npm") {
    await exec("npm", ["install", "--no-audit", "--no-fund"], { cwd: dir })
  } else {
    await exec("pnpm", ["install"], { cwd: dir, env: consumerEnv() })
  }
  return dir
}

// Гейт запускає `pnpm --filter … test:packaging`, і pnpm передає дочірнім
// процесам свої `npm_config_*` і `pnpm_config_*` (теку workspace,
// налаштування репо). pnpm споживача мусить читати лише налаштування його
// власного кореня; `PNPM_HOME` — машинне, не репо, тож лишається
function consumerEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) => !/^(npm_|pnpm_(?!home$))/i.test(k)
    )
  )
}

/**
 * Копія tarball-а з іншою версією і правкою вмісту — так гейт імітує
 * оновлення пакета, не публікуючи його. Корінь архіву — `package/`, як у
 * `npm pack`.
 */
export async function repackWithVersion(
  tarball: string,
  version: string,
  edit: (dir: string) => Promise<void>
): Promise<string> {
  const work = await tempDir("simetra-repack-")
  await exec("tar", ["-xzf", tarball, "-C", work])
  const pkg = join(work, "package")
  const manifestPath = join(pkg, "package.json")
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<
    string,
    unknown
  >
  manifest.version = version
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n")
  await edit(pkg)
  const out = join(work, `repacked-${version}.tgz`)
  await exec("tar", ["-czf", out, "-C", work, "package"])
  return out
}

/**
 * Фізичні корені кожного пакета серед id модулів бандла: шлях до останнього
 * `node_modules/<пакет>/`. Ізольована розкладка pnpm кладе пакет у
 * `node_modules/.pnpm/<ім'я>@<версія>[_<peer-и>]/node_modules/<пакет>/`, тож
 * дві версії чи два набори peer-ів одного пакета — два різні корені, тобто
 * два екземпляри його стану на рівні модуля.
 */
export function packageRoots(
  moduleIds: string[],
  packages: string[]
): Record<string, string[]> {
  const roots: Record<string, string[]> = {}
  for (const pkg of packages) {
    const escaped = pkg.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")
    // Жадібне `.*` бере останнє входження: вкладений `node_modules` — це
    // корінь вкладеної копії, а не того пакета, що її містить
    const pattern = new RegExp(`^(.*/node_modules/${escaped})/`)
    const found = new Set<string>()
    for (const id of moduleIds) {
      // Віртуальні модулі Rolldown мають префікс `\0`, а запит — суфікс `?…`
      const match = pattern.exec(id.replace(/^\0/, "").split("?")[0])
      if (match) found.add(match[1])
    }
    roots[pkg] = [...found].sort()
  }
  return roots
}
