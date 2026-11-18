// Збірка шаблону з tarball-ів: копія `template/` у тимчасовій теці поза
// репо, `simetra` і `@simetrajs/designer` — із tarball-ів, які побачить реєстр
// (`pnpm pack` бере поля `publishConfig`), решта — з реєстру. Пресет —
// `node-server`. Потребує свіжого `pnpm build:packages`.
import { execFile } from "node:child_process"
import {
  cp,
  mkdtemp,
  readFile,
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

describe("template build from tarballs", () => {
  it("builds on node-server with simetra and the designer from tarballs", async () => {
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
    await writeFile(join(dir, "pnpm-workspace.yaml"), workspace)

    const env = consumerEnv()
    await exec("pnpm", ["install", "--no-frozen-lockfile"], {
      cwd: dir,
      env,
      maxBuffer: 64 * 1024 * 1024,
    })

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
})
