import { describe, expect, it } from "vitest"
import { PROVIDER_LOGIN_ROLES } from "simetra/model"
import { ownerRefusal } from "../owner-gate"

describe("ownerRefusal", () => {
  it.each([
    [
      "no BYPASSRLS, not superuser",
      { role: "migrator", bypassrls: false, superuser: false },
    ],
    ["no row for the role (fail-closed)", undefined],
  ])("refuses: %s", (_name, row) => {
    expect(ownerRefusal(row, "postgres")).toMatchObject({
      code: "plan.owner-not-bypassrls",
      severity: "error",
    })
  })

  it.each([
    ["BYPASSRLS", { role: "migrator", bypassrls: true, superuser: false }],
    ["superuser", { role: "migrator", bypassrls: false, superuser: true }],
  ])("passes: %s", (_name, row) => {
    expect(ownerRefusal(row, "postgres")).toBeUndefined()
  })

  // Спільний вхід сервісів провайдера — відмова навіть з BYPASSRLS чи
  // суперкористувачем: власником об'єктів застосунку став би вхід сервісів
  it.each(
    (["supabase", "postgres"] as const).flatMap((provider) =>
      PROVIDER_LOGIN_ROLES[provider].map((role) => [provider, role] as const)
    )
  )("refuses the %s provider login %s", (provider, role) => {
    expect(
      ownerRefusal({ role, bypassrls: true, superuser: true }, provider)
    ).toMatchObject({
      code: "plan.owner-provider-login",
      severity: "error",
      params: { role },
    })
  })

  it("judges the login by the model's provider", () => {
    // `simetra_auth` — вхід провайдера лише профілю `postgres`
    expect(
      ownerRefusal(
        { role: "simetra_auth", bypassrls: true, superuser: false },
        "supabase"
      )
    ).toBeUndefined()
  })
})
