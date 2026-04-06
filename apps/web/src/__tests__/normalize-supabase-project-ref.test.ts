import { describe, expect, it } from "vitest"
import { normalizeSupabaseProjectRef } from "../lib/normalize-supabase-project-ref"

describe("normalizeSupabaseProjectRef", () => {
  it("returns plain project ref as is", () => {
    expect(normalizeSupabaseProjectRef("abcdefghijklmnopqrst")).toBe(
      "abcdefghijklmnopqrst",
    )
  })

  it("extracts project ref from full https URL", () => {
    expect(
      normalizeSupabaseProjectRef(
        "https://abcdefghijklmnopqrst.supabase.co",
      ),
    ).toBe("abcdefghijklmnopqrst")
  })

  it("extracts project ref from URL with path", () => {
    expect(
      normalizeSupabaseProjectRef(
        "https://abcdefghijklmnopqrst.supabase.co/project/default",
      ),
    ).toBe("abcdefghijklmnopqrst")
  })

  it("extracts project ref from host without protocol", () => {
    expect(
      normalizeSupabaseProjectRef("abcdefghijklmnopqrst.supabase.co"),
    ).toBe("abcdefghijklmnopqrst")
  })

  it("trims whitespace around input", () => {
    expect(
      normalizeSupabaseProjectRef("  https://abcdefghijklmnopqrst.supabase.co  "),
    ).toBe("abcdefghijklmnopqrst")
  })

  it("does not rewrite unrelated URLs", () => {
    expect(normalizeSupabaseProjectRef("https://example.com")).toBe(
      "https://example.com",
    )
  })
})