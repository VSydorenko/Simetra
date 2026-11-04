import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { installedPackageDir } from "../io/package-path"
import { DESIGNER_PACKAGE, packageSubpath } from "../init/own-path"
import { linkSpec, planSkillLinks, sameDir } from "../init/skills"
import type { InitPlan } from "../init/types"

const PKG = `node_modules/${DESIGNER_PACKAGE}`
const target = (name: string) => `../../${PKG}/skills/${name}`

const temps: string[] = []
afterEach(async () => {
  await Promise.all(temps.splice(0).map((t) => rm(t, { recursive: true })))
})

/**
 * Тимчасовий проєкт зі встановленим пакетом designer: `layout` вибирає, де
 * лежить пакет — прямо в `node_modules` кореня, у сховищі pnpm за симлінком
 * чи в піднятому `node_modules` над коренем.
 */
async function project(
  skills: string[] = ["a"],
  layout: "flat" | "pnpm" | "hoisted" = "flat"
): Promise<{ root: string; pkgDir: string }> {
  const tmp = await mkdtemp(join(tmpdir(), "simetra-init-"))
  temps.push(tmp)
  const root = layout === "hoisted" ? join(tmp, "app") : tmp
  await mkdir(root, { recursive: true })
  const installed = join(tmp, PKG)
  const physical = layout === "pnpm" ? join(tmp, "store/designer") : installed
  for (const s of skills) {
    await mkdir(join(physical, "skills", s), { recursive: true })
    await writeFile(join(physical, "skills", s, "SKILL.md"), "# skill")
  }
  await writeFile(join(physical, "package.json"), "{}")
  if (layout === "pnpm") {
    await mkdir(join(tmp, "node_modules/@simetrajs"), { recursive: true })
    await symlink(physical, installed, "dir")
  }
  return { root, pkgDir: installedPackageDir(root, DESIGNER_PACKAGE) }
}

async function tree(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = []
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix + e.name
    out.push(rel)
    if (e.isDirectory()) out.push(...(await tree(join(dir, e.name), rel + "/")))
  }
  return out.sort()
}

/** План будується лише читанням: дерево проєкту до й після однакове. */
async function plan(root: string, pkgDir: string): Promise<InitPlan> {
  const before = await tree(root)
  const result = await planSkillLinks(root, pkgDir, "linux")
  expect(await tree(root)).toEqual(before)
  return result
}

async function link(root: string, rel: string, to: string): Promise<void> {
  const at = join(root, rel)
  await mkdir(join(at, ".."), { recursive: true })
  await symlink(to, at, "dir")
}

