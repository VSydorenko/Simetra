import { describe, expect, it } from "vitest"
import {
  checkRichText,
  isRichTextEmpty,
  RICH_TEXT_WHITESPACE,
  richTextDepthOk,
  type RichTextRule,
} from "../rich-text"
import { RICH_TEXT_EMPTINESS_CASES } from "./rich-text-cases"
import { STARTER_KIT_SAMPLE } from "./rich-text-sample"

const doc = (...content: unknown[]) => ({ type: "doc", content })
const p = (...content: unknown[]) => ({ type: "paragraph", content })
const t = (text: string, marks?: unknown[]) =>
  marks === undefined ? { type: "text", text } : { type: "text", text, marks }
const inP = (node: unknown) => doc(p(node))
const link = (attrs: Record<string, unknown>) =>
  inP(t("a", [{ type: "link", attrs }]))
const safeLink = (href: string) =>
  link({ href, target: null, rel: null, class: null, title: null })

/**
 * Документ з `levels` рівнів вузлів (`doc` — рівень 1): вкладені `blockquote`,
 * найглибший рівень — текст з посиланням з усіма атрибутами, найглибша форма
 * JSON дійсного документа. Будується циклом, бо рекурсія — те, від чого
 * захищає межа.
 */
function nested(levels: number): unknown {
  let node: unknown = p(
    t("x", [
      {
        type: "link",
        attrs: {
          href: "/a",
          target: "_blank",
          rel: "noopener",
          class: null,
          title: "t",
        },
      },
    ])
  )
  // `doc` + `paragraph` + `text` = 3 рівні; решта — `blockquote`.
  for (let i = 0; i < levels - 3; i++)
    node = { type: "blockquote", content: [node] }
  return doc(node)
}

