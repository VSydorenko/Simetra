import { describe, expect, it } from "vitest"
import type { CatalogEntryAttribute } from "../catalog"
import { jsonBytes } from "../limits"
import {
  encodeAttributeValue,
  encodeAttributes,
  type EncodeAttributesOptions,
} from "../values"
import { catalogEntryAttribute } from "./entries"
import { STARTER_KIT_SAMPLE, UNKNOWN_NODE_SAMPLE } from "./rich-text-sample"

const MIB = 1024 * 1024

const richText = (
  extra: Partial<CatalogEntryAttribute> = {}
): CatalogEntryAttribute =>
  catalogEntryAttribute({
    name: "body",
    column: "body_col",
    type: "RichText",
    required: false,
    maxLength: undefined,
    insert: true,
    update: true,
    maxBytes: MIB,
    ...extra,
  })

const paragraph = (text: string) => ({
  type: "paragraph",
  content: [{ type: "text", text }],
})
const doc = (...content: unknown[]) => ({ type: "doc", content })

/** Документ з `levels` рівнями вузлів: `doc`, `blockquote`…, `paragraph`, `text`. */
function nested(levels: number): unknown {
  let node: unknown = paragraph("x")
  for (let i = 0; i < levels - 3; i++) {
    node = { type: "blockquote", content: [node] }
  }
  return doc(node)
}

const profile = (path = "body") => ({
  error: { code: "command.invalid", path, reason: "rich-text-profile" },
})
const tooLarge = (path = "body") => ({
  error: { code: "command.invalid", path, reason: "too-large" },
})

const HEADER: EncodeAttributesOptions = {
  allowed: (a) => a.update,
  path: "values",
  prefix: "",
}

describe("encodeAttributeValue: RichText", () => {
  it("accepts a profile document and gives its copy", () => {
    const encoded = encodeAttributeValue(
      richText(),
      STARTER_KIT_SAMPLE,
      "body",
      { maxBytes: true }
    )
    expect(encoded).toEqual({ value: STARTER_KIT_SAMPLE })
    expect("value" in encoded && encoded.value).not.toBe(STARTER_KIT_SAMPLE)
  })

  it("accepts null on a nullable attribute", () => {
    expect(encodeAttributeValue(richText(), null, "body")).toEqual({
      value: null,
    })
  })

  it("refuses an unknown node as rich-text-profile on the attribute path", () => {
    expect(
      encodeAttributeValue(richText(), UNKNOWN_NODE_SAMPLE, "body")
    ).toEqual(profile())
  })

  // Профіль — типово, незалежно від прапорця `maxBytes`: `member`
  // інструмента обслуговування пише без нього (Р-B7-6).
  it("checks the profile with and without maxBytes", () => {
    expect(
      encodeAttributes([richText()], { body: UNKNOWN_NODE_SAMPLE }, HEADER)
    ).toEqual(profile())
    expect(
      encodeAttributes(
        [richText()],
        { body: UNKNOWN_NODE_SAMPLE },
        { ...HEADER, maxBytes: true }
      )
    ).toEqual(profile())
  })

  it("skips the profile only with profile: false", () => {
    expect(
      encodeAttributes(
        [richText()],
        { body: UNKNOWN_NODE_SAMPLE },
        { ...HEADER, maxBytes: true, profile: false }
      )
    ).toEqual({ columns: { body_col: UNKNOWN_NODE_SAMPLE } })
  })

  it("refuses a value that is not JSON without a reason", () => {
    expect(encodeAttributeValue(richText(), new Map(), "body")).toEqual({
      error: { code: "command.invalid", path: "body" },
    })
  })
})

describe("encodeAttributeValue: RichText maxBytes", () => {
  const sized = paragraph("a".repeat(100))
  const exact = jsonBytes(doc(sized))

  it("accepts a document of exactly maxBytes", () => {
    expect(
      encodeAttributeValue(richText({ maxBytes: exact }), doc(sized), "body", {
        maxBytes: true,
      })
    ).toEqual({ value: doc(sized) })
  })

  it("refuses a document one byte over maxBytes as too-large", () => {
    expect(
      encodeAttributeValue(
        richText({ maxBytes: exact }),
        doc(paragraph("a".repeat(101))),
        "body",
        { maxBytes: true }
      )
    ).toEqual(tooLarge())
  })

  // Порядок Р-B7-6: міра до решти профілю.
  it("refuses an oversize document with an unknown node as too-large", () => {
    const oversize = doc(
      paragraph("a".repeat(100)),
      { type: "iframe" },
      paragraph("b")
    )
    expect(
      encodeAttributeValue(richText({ maxBytes: exact }), oversize, "body", {
        maxBytes: true,
      })
    ).toEqual(tooLarge())
  })

  // Міра — ширина друку `jsonb`, як у `Json`: `1e300` — 6 байтів у
  // `JSON.stringify`, 301 цифра в базі.
  it("measures numbers by their jsonb width", () => {
    const value = doc({
      type: "heading",
      attrs: { level: 1e300 },
      content: [{ type: "text", text: "x" }],
    })
    expect(
      encodeAttributeValue(
        richText({ maxBytes: jsonBytes(value) + 100 }),
        value,
        "body",
        { maxBytes: true }
      )
    ).toEqual(tooLarge())
  })
})

describe("encodeAttributeValue: RichText depth", () => {
  it("accepts depth 64 and refuses depth 65 as rich-text-profile", () => {
    expect(
      encodeAttributeValue(richText(), nested(64), "body", { maxBytes: true })
    ).toEqual({ value: nested(64) })
    expect(
      encodeAttributeValue(richText(), nested(65), "body", { maxBytes: true })
    ).toEqual(profile())
  })

  // Вікно, де `pureJson` ще проходить, а рекурсивна міра `maxBytes`
  // переповнює стек, залежить від стека процесу: перебір, а не дві глибини.
  // Без межі глибини перед мірою тут вилітав би `RangeError`.
  const DEPTHS = Array.from({ length: 48 }, (_, i) => 65 + 250 * i)
  const sweep = (options: Partial<EncodeAttributesOptions>) =>
    DEPTHS.map((depth) => {
      const encoded = encodeAttributes(
        [richText()],
        { body: nested(depth) },
        { ...HEADER, maxBytes: true, ...options }
      )
      return { depth, error: "error" in encoded ? encoded.error : undefined }
    })

  it("sweeps depths within maxBytes", () => {
    expect(DEPTHS.at(-1)).toBeLessThanOrEqual(12_000)
    expect(DEPTHS.at(-1)).toBeGreaterThan(12_000 - 250)
    // `JSON.stringify` найглибшого документа сам переповнив би стек: міра —
    // приріст байтів на рівень.
    const perLevel = jsonBytes(nested(5)) - jsonBytes(nested(4))
    expect(jsonBytes(nested(4)) + perLevel * 12_000).toBeLessThan(MIB)
  })

  it("gives command.invalid, never a throw, from depth 65 to 12 000", () => {
    for (const { depth, error } of sweep({})) {
      expect(error, `depth ${depth}`).toMatchObject({
        code: "command.invalid",
        path: "body",
      })
    }
  })

  // `profile: false` (`expectedValues`) межу глибини перед мірою не знімає:
  // глибина 65 ще в межі JSON, далі — відмова, а не виняток.
  it("keeps the depth bound under profile: false", () => {
    const [first, ...rest] = sweep({ profile: false })
    expect(first).toEqual({ depth: 65, error: undefined })
    for (const { depth, error } of rest) {
      expect(error, `depth ${depth}`).toMatchObject({
        code: "command.invalid",
        path: "body",
      })
    }
  })
})
