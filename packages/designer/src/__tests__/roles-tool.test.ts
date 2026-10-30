import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { compile } from "simetra/compiler"
import { PLATFORM_LOGIN_ROLES, PLATFORM_ROLES } from "simetra/model"
import { describe, expect, it } from "vitest"
import { renderResult } from "../cli/render"
import { toolByName } from "../tools/catalog"
import { projectRoleSet, type RolesData } from "../tools/roles-tool"
import { project, useTmpProjects } from "./helpers/catalog"

useTmpProjects()

const RUNTIME = PLATFORM_LOGIN_ROLES.runtime

async function emptyDir(): Promise<{ dir: string; dispose(): Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "simetra-roles-"))
  return { dir, dispose: () => rm(dir, { recursive: true }) }
}

describe("roles: the project file", () => {
  it("skips the login role, out loud, without a project file", async () => {
    const empty = await emptyDir()
    try {
      const set = await projectRoleSet(empty.dir)
      expect(set).toEqual({
        ok: true,
        roles: { names: Object.values(PLATFORM_ROLES) },
        skipped: [{ name: RUNTIME, reason: "no-project-file" }],
      })
      const data: RolesData = {
        roles: [
          {
            server: "target",
            name: PLATFORM_ROLES.command,
            outcome: "created",
          },
        ],
        skipped: set.ok ? set.skipped : [],
      }
      const text = renderResult(
        toolByName("roles")!,
        { ok: true, changes: [], diagnostics: [], data, written: false },
        { dir: empty.dir, locale: "en", format: "text" }
      ).stdout
      expect(text.split("\n")).toEqual([
        `target: ${PLATFORM_ROLES.command} created`,
        expect.stringMatching(
          new RegExp(
            `^target: ${RUNTIME} skipped: .*project\\.meta\\.json.*database\\.provider`
          )
        ),
      ])
      const json = JSON.parse(
        renderResult(
          toolByName("roles")!,
          { ok: true, changes: [], diagnostics: [], data, written: false },
          { dir: empty.dir, locale: "en", format: "json" }
        ).stdout
      ) as { skipped: unknown }
      expect(json.skipped).toEqual([
        { name: RUNTIME, reason: "no-project-file" },
      ])
    } finally {
      await empty.dispose()
    }
  })

  it("adds the login role with the provider's request role from the project file", async () => {
    expect(await projectRoleSet(await project())).toEqual({
      ok: true,
      roles: {
        names: Object.values(PLATFORM_ROLES),
        login: {
          name: RUNTIME,
          memberOf: [PLATFORM_ROLES.command, "authenticated"],
        },
      },
      skipped: [],
    })
  })

  it("refuses a broken project file with the diagnostics of compile", async () => {
    const empty = await emptyDir()
    try {
      const text = JSON.stringify({ name: "App" })
      await writeFile(join(empty.dir, "project.meta.json"), text)
      const set = await projectRoleSet(empty.dir)
      expect(set.ok).toBe(false)
      const compiled = await compile(new Map([["project.meta.json", text]]))
      const codes = (ds: readonly { code: string }[]) => ds.map((d) => d.code)
      expect(set.ok ? [] : codes(set.diagnostics)).toEqual(
        codes(
          compiled.diagnostics.filter((d) => d.file === "project.meta.json")
        )
      )
      expect(set.ok ? [] : set.diagnostics).not.toEqual([])
    } finally {
      await empty.dispose()
    }
  })
})
