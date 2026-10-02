import { execFile } from "node:child_process"
import { resolve } from "node:path"
import { promisify } from "node:util"
import { expect, it } from "vitest"

const exec = promisify(execFile)
const PACKAGE = resolve(__dirname, "../..")

it("bin runs under node", async () => {
  const { stdout } = await exec(
    process.execPath,
    ["bin/simetra.mjs", "compile", "../../examples/reference/metadata"],
    { cwd: PACKAGE }
  )
  expect(stdout).toContain("0 error(s)")
}, 60_000)
