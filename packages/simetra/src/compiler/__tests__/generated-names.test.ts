import { expect, it } from "vitest"
import { effectsFunctionName } from "../rights/effects-names"

it("keeps generated function identities distinct for long and UTF-8 table names", () => {
  const header = { schema: "public", name: `${"x".repeat(55)}head` }
  const delta = { schema: "public", name: `${"x".repeat(55)}delta` }
  const short = { schema: "public", name: "org_roles" }
  const utf8 = { schema: "public", name: "ж".repeat(31) }
  const name = (table: typeof header) => effectsFunctionName(table).name
  expect(name(header)).toBe(`${"x".repeat(38)}_6a643e97_simetra_effects`)
  expect(name(delta)).toBe(`${"x".repeat(38)}_3d7d0492_simetra_effects`)
  expect(name(short)).toBe("org_roles_simetra_effects")
  for (const table of [header, delta, utf8]) {
    expect(new TextEncoder().encode(name(table)).length).toBeLessThanOrEqual(63)
  }
})
