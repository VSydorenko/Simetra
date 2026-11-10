import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { compile } from "simetra/compiler"
import { PLATFORM_LOGIN_ROLES, PLATFORM_ROLES } from "simetra/model"
import { platformRoleSet, type ApplyDatabase } from "simetra/schema"
import { describe, expect, it } from "vitest"
import { renderResult } from "../cli/render"
import { toolByName } from "../tools/catalog"
import { projectRoleSet, runRoles, type RolesData } from "../tools/roles-tool"
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
        roles: {
          names: Object.values(PLATFORM_ROLES),
          login: [],
          // Роль входу не створюють, але наявну звіряють за батьками всіх профілів
          checkLogin: [
            {
              name: RUNTIME,
              memberOf: [
                "authenticated",
                "simetra_anon",
                PLATFORM_ROLES.command,
                "simetra_user",
              ],
              checkOnly: true,
            },
          ],
        },
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
      provider: "supabase",
      roles: {
        names: Object.values(PLATFORM_ROLES),
        login: [
          {
            name: RUNTIME,
            memberOf: [PLATFORM_ROLES.command, "authenticated"],
          },
        ],
        checkLogin: [],
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

// Гілка інструмента за провайдером проєкту: підставний порт бачить, куди й що
// йшло, без жодної бази
describe("roles: the branch by provider", () => {
  function recordingPort(answers: Record<string, unknown>[] = []) {
    const calls: { kind: string; url: string; sql: string[] }[] = []
    const dbs: ApplyDatabase = {
      async transaction(db, _end, fn) {
        const call = { kind: "transaction", url: db.url, sql: [] as string[] }
        calls.push(call)
        return fn({
          query: (async (sql: string) => {
            call.sql.push(sql)
            return answers
          }) as never,
          extract: () => Promise.reject(new Error("no extract")),
        })
      },
      async statement(db, sql) {
        calls.push({ kind: "statement", url: db.url, sql: [sql] })
      },
    }
    return { dbs, calls }
  }
  const target = {
    target: { url: "postgres://su:pw@host:5432/app" },
    describe: "host:5432/app",
  }

  it("prepares the cluster of the postgres profile through the maintenance database", async () => {
    // Сесія не суперкористувач: відмова фази читання, нічого не записано
    const { dbs, calls } = recordingPort([{ ok: false, database: "postgres" }])
    const ran = await runRoles(dbs, target, {
      provider: "postgres",
      roles: platformRoleSet("postgres"),
    })
    expect(ran.roles).toEqual([])
    expect(ran.diagnostics.map((d) => d.code)).toEqual([
      "roles.superuser-required",
    ])
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe("postgres://su:pw@host:5432/postgres")
  })

  it("refuses a separate shadow server for the postgres profile before any connection", async () => {
    const { dbs, calls } = recordingPort()
    const ran = await runRoles(
      dbs,
      { ...target, shadowBase: { url: "postgres://su:pw@other:5432/x" } },
      { provider: "postgres", roles: platformRoleSet("postgres") }
    )
    expect(ran.diagnostics.map((d) => d.code)).toEqual([
      "plan.shadow-base-unsupported",
    ])
    expect(calls).toEqual([])
  })

  it("takes the existing path for supabase and for a project without a file", async () => {
    for (const provider of ["supabase", undefined] as const) {
      const { dbs, calls } = recordingPort([{ allowed: false }])
      await runRoles(dbs, target, {
        provider,
        roles: platformRoleSet(provider),
      })
      // Ролі на цілі за наявним шляхом: звірка права ролі сесії, а не кластер
      expect(calls[0]!.url).toBe(target.target.url)
      expect(calls[0]!.sql[0]).toContain("rolcreaterole")
    }
  })
})
