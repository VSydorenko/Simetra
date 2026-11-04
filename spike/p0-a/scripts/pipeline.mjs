// Portions copied from simplyCMS (https://github.com/simplyCMS/simplyCMS, scripts/pilot-pack/pack.mjs, build.mjs)
// Copyright (c) 2026 simplyCMS
// Licensed under MIT. Modified: one stub package plus `simetra`, host variants by preset, layout and versions.
//
// Конвеєр спайку П0 (а): pack → скретч-тека поза репо → install → build.
//   node pipeline.mjs pack
//   node pipeline.mjs host --variant ours|synth --preset node-server|vercel
//        --layout symlink|hoisted [--versions current|report] [--dedupe a,b]
//        [--stub tarball|link|injected] [--aliasSrc]
// Скретч — `SPIKE_SCRATCH` (поза робочою копією Simetra).

import { execFileSync, spawnSync } from "node:child_process"
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"

const SPIKE = resolve(import.meta.dirname, "..")
const REPO = resolve(SPIKE, "../..")
const SCRATCH = process.env.SPIKE_SCRATCH
if (!SCRATCH) throw new Error("SPIKE_SCRATCH is not set")
const TARBALLS = join(SCRATCH, "tarballs")

// Пари версій: поточні на npm і версії репорту #8139.
export const VERSIONS = {
  current: {
    start: "1.169.4",
    router: "1.170.46",
    nitro: "3.0.261103-rc",
    vite: "8.3.5",
  },
  report: {
    start: "1.168.28",
    router: "1.170.18",
    nitro: "3.0.260610-beta",
    vite: "8.1.5",
  },
}

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { stdio: "inherit", ...opts })

function pack() {
  // `pnpm pack`, не `npm pack`: лише pnpm застосовує `publishConfig`.
  run("pnpm", ["build:packages"], { cwd: REPO })
  rmSync(TARBALLS, { recursive: true, force: true })
  mkdirSync(TARBALLS, { recursive: true })
  run("pnpm", ["pack", "--pack-destination", TARBALLS], {
    cwd: join(REPO, "packages/simetra"),
  })
  const stub = join(SCRATCH, "stub")
  rmSync(stub, { recursive: true, force: true })
  cpSync(join(SPIKE, "stub"), stub, {
    recursive: true,
    filter: (src) => !/\/(node_modules|dist)(\/|$)/.test(src),
  })
  // Скретч-копія бере `simetra` з tarball-а, а не з робочої копії.
  const stubManifest = join(stub, "package.json")
  writeFileSync(
    stubManifest,
    readFileSync(stubManifest, "utf8").replace(
      /"simetra": "link:[^"]+"/,
      `"simetra": "file:${join(TARBALLS, "simetra-0.1.0.tgz")}"`
    )
  )
  run("pnpm", ["install", "--no-frozen-lockfile"], { cwd: stub })
  run("pnpm", ["build"], { cwd: stub })
  run("pnpm", ["pack", "--pack-destination", TARBALLS], { cwd: stub })
}

function host(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      variant: { type: "string", default: "ours" },
      preset: { type: "string", default: "node-server" },
      layout: { type: "string", default: "symlink" },
      versions: { type: "string", default: "current" },
      dedupe: { type: "string", default: "" },
      name: { type: "string" },
      // Крок 6: як host бере заглушку — tarball, `link:` чи injected-копія.
      stub: { type: "string", default: "tarball" },
      aliasSrc: { type: "boolean", default: false },
      // Крок 6: `simetra` з tarball-а чи `link:` на робочу копію (сирий TS).
      simetra: { type: "string", default: "tarball" },
    },
  })
  const v = VERSIONS[values.versions]
  if (!v) throw new Error(`unknown versions ${values.versions}`)
  const name =
    values.name ??
    `${values.variant}-${values.preset}-${values.layout}-${values.versions}`
  const dir = join(SCRATCH, "hosts", name)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  cpSync(join(SPIKE, "host"), dir, {
    recursive: true,
    filter: (src) => !src.endsWith("package.json.tpl"),
  })
  const manifest = readFileSync(join(SPIKE, "host/package.json.tpl"), "utf8")
    .replaceAll("__TARBALLS__", TARBALLS)
    .replace("__START__", v.start)
    .replace("__ROUTER__", v.router)
    .replace("__NITRO__", v.nitro)
    .replace("__VITE__", v.vite)
  const pkg = JSON.parse(manifest)
  const STUB = "@simetra-spike/p0a-stub"
  if (values.stub === "link")
    pkg.dependencies[STUB] = `link:${join(SPIKE, "stub")}`
  if (values.stub === "injected") {
    pkg.dependencies[STUB] = `file:${join(SPIKE, "stub")}`
    pkg.dependenciesMeta = { [STUB]: { injected: true } }
  }
  if (values.simetra === "link")
    pkg.dependencies.simetra = `link:${join(REPO, "packages/simetra")}`
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2))
  const catalog = join(SCRATCH, "runtime-catalog.json")
  if (existsSync(catalog)) cpSync(catalog, join(dir, "runtime-catalog.json"))

  // Без `shamefully-hoist`; hoisted — лише як контроль кроку 5.
  const install = ["install", "--no-frozen-lockfile"]
  if (values.layout === "hoisted") install.push("--config.node-linker=hoisted")
  else install.push("--config.node-linker=isolated")
  run("pnpm", install, { cwd: dir })

  const env = {
    ...process.env,
    NODE_ENV: "production",
    SPIKE_VARIANT: values.variant,
    SPIKE_PRESET: values.preset,
    SPIKE_DEDUPE: values.dedupe,
    SPIKE_ALIAS_SRC: values.aliasSrc ? join(SPIKE, "stub/src") : "",
  }
  const build = spawnSync(join(dir, "node_modules/.bin/vite"), ["build"], {
    cwd: dir,
    env,
    encoding: "utf8",
  })
  writeFileSync(join(dir, "build.log"), `${build.stdout}\n${build.stderr}`)
  const result = { name, ...values, ...v, buildExit: build.status }
  writeFileSync(join(dir, "pipeline.json"), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result))
  if (build.status !== 0) process.exitCode = 1
}

const [command, ...rest] = process.argv.slice(2)
if (command === "pack") pack()
else if (command === "host") host(rest)
else throw new Error("usage: pipeline.mjs pack | host [options]")