describe("planSkillLinks", () => {
  it("plans relative links in both skill dirs", async () => {
    const { root, pkgDir } = await project(["a", "b"])
    const p = await plan(root, pkgDir)
    expect(p.refusals).toEqual([])
    expect(p.notes).toEqual([])
    expect(p.actions).toHaveLength(4)
    for (const dir of [".agents/skills", ".claude/skills"]) {
      for (const s of ["a", "b"]) {
        expect(p.actions).toContainEqual({
          kind: "link",
          path: join(root, dir, s),
          target: target(s),
          type: "dir",
          replaces: false,
        })
      }
    }
  })

  it("links through node_modules, not the pnpm store", async () => {
    const { root, pkgDir } = await project(["a"], "pnpm")
    const p = await plan(root, pkgDir)
    expect(p.actions).toHaveLength(2)
    for (const a of p.actions) {
      expect(a).toMatchObject({ kind: "link", target: target("a") })
      expect(a.kind === "link" && a.target).not.toContain("store")
    }
  })

  it("hoisted node_modules gives a longer relative target", async () => {
    const { root, pkgDir } = await project(["a"], "hoisted")
    const p = await plan(root, pkgDir)
    expect(p.actions).toContainEqual(
      expect.objectContaining({
        path: join(root, ".claude/skills/a"),
        target: `../../../${PKG}/skills/a`,
      })
    )
  })

  it("leaves a foreign directory alone", async () => {
    const { root, pkgDir } = await project()
    await mkdir(join(root, ".claude/skills/a"), { recursive: true })
    await writeFile(join(root, ".claude/skills/a/SKILL.md"), "# fork")
    const p = await plan(root, pkgDir)
    const path = join(root, ".claude/skills/a")
    expect(p.actions.filter((a) => a.path === path)).toEqual([])
    expect(p.notes).toEqual([{ kind: "foreign-skill", path }])
  })

  it("leaves a foreign symlink alone", async () => {
    const { root, pkgDir } = await project()
    await link(root, ".agents/skills/a", "../../vendor/a")
    const p = await plan(root, pkgDir)
    const path = join(root, ".agents/skills/a")
    expect(p.actions.filter((a) => a.path === path)).toEqual([])
    expect(p.notes).toEqual([{ kind: "foreign-skill", path }])
  })

  // Файл на місці скіла наш лише тоді, коли в ньому рівно ціль лінка
  // (розгорнутий git-ом симлінк); нотатки власника не чіпаємо. Чуже ім'я поза
  // пакетом — не сирота, тож і без нотатки
  it.each([
    { name: "a", notes: ["foreign-skill"] },
    { name: "old", notes: [] },
  ])("leaves a foreign plain file alone: $name", async ({ name, notes }) => {
    const { root, pkgDir } = await project()
    await mkdir(join(root, ".claude/skills"), { recursive: true })
    await writeFile(join(root, ".claude/skills", name), "my notes")
    const p = await plan(root, pkgDir)
    const path = join(root, ".claude/skills", name)
    expect(p.actions.filter((a) => a.path === path)).toEqual([])
    expect(p.notes).toEqual(notes.map((kind) => ({ kind, path })))
  })

  // Ціль містить сегмент пакета, але після нормалізації веде за його межі:
  // ні заміни скіла, ні видалення «сироти»
  it.each([
    { name: "a", notes: ["foreign-skill"] },
    { name: "old", notes: [] },
  ])("leaves a link escaping the package alone: $name", async (c) => {
    const { root, pkgDir } = await project()
    await link(
      root,
      `.claude/skills/${c.name}`,
      `../../${PKG}/skills/../../other/x`
    )
    const p = await plan(root, pkgDir)
    const path = join(root, ".claude/skills", c.name)
    expect(p.actions.filter((a) => a.path === path)).toEqual([])
    expect(p.notes).toEqual(c.notes.map((kind) => ({ kind, path })))
  })

  it("removes an own orphan link", async () => {
    const { root, pkgDir } = await project()
    await link(root, ".claude/skills/old", target("old"))
    const p = await plan(root, pkgDir)
    expect(p.actions).toContainEqual({
      kind: "unlink",
      path: join(root, ".claude/skills/old"),
    })
  })

  it("replaces an own stale link", async () => {
    const { root, pkgDir } = await project()
    await link(root, ".claude/skills/a", `../../../elsewhere/${PKG}/skills/a`)
    const p = await plan(root, pkgDir)
    expect(p.actions).toContainEqual({
      kind: "link",
      path: join(root, ".claude/skills/a"),
      target: target("a"),
      type: "dir",
      replaces: true,
    })
  })

  it("replaces a symlink checked out as a plain file", async () => {
    const { root, pkgDir } = await project()
    await mkdir(join(root, ".claude/skills"), { recursive: true })
    await writeFile(join(root, ".claude/skills/a"), `${target("a")}\n`)
    const p = await plan(root, pkgDir)
    expect(p.actions).toContainEqual(
      expect.objectContaining({
        kind: "link",
        path: join(root, ".claude/skills/a"),
        replaces: true,
      })
    )
    expect(p.notes).toEqual([])
  })

  it("accepts an absolute link to the right dir", async () => {
    const { root, pkgDir } = await project()
    await link(root, ".claude/skills/a", join(pkgDir, "skills/a"))
    const p = await plan(root, pkgDir)
    const path = join(root, ".claude/skills/a")
    expect(p.actions.filter((a) => a.path === path)).toEqual([])
    expect(p.notes).toEqual([])
  })

  it("no actions when links match", async () => {
    const { root, pkgDir } = await project(["a", "b"])
    for (const a of (await plan(root, pkgDir)).actions) {
      if (a.kind === "link") await link(root, relative(root, a.path), a.target)
    }
    expect(await plan(root, pkgDir)).toEqual({
      actions: [],
      notes: [],
      refusals: [],
    })
  })

  it("does not touch unrelated entries", async () => {
    const { root, pkgDir } = await project()
    await mkdir(join(root, ".claude/skills/mine"), { recursive: true })
    const p = await plan(root, pkgDir)
    expect(p.actions.map((a) => a.path)).not.toContain(
      join(root, ".claude/skills/mine")
    )
    expect(p.notes).toEqual([])
  })

  it.each([
    ["existing", true],
    ["dangling", false],
  ])("plans once for aliased skill dirs (%s alias)", async (_, existing) => {
    const { root, pkgDir } = await project(["a", "b"])
    if (existing) await mkdir(join(root, ".agents/skills"), { recursive: true })
    await link(root, ".claude/skills", "../.agents/skills")
    const p = await plan(root, pkgDir)
    expect(p.refusals).toEqual([])
    expect(p.actions.map((a) => a.path)).toEqual([
      join(root, ".agents/skills/a"),
      join(root, ".agents/skills/b"),
    ])
    expect(p.notes).toEqual([
      { kind: "aliased-skill-dir", path: join(root, ".claude/skills") },
    ])
  })

  it.each([
    [".claude/skills", "../shared"],
    [".claude", "vendor/deep/claude"],
  ])("refuses a skill dir linked elsewhere (%s)", async (rel, to) => {
    const { root, pkgDir } = await project()
    await mkdir(join(root, "shared"), { recursive: true })
    await mkdir(join(root, "vendor/deep/claude/skills"), { recursive: true })
    await link(root, rel, to)
    const p = await plan(root, pkgDir)
    expect(p.refusals).toEqual([
      { path: join(root, rel), reason: "skill-dir-is-a-link" },
    ])
    expect(p.actions.map((a) => a.path)).not.toContain(
      join(root, ".claude/skills/a")
    )
  })

  it.each([".claude", ".claude/skills"])(
    "refuses when an ancestor is a file (%s)",
    async (rel) => {
      const { root, pkgDir } = await project()
      await mkdir(join(root, rel, ".."), { recursive: true })
      await writeFile(join(root, rel), "")
      const p = await plan(root, pkgDir)
      expect(p.refusals).toEqual([
        { path: join(root, rel), reason: "not-a-directory" },
      ])
      expect(p.actions.map((a) => a.path)).not.toContain(
        join(root, ".claude/skills/a")
      )
      expect((await lstat(join(root, rel))).isFile()).toBe(true)
    }
  )
})