describe("checkRichText", () => {
  it("accepts the StarterKit getJSON sample with every node and mark", () => {
    expect(checkRichText(STARTER_KIT_SAMPLE)).toEqual({ ok: true })
  })

  it.each([
    ["https://example.com", safeLink("https://example.com")],
    ["MAILTO:x@y", safeLink("MAILTO:x@y")],
    ["HTTP://a", safeLink("HTTP://a")],
    ["/p", safeLink("/p")],
    ["#a", safeLink("#a")],
    ["missing target and rel (StarterKit defaults)", link({ href: "/p" })],
    [
      "rel with every allowed token",
      link({ href: "/p", rel: "noopener noreferrer nofollow ugc" }),
    ],
    [
      "heading level 6",
      doc({ type: "heading", attrs: { level: 6 }, content: [t("a")] }),
    ],
    ["heading without attrs", doc({ type: "heading", content: [t("a")] })],
    [
      "orderedList start 0, type I",
      doc({
        type: "orderedList",
        attrs: { start: 0, type: "I" },
        content: [{ type: "listItem", content: [p()] }],
      }),
    ],
    [
      "codeBlock language c++",
      doc({ type: "codeBlock", attrs: { language: "c++" }, content: [t("x")] }),
    ],
    ["empty marks array", inP(t("a", []))],
    ["depth 64", nested(64)],
  ])("accepts %s", (_, value) => {
    expect(checkRichText(value)).toEqual({ ok: true })
  })

  // Будівник, а не готове значення: глибокий документ у назві й diff
  // таблиці рекурсивний.
  const refusals: [string, () => unknown, RichTextRule, (string | number)[]][] =
    [
      ["not an object", () => [], "shape", []],
      ["a string", () => "x", "shape", []],
      ["type not a string", () => ({ type: 1 }), "shape", []],
      ["root not doc", () => p(t("a")), "root", ["type"]],
      [
        "unknown node at depth 3",
        () => doc({ type: "blockquote", content: [{ type: "image" }] }),
        "unknown-node",
        ["content", 0, "content", 0, "type"],
      ],
      [
        "node type constructor",
        () => doc({ type: "constructor" }),
        "unknown-node",
        ["content", 0, "type"],
      ],
      [
        "unknown node key",
        () => doc({ ...p(), id: "x" }),
        "unknown-key",
        ["content", 0, "id"],
      ],
      [
        "text on a non-text node",
        () => doc({ ...p(), text: "x" }),
        "unknown-key",
        ["content", 0, "text"],
      ],
      [
        "attrs on a text node",
        () => inP({ ...t("a"), attrs: {} }),
        "unknown-key",
        ["content", 0, "content", 0, "attrs"],
      ],
      [
        "unknown mark",
        () => inP(t("a", [{ type: "highlight" }])),
        "unknown-mark",
        ["content", 0, "content", 0, "marks", 0, "type"],
      ],
      [
        "mark type toString",
        () => inP(t("a", [{ type: "toString" }])),
        "unknown-mark",
        ["content", 0, "content", 0, "marks", 0, "type"],
      ],
      [
        "unknown mark key",
        () => inP(t("a", [{ type: "bold", x: 1 }])),
        "unknown-key",
        ["content", 0, "content", 0, "marks", 0, "x"],
      ],
      [
        "unknown node attribute",
        () => doc({ type: "paragraph", attrs: { textAlign: "left" } }),
        "unknown-attr",
        ["content", 0, "attrs", "textAlign"],
      ],
      [
        "attribute __proto__",
        () =>
          JSON.parse(
            '{"type":"doc","content":[{"type":"paragraph","attrs":{"__proto__":{}}}]}'
          ) as unknown,
        "unknown-attr",
        ["content", 0, "attrs", "__proto__"],
      ],
      [
        "unknown mark attribute",
        () => link({ href: "/p", style: "x" }),
        "unknown-attr",
        ["content", 0, "content", 0, "marks", 0, "attrs", "style"],
      ],
      [
        "attrs not an object",
        () => doc({ type: "heading", attrs: [1], content: [t("a")] }),
        "shape",
        ["content", 0, "attrs"],
      ],
      [
        "heading level 0",
        () => doc({ type: "heading", attrs: { level: 0 }, content: [t("a")] }),
        "attr-value",
        ["content", 0, "attrs", "level"],
      ],
      [
        "heading level 7",
        () => doc({ type: "heading", attrs: { level: 7 }, content: [t("a")] }),
        "attr-value",
        ["content", 0, "attrs", "level"],
      ],
      [
        "heading level 1.5",
        () =>
          doc({ type: "heading", attrs: { level: 1.5 }, content: [t("a")] }),
        "attr-value",
        ["content", 0, "attrs", "level"],
      ],
      [
        "heading level as string",
        () =>
          doc({ type: "heading", attrs: { level: "1" }, content: [t("a")] }),
        "attr-value",
        ["content", 0, "attrs", "level"],
      ],
      [
        "orderedList start -1",
        () =>
          doc({
            type: "orderedList",
            attrs: { start: -1 },
            content: [{ type: "listItem", content: [p()] }],
          }),
        "attr-value",
        ["content", 0, "attrs", "start"],
      ],
      [
        "orderedList type b",
        () =>
          doc({
            type: "orderedList",
            attrs: { type: "b" },
            content: [{ type: "listItem", content: [p()] }],
          }),
        "attr-value",
        ["content", 0, "attrs", "type"],
      ],
      [
        "codeBlock language with a space",
        () => doc({ type: "codeBlock", attrs: { language: "a b" } }),
        "attr-value",
        ["content", 0, "attrs", "language"],
      ],
      [
        "codeBlock language over 32",
        () => doc({ type: "codeBlock", attrs: { language: "a".repeat(33) } }),
        "attr-value",
        ["content", 0, "attrs", "language"],
      ],
      [
        "codeBlock language with a quote",
        () => doc({ type: "codeBlock", attrs: { language: 'x"' } }),
        "attr-value",
        ["content", 0, "attrs", "language"],
      ],
      [
        "link target _self",
        () => link({ href: "/p", target: "_self", rel: null }),
        "attr-value",
        ["content", 0, "content", 0, "marks", 0, "attrs", "target"],
      ],
      [
        "link class x",
        () => link({ href: "/p", class: "x" }),
        "attr-value",
        ["content", 0, "content", 0, "marks", 0, "attrs", "class"],
      ],
      [
        "link title a number",
        () => link({ href: "/p", title: 1 }),
        "attr-value",
        ["content", 0, "content", 0, "marks", 0, "attrs", "title"],
      ],
      [
        "link rel opener",
        () => link({ href: "/p", target: null, rel: "opener" }),
        "rel",
        ["content", 0, "content", 0, "marks", 0, "attrs", "rel"],
      ],
      [
        "link rel with a double space",
        () => link({ href: "/p", target: null, rel: "noopener  ugc" }),
        "rel",
        ["content", 0, "content", 0, "marks", 0, "attrs", "rel"],
      ],
      [
        "_blank with rel opener",
        () => link({ href: "/p", target: "_blank", rel: "opener" }),
        "rel",
        ["content", 0, "content", 0, "marks", 0, "attrs", "rel"],
      ],
      [
        "_blank without noopener",
        () => link({ href: "/p", target: "_blank", rel: "noreferrer" }),
        "rel",
        ["content", 0, "content", 0, "marks", 0, "attrs", "rel"],
      ],
      [
        "_blank with rel null",
        () => link({ href: "/p", target: "_blank", rel: null }),
        "rel",
        ["content", 0, "content", 0, "marks", 0, "attrs", "rel"],
      ],
      [
        "missing target (_blank) with rel nofollow",
        () => link({ href: "/p", rel: "nofollow" }),
        "rel",
        ["content", 0, "content", 0, "marks", 0, "attrs", "rel"],
      ],
      [
        "href missing",
        () => link({}),
        "href",
        ["content", 0, "content", 0, "marks", 0, "attrs", "href"],
      ],
      [
        "href null",
        () => safeLink(null as unknown as string),
        "href",
        ["content", 0, "content", 0, "marks", 0, "attrs", "href"],
      ],
      ...(
        [
          "",
          "javascript:alert(1)",
          "JavaScript:alert(1)",
          "data:text/html,x",
          "vbscript:x",
          " javascript:x",
          "java\tscript:x",
          "java\nscript:x",
          "//host",
          "/\\host",
          "https://a\\b",
          "https://a/\tb",
          "https://a/\u0000b",
          "/p\u007f",
          "/p\u001f",
          "/p q",
          "/p　q",
          "/p﻿q",
          "/p q",
          "p/q",
          "ftp://a",
        ] as const
      ).map(
        (href): [string, () => unknown, RichTextRule, (string | number)[]] => [
          `href ${JSON.stringify(href)}`,
          () => safeLink(href),
          "href",
          ["content", 0, "content", 0, "marks", 0, "attrs", "href"],
        ]
      ),
      ["doc without blocks", () => doc(), "content", ["content"]],
      [
        "doc without content key",
        () => ({ type: "doc" }),
        "content",
        ["content"],
      ],
      ["text directly in doc", () => doc(t("a")), "content", ["content", 0]],
      [
        "paragraph in a list",
        () => doc({ type: "bulletList", content: [p()] }),
        "content",
        ["content", 0, "content", 0],
      ],
      [
        "empty list",
        () => doc({ type: "bulletList", content: [] }),
        "content",
        ["content", 0, "content"],
      ],
      [
        "listItem without a leading paragraph",
        () =>
          doc({
            type: "bulletList",
            content: [
              { type: "listItem", content: [{ type: "horizontalRule" }] },
            ],
          }),
        "content",
        ["content", 0, "content", 0, "content", 0],
      ],
      [
        "listItem empty",
        () => doc({ type: "bulletList", content: [{ type: "listItem" }] }),
        "content",
        ["content", 0, "content", 0, "content", 0],
      ],
      [
        "block in a paragraph",
        () => inP(p()),
        "content",
        ["content", 0, "content", 0],
      ],
      [
        "hardBreak in codeBlock",
        () => doc({ type: "codeBlock", content: [{ type: "hardBreak" }] }),
        "content",
        ["content", 0, "content", 0],
      ],
      [
        "child of a leaf",
        () => doc({ type: "horizontalRule", content: [p()] }),
        "content",
        ["content", 0, "content", 0],
      ],
      [
        "content not an array",
        () => doc({ type: "paragraph", content: {} }),
        "shape",
        ["content", 0, "content"],
      ],
      [
        "empty text",
        () => inP(t("")),
        "text",
        ["content", 0, "content", 0, "text"],
      ],
      [
        "text not a string",
        () => inP({ type: "text", text: 1 }),
        "text",
        ["content", 0, "content", 0, "text"],
      ],
      [
        "text missing",
        () => inP({ type: "text" }),
        "text",
        ["content", 0, "content", 0, "text"],
      ],
      [
        "duplicate mark",
        () => inP(t("a", [{ type: "bold" }, { type: "bold" }])),
        "mark-duplicate",
        ["content", 0, "content", 0, "marks", 1],
      ],
      [
        "code with bold",
        () => inP(t("a", [{ type: "bold" }, { type: "code" }])),
        "mark-excluded",
        ["content", 0, "content", 0, "marks", 1],
      ],
      [
        "code with link",
        () =>
          inP(
            t("a", [{ type: "code" }, { type: "link", attrs: { href: "/p" } }])
          ),
        "mark-excluded",
        ["content", 0, "content", 0, "marks", 0],
      ],
      [
        "mark in codeBlock",
        () => doc({ type: "codeBlock", content: [t("a", [{ type: "bold" }])] }),
        "marks-not-allowed",
        ["content", 0, "content", 0, "marks"],
      ],
      [
        "mark on a block",
        () => doc({ ...p(), marks: [{ type: "bold" }] }),
        "marks-not-allowed",
        ["content", 0, "marks"],
      ],
      [
        "marks not an array",
        () => inP({ ...t("a"), marks: {} }),
        "shape",
        ["content", 0, "content", 0, "marks"],
      ],
      [
        "mark not an object",
        () => inP(t("a", ["bold"])),
        "shape",
        ["content", 0, "content", 0, "marks", 0],
      ],
      [
        "depth 65",
        () => nested(65),
        "depth",
        Array.from({ length: 64 }).flatMap(() => ["content", 0]),
      ],
    ]

  it.each(refusals)("refuses %s", (_, build, rule, at) => {
    expect(checkRichText(build())).toEqual({ ok: false, at, rule })
  })

  it("refuses instead of stripping and never changes the value", () => {
    const value = doc(
      p(t("a")),
      { type: "blockquote", content: [{ type: "image", attrs: { src: "x" } }] },
      p(t("b"))
    )
    const before = structuredClone(value)
    expect(checkRichText(value).ok).toBe(false)
    expect(value).toEqual(before)
  })

  it("does not fill in a missing attribute", () => {
    const value = link({ href: "/p" })
    const before = structuredClone(value)
    expect(checkRichText(value)).toEqual({ ok: true })
    expect(value).toEqual(before)
  })

  it("never throws on a value far deeper than the stack allows", () => {
    let deep: unknown = t("a")
    for (let i = 0; i < 200_000; i++)
      deep = { type: "blockquote", content: [deep] }
    expect(checkRichText(doc(deep))).toMatchObject({ ok: false, rule: "depth" })
  })
})

