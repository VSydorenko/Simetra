import { describe, expect, it } from "vitest"
import {
  ANNOUNCEMENT_FILE,
  PROJECT_FILE,
  REGION_FILE,
  ROLE_FILE,
  compileRights,
  grant,
  objects,
  withRoles,
} from "./fixtures/rights"

// Announcement — `authenticated`, Region — `anon`: гість бачить `anon` і без
// самореєстрації, тож у переліку лише перший. Роль Everyone — рівня everyUser.
function layers(selfSignUp: boolean) {
  return withRoles(
    {
      [PROJECT_FILE]: selfSignUp ? { selfSignUp: true } : {},
      [ANNOUNCEMENT_FILE]: {
        trackAuthor: true,
        ownership: ["createdBy"],
        publicRead: "authenticated",
      },
      [REGION_FILE]: { scope: "none", publicRead: "anon" },
    },
    {
      [ROLE_FILE("Everyone")]: {
        grants: [grant(objects(["Document", "Announcement"]), ["read"], "own")],
      },
    }
  )
}

async function selfSignUpDiagnostics(selfSignUp: boolean) {
  const result = await compileRights(layers(selfSignUp))
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
  return result.diagnostics
    .filter((d) => d.code === "project.self-sign-up")
    .map(({ code, severity, file, pointer, params }) => ({
      code,
      severity,
      file,
      pointer,
      params,
    }))
}

describe("self sign-up warning", () => {
  it("lists the authenticated object and the everyUser grants, not the anon object", async () => {
    expect(await selfSignUpDiagnostics(true)).toEqual([
      {
        code: "project.self-sign-up",
        severity: "warning",
        file: PROJECT_FILE,
        pointer: "/selfSignUp",
        params: {
          objects: "Announcement",
          roles: "Everyone: Announcement.read",
        },
      },
    ])
  })

  it("is silent without selfSignUp", async () => {
    expect(await selfSignUpDiagnostics(false)).toEqual([])
  })
})
