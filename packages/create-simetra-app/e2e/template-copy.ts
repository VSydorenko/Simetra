// Копії шаблону для гейтів складу збірки: збірка йде в окремій теці, тож гейти
// не топчуть `template/.output` і не псують дерево контрольними витоками.
import { execFile } from "node:child_process"
import { cp, mkdir, readdir, readFile, rm, stat } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import { promisify } from "node:util"

const exec = promisify(execFile)

export const PACKAGE = resolve(import.meta.dirname, "..")
export const TEMPLATE = join(PACKAGE, "template")
export const REPO = resolve(PACKAGE, "../..")

const copies: string[] = []

/** Прибирає всі копії цього прогону. */
export async function removeCopies(): Promise<void> {
  await Promise.all(
    copies.splice(0).map((d) => rm(d, { recursive: true, force: true }))
  )
}

/**
 * Копія шаблону поруч із ним (`packages/create-simetra-app/.build-*`): її
 * `node_modules` — відносні симлінки на ту саму глибину, тож залежності
 * знаходяться й без встановлення. Збірка й тека-вихід не копіюються.
 */
export async function copyTemplate(label: string): Promise<string> {
  const dir = join(PACKAGE, `.build-${label}-${process.pid}-${Date.now()}`)
  copies.push(dir)
  await cp(TEMPLATE, dir, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (source) => !/\/(\.output|\.nitro|\.tanstack)$/.test(source),
  })
  return dir
}

export async function viteBuild(
  dir: string,
  env: Record<string, string> = {}
): Promise<void> {
  const vite = join(
    dirname(
      createRequire(join(dir, "package.json")).resolve("vite/package.json")
    ),
    "bin/vite.js"
  )
  try {
    await exec(process.execPath, [vite, "build"], {
      cwd: dir,
      env: { ...process.env, NODE_ENV: "production", ...env },
      maxBuffer: 64 * 1024 * 1024,
    })
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string }
    throw new Error(`vite build failed:\n${e.stdout ?? ""}${e.stderr ?? ""}`)
  }
}

async function* files(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* files(path)
    else yield path
  }
}

/** Файли теки, у яких є хоч одна з підрядків: `файл → знайдені підрядки`. */
export async function findNeedles(
  dir: string,
  needles: readonly string[]
): Promise<Record<string, string[]>> {
  const found: Record<string, string[]> = {}
  try {
    await stat(dir)
  } catch {
    throw new Error(`${dir} does not exist: there is nothing to scan`)
  }
  for await (const file of files(dir)) {
    const text = await readFile(file, "utf8")
    const hits = needles.filter((n) => text.includes(n))
    if (hits.length > 0) found[file.slice(dir.length + 1)] = hits
  }
  return found
}

export { mkdir }