describe("values that throw while read", () => {
  const revoked = () => {
    const { proxy, revoke } = Proxy.revocable({}, {})
    revoke()
    return proxy
  }
  const throwingType = () =>
    Object.defineProperty({}, "type", {
      enumerable: true,
      get() {
        throw new Error("getter")
      },
    })
  const throwingPrototype = () =>
    new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("trap")
        },
      }
    )
  const cases: [string, () => unknown][] = [
    ["a revoked proxy at the root", revoked],
    ["a revoked proxy nested", () => doc(revoked())],
    ["a throwing type getter at the root", throwingType],
    ["a throwing type getter nested", () => doc(throwingType())],
    ["a throwing getPrototypeOf trap at the root", throwingPrototype],
    ["a throwing getPrototypeOf trap nested", () => doc(throwingPrototype())],
  ]

  it.each(cases)("checkRichText refuses %s", (_, build) => {
    expect(checkRichText(build())).toEqual({ ok: false, at: [], rule: "shape" })
  })

  // `Array.isArray` кидає лише на відкликаному проксі, `Object.values` — на
  // геттері; пастка прототипа обходу глибини не зачіпає.
  it.each([cases[0]!, cases[1]!, cases[2]!, cases[3]!])(
    "richTextDepthOk refuses %s",
    (_, build) => {
      expect(richTextDepthOk(build())).toBe(false)
    }
  )
})

