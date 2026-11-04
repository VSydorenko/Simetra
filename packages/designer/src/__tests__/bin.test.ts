import { execFile } from "node:child_process"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { promisify } from "node:util"
import { expect, it } from "vitest"
import { initProject } from "./helpers/init-project"

const exec = promisify(execFile)
const PACKAGE = resolve(__dirname, "../..")
const BIN = resolve(PACKAGE, "bin/simetra.mjs")

it("bin runs under node", async () => {
  const { stdout } = await exec(
    process.execPath,
    ["bin/simetra.mjs", "compile", "../../examples/reference/metadata"],
    { cwd: PACKAGE }
  )
  expect(stdout).toContain("0 error(s)")
}, 60_000)

it("usage errors exit with code 2", async () => {
  for (const args of [
    ["bogus"],
    ["compile", "--locale", "xx"],
    ["fix", "../../examples/reference/metadata", "--dry-run", "--locale", "xx"],
    [
      "explain",
      "Catalog.Currency",
      "../../examples/reference/metadata",
      "--locale",
      "xx",
    ],
  ]) {
    await expect(
      exec(process.execPath, ["bin/simetra.mjs", ...args], { cwd: PACKAGE })
    ).rejects.toMatchObject({ code: 2 })
  }
}, 60_000)

it("--version prints the package version", async () => {
  const { version } = JSON.parse(
    await readFile(resolve(PACKAGE, "package.json"), "utf8")
  ) as { version: string }
  const { stdout } = await exec(
    process.execPath,
    ["bin/simetra.mjs", "--version"],
    {
      cwd: PACKAGE,
    }
  )
  expect(stdout.trim()).toBe(version)
}, 60_000)

it("init rejects an unknown agent with code 2", async () => {
  await expect(
    exec(process.execPath, [BIN, "init", "--agents", "bogus"], {
      cwd: PACKAGE,
    })
  ).rejects.toMatchObject({ code: 2, stderr: expect.stringContaining("bogus") })
}, 60_000)

it("init --check exits with the code of its result", async () => {
  const { root, dispose } = await initProject()
  try {
    // Пакет-фікстура є, лінків немає: розбіжність — код 1, не 0 і не 2
    await expect(
      exec(process.execPath, [BIN, "init", "--check"], { cwd: root })
    ).rejects.toMatchObject({ code: 1 })
  } finally {
    await dispose()
  }
}, 60_000)

it("--help lists init", async () => {
  const { stdout } = await exec(process.execPath, [BIN, "--help"], {
    cwd: PACKAGE,
  })
  expect(stdout).toMatch(/\binit\b/)
}, 60_000)
