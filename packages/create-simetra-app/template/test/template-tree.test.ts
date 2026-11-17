import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const ROOT = fileURLToPath(new URL("..", import.meta.url))
const SELF = "test/template-tree.test.ts"

// Дх9: шаблон не залежить від оракула й тестових входів — інакше копія для
// споживача тягла б тестову обв'язку. Лише e2e поза `template/` бере оракул.
const FORBIDDEN = [
  "test-host",
  "frame-oracle",
  "simetra/data/testing",
  "simetra/server/testing",
]
const SKIPPED_DIRS = new Set([
  "node_modules",
  ".output",
  ".nitro",
  ".tanstack",
  "dist",
])

/** Файли дерева з забороненим посиланням: `файл → що знайдено`. */
function findForbidden(root: string): string[] {
  const hits: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) walk(path)
        continue
      }
      const rel = relative(root, path)
      if (rel === SELF) continue
      const text = readFileSync(path, "utf8")
      for (const word of FORBIDDEN)
        if (text.includes(word)) hits.push(`${rel}: ${word}`)
    }
  }
  walk(root)
  return hits
}

describe("template tree", () => {
  it("has no reference to the oracle or testing entries, package.json included", () => {
    expect(findForbidden(ROOT)).toEqual([])
  })

  it("turns red on an artificial reference", () => {
    const scratch = mkdtempSync(join(tmpdir(), "simetra-tree-"))
    try {
      mkdirSync(join(scratch, "src"))
      writeFileSync(
        join(scratch, "src/a.ts"),
        'import "simetra/data/testing"\n'
      )
      writeFileSync(
        join(scratch, "package.json"),
        '{"devDependencies":{"test-host":"workspace:*"}}\n'
      )
      expect(findForbidden(scratch)).toEqual([
        "package.json: test-host",
        "src/a.ts: simetra/data/testing",
      ])
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })
})