describe("richTextDepthOk", () => {
  it("accepts the deepest valid document", () => {
    expect(richTextDepthOk(nested(64))).toBe(true)
  })

  it("refuses deep nesting under any key, not only content", () => {
    let deep: unknown = 1
    for (let i = 0; i < 200_000; i++) deep = [deep]
    expect(
      richTextDepthOk(doc({ type: "paragraph", attrs: { x: deep } }))
    ).toBe(false)
    expect(richTextDepthOk(deep)).toBe(false)
  })

  it("bounds JSON nesting at 130 levels", () => {
    const levels = (n: number) => {
      let value: unknown = 1
      for (let i = 0; i < n; i++) value = { a: value }
      return value
    }
    expect(richTextDepthOk(levels(130))).toBe(true)
    expect(richTextDepthOk(levels(131))).toBe(false)
  })
})

describe("RICH_TEXT_WHITESPACE", () => {
  it("is exactly the set of JavaScript \\s", () => {
    const set = new Set(RICH_TEXT_WHITESPACE)
    const mismatched: number[] = []
    for (let code = 0; code <= 0x10ffff; code++) {
      if (code >= 0xd800 && code <= 0xdfff) continue
      if (/\s/u.test(String.fromCodePoint(code)) !== set.has(code))
        mismatched.push(code)
    }
    expect(mismatched).toEqual([])
  })
})

describe("isRichTextEmpty", () => {
  it.each(RICH_TEXT_EMPTINESS_CASES)(
    "$name — empty: $empty",
    ({ doc: value, empty }) => {
      expect(isRichTextEmpty(value)).toBe(empty)
    }
  )

  it("never throws on a value far deeper than the stack allows", () => {
    let deep: unknown = { type: "text", text: "a" }
    for (let i = 0; i < 200_000; i++) deep = [deep]
    expect(isRichTextEmpty(deep)).toBe(false)
  })

  // JSON `null` — лише тут: у спільній таблиці його SQL отримав би як `NULL`.
  it("treats JSON null as empty", () => {
    expect(isRichTextEmpty(null)).toBe(true)
  })

  it("is not empty for the StarterKit sample", () => {
    expect(isRichTextEmpty(STARTER_KIT_SAMPLE)).toBe(false)
  })
})
