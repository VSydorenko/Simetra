// Публікація пакетів на npmjs: `pnpm pack` (переписує `workspace:*` на версію і
// бере поля `publishConfig`) + `npm publish <tgz>`. Публікує npm CLI, а не
// `pnpm publish`, бо обмін OIDC-токена Trusted Publishing робить саме він.
// Уже опублікована версія пропускається, тож повторний запуск безпечний.
//
//   node scripts/release/publish.mts            # публікація
//   node scripts/release/publish.mts --dry-run  # що поїде, без публікації
import { spawnSync } from "node:child_process"
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { distTagFor, publishedState } from "./registry.mts"

const REPO = resolve(import.meta.dirname, "../..")

// Залежність раніше за залежного: designer тягне `simetra` тієї самої версії
const PUBLISH_ORDER = ["packages/simetra", "packages/designer"]

interface Manifest {
  name: string
  version: string
  private?: boolean
}

const readManifest = (dir: string): Manifest =>
  JSON.parse(readFileSync(join(REPO, dir, "package.json"), "utf8")) as Manifest

function run(cmd: string, args: string[], cwd: string) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" })
  return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr }
}

function main(): number {
  const dryRun = process.argv.includes("--dry-run")

  // Новий публічний пакет поза порядком не пропускається мовчки
  for (const entry of readdirSync(join(REPO, "packages"))) {
    const dir = `packages/${entry}`
    if (!readManifest(dir).private && !PUBLISH_ORDER.includes(dir)) {
      throw new Error(`${dir} is public but missing from PUBLISH_ORDER`)
    }
  }

  const manifests = PUBLISH_ORDER.map(readManifest)
  const versions = new Set(manifests.map((m) => m.version))
  if (versions.size !== 1) {
    throw new Error(
      `versions differ: ${[...versions].join(", ")} (Р1: one version)`
    )
  }

  const out = mkdtempSync(join(tmpdir(), "simetra-publish-"))
  try {
    for (const [i, dir] of PUBLISH_ORDER.entries()) {
      const { name, version } = manifests[i]!
      const spec = `${name}@${version}`
      const state = publishedState(
        run("npm", ["view", spec, "version", "--json"], REPO),
        version
      )
      if (state === "published") {
        console.log(`${spec}: already published, skipped`)
        continue
      }
      const before = new Set(readdirSync(out))
      const pack = run(
        "pnpm",
        ["pack", "--pack-destination", out],
        join(REPO, dir)
      )
      if (pack.code !== 0) throw new Error(`pnpm pack ${dir}: ${pack.stderr}`)
      const tarball = readdirSync(out).find((f) => !before.has(f))
      if (!tarball) throw new Error(`pnpm pack ${dir} produced no tarball`)

      const tag = distTagFor(version)
      const args = [
        "publish",
        join(out, tarball),
        "--access",
        "public",
        "--tag",
        tag,
      ]
      if (dryRun) args.push("--dry-run")
      console.log(`${spec}: npm ${args.join(" ")}`)
      // Інтерактивно: локальна перша публікація просить 2FA у терміналі
      const r = spawnSync("npm", args, { cwd: REPO, stdio: "inherit" })
      if (r.status !== 0) return r.status ?? 1
    }
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
  return 0
}

process.exitCode = main()
