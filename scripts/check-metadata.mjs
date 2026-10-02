#!/usr/bin/env node
// Єдині двері: `simetra compile` над кожною текою метаданих репо.
// Без аргументів — робоча тека (CI: checkout і є комітом);
// `--staged` — вміст індексу Git (pre-commit), а не робоча тека.
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
// Шлях до bin — від кореня репо, без залежності від PATH.
const bin = join(root, "packages/cli/bin/simetra.mjs")
const staged = process.argv.includes("--staged")

function git(args, input) {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8", input })
  if (r.status !== 0) {
    process.stderr.write(r.stderr)
    process.exit(2)
  }
  return r.stdout
}

// Pathspec `*` перетинає `/`, тож збігаються і корінь, і вкладені теки.
const dirs = git(["ls-files", "-z", "--", "*metadata/project.meta.json"])
  .split("\0")
  .filter(Boolean)
  .map((f) => dirname(f))

if (dirs.length === 0) {
  console.log("metadata:check — no metadata directories found.")
  process.exit(0)
}

let cwd = root
let tmp
try {
  if (staged) {
    tmp = mkdtempSync(join(tmpdir(), "simetra-staged-"))
    const files = dirs.flatMap((d) =>
      git(["ls-files", "-z", "--cached", "--", d]).split("\0").filter(Boolean)
    )
    // Префікс мусить закінчуватись слешем; список йде через stdin (ліміт аргументів).
    git(
      ["checkout-index", `--prefix=${tmp}/`, "-z", "--stdin"],
      files.join("\0") + "\0"
    )
    cwd = tmp
  }
  const r = spawnSync(process.execPath, [bin, "compile", ...dirs], {
    cwd,
    stdio: "inherit",
  })
  if (r.error) {
    console.error(r.error)
    process.exitCode = 2
  } else {
    process.exitCode = r.status ?? 2
  }
} finally {
  if (tmp) rmSync(tmp, { recursive: true, force: true })
}
