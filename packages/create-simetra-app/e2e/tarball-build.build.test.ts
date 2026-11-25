// Збірка шаблону з tarball-ів: копія `template/` у тимчасовій теці поза
// репо, `simetra` і `@simetrajs/designer` — із tarball-ів, які побачить реєстр
// (`pnpm pack` бере поля `publishConfig`), решта — з реєстру. Пресет —
// `node-server`. Потребує свіжого `pnpm build:packages`.
import { execFile } from "node:child_process"
import {
  cp,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { promisify } from "node:util"
import { afterAll, describe, expect, it } from "vitest"
import {
  packWorkspace,
  removeTemps,
} from "../../designer/test/packaging/support"
import { REPO, TEMPLATE } from "./template-copy"

const exec = promisify(execFile)

const scratch: string[] = []
afterAll(async () => {
  await removeTemps()
  await Promise.all(
    scratch.splice(0).map((d) => rm(d, { recursive: true, force: true }))
  )
})

// pnpm споживача мусить читати лише налаштування його власного кореня
// (`npm_config_*`, `pnpm_config_*` репо йому не належать)
function consumerEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) => !/^(npm_|pnpm_(?!home$))/i.test(k)
    )
  )
}

/**
 * Проєкт зі шаблону, встановлений із tarball-ів: один на файл, бо установка —
 * найдовший крок. Збірка й пілот `init` ділять його; файли йдуть послідовно
 * (`fileParallelism: false`).
 */
let installed: Promise<{ dir: string; designer: string }> | undefined
function installTemplate(): Promise<{ dir: string; designer: string }> {
  installed ??= (async () => {
    const tarballs = await packWorkspace()
    const dir = await mkdtemp(join(tmpdir(), "simetra-template-"))
    scratch.push(dir)
    await cp(TEMPLATE, dir, {
      recursive: true,
      filter: (source) =>
        !/\/(node_modules|\.output|\.nitro|\.tanstack)$/.test(source),
    })

    const manifestPath = join(dir, "package.json")
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      dependencies: Record<string, string>
      devDependencies: Record<string, string>
    }
    manifest.dependencies.simetra = `file:${tarballs.simetra}`
    manifest.devDependencies["@simetrajs/designer"] =
      `file:${tarballs.designer}`
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2))

    // Налаштування репо, що впливають на збірку (обхід #8139: нижня межа
    // Rolldown і Vite), без списку пакетів workspace; `simetra` — і для
    // залежності designer на нього, якої в реєстрі ще немає
    const workspace = (
      await readFile(join(REPO, "pnpm-workspace.yaml"), "utf8")
    )
      .replace(/^packages:\n(?: {2}- .*\n)+/m, "")
      .replace(
        /^overrides:\n/m,
        `overrides:\n  simetra: "file:${tarballs.simetra}"\n`
      )
    // Без `protobufjs: false` установка споживача падає з
    // `ERR_PNPM_IGNORED_BUILDS` (centrifuge тягне protobufjs): запис у
    // робочу область сценарію має зберегти правило, а не лише файл
    expect(workspace).toMatch(
      /^allowBuilds:\n(?: {2}\S.*\n)*? {2}protobufjs: false$/m
    )
    await writeFile(join(dir, "pnpm-workspace.yaml"), workspace)

    const env = consumerEnv()
    await exec("pnpm", ["install", "--no-frozen-lockfile"], {
      cwd: dir,
      env,
      maxBuffer: 64 * 1024 * 1024,
    })

    return { dir, designer: tarballs.designer }
  })()
  return installed
}

describe("template build from tarballs", () => {
  it("builds on node-server with simetra and the designer from tarballs", async () => {
    const { dir } = await installTemplate()
    const manifestPath = join(dir, "package.json")
    const env = consumerEnv()

    // `simetra` у дереві — з tarball-а, а не посилання на workspace репо
    const installed = await realpath(join(dir, "node_modules/simetra"))
    expect(installed.startsWith(REPO)).toBe(false)
    const packed = JSON.parse(
      await readFile(join(installed, "package.json"), "utf8")
    ) as { exports: Record<string, { import?: string }> }
    expect(packed.exports["./server"]?.import).toBe("./dist/server/index.js")

    const vite = join(
      dirname(createRequire(manifestPath).resolve("vite/package.json")),
      "bin/vite.js"
    )
    await exec(process.execPath, [vite, "build"], {
      cwd: dir,
      env: { ...env, NODE_ENV: "production" },
      maxBuffer: 64 * 1024 * 1024,
    })

    const nitro = JSON.parse(
      await readFile(join(dir, ".output/nitro.json"), "utf8")
    ) as { preset: string; serverEntry: string }
    expect(nitro.preset).toBe("node-server")
    // Вхід сервера справді є: збірка не обмежилась записом `nitro.json`
    expect(
      (await stat(join(dir, ".output", nitro.serverEntry))).size
    ).toBeGreaterThan(0)
  })

  // Пілот `init` у реальному проєкті, а не лише в гейті пакування (платформна
  // спека §11): проєкт зі шаблону з tarball-ів, `init`, потім `init --check`
  it("init links the skills into node_modules and init --check is green", async () => {
    const { dir } = await installTemplate()
    const bin = join(dir, "node_modules/.bin/simetra")
    const env = consumerEnv()
    await exec(bin, ["init"], { cwd: dir, env })
    // Код виходу 0 — `exec` кидає на ненульовому
    await exec(bin, ["init", "--check"], { cwd: dir, env })

    const packed = join(
      await realpath(join(dir, "node_modules/@simetrajs/designer")),
      "skills"
    )
    // Шлях через `node_modules`, а не через `.pnpm`: посилання переживає
    // оновлення пакета (спека designer §4.2)
    expect(packed.startsWith(REPO)).toBe(false)
    const skills = await readdir(packed)
    expect(skills.length).toBeGreaterThan(0)
    for (const name of skills) {
      const link = join(dir, ".claude/skills", name)
      expect(await readlink(link)).toBe(
        `../../node_modules/@simetrajs/designer/skills/${name}`
      )
      await expect(readFile(join(link, "SKILL.md"), "utf8")).resolves.toContain(
        `name: ${name}`
      )
    }
  })
})