describe("linkSpec", () => {
  const dir = "/p/node_modules/x/skills/a"
  it("is a relative dir link off Windows", () => {
    expect(linkSpec("/p/.claude/skills/a", dir, "linux")).toEqual({
      type: "dir",
      target: "../../node_modules/x/skills/a",
    })
  })
  it("is an absolute junction on Windows", () => {
    expect(linkSpec("/p/.claude/skills/a", dir, "win32")).toEqual({
      type: "junction",
      target: dir,
    })
  })
})

describe("packageSubpath", () => {
  it.each([
    ["/p/a", `../${PKG}/skills/a`, "linux", ["skills", "a"]],
    ["/p/a", `../${PKG}/skills/../../other/x`, "linux", undefined],
    ["/p", `${PKG}/../other/bin.js`, "linux", undefined],
    ["/p", `/q/${PKG}/dist/main.js`, "linux", ["dist", "main.js"]],
    [
      "C:\\p\\.claude\\skills",
      "C:\\P\\Node_Modules\\@simetrajs\\designer\\skills\\a\\",
      "win32",
      ["skills", "a"],
    ],
    [
      "C:\\p",
      `${PKG}\\skills\\..\\..\\x`.replaceAll("/", "\\"),
      "win32",
      undefined,
    ],
  ] as const)("%s + %s (%s)", (base, target, platform, expected) => {
    expect(packageSubpath(base, target, platform)).toEqual(expected)
  })
})

describe("sameDir", () => {
  it("ignores case and a trailing separator on Windows", () => {
    expect(
      sameDir(
        "C:\\P\\node_modules\\X\\skills\\a\\",
        "c:\\p\\NODE_MODULES\\x\\skills\\a",
        "win32"
      )
    ).toBe(true)
  })
  it("is case-sensitive elsewhere", () => {
    expect(sameDir("/p/A", "/p/a", "linux")).toBe(false)
  })
})
