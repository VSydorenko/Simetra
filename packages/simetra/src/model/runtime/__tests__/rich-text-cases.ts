import { RICH_TEXT_WHITESPACE } from "../rich-text"

/**
 * Спільна таблиця порожності `RichText` (Р-B7-7): unit T0 (`isRichTextEmpty`),
 * DB-тест B7 і тести CHECK B3 (`simetra.rich_text_is_empty`) читають ті самі
 * випадки, тож відповідь T0 і SQL одна. Лише значення, які `jsonb` може
 * зберегти: без `\u0000` і без самотніх сурогатів; `null` JSON
 * не входить, бо параметр `null` драйвер шле як SQL `NULL`, а на ньому
 * функція `STRICT` дає `NULL`.
 */
export interface RichTextEmptinessCase {
  readonly name: string
  readonly doc: unknown
  readonly empty: boolean
}

const paragraph = (...content: unknown[]) => ({
  type: "doc",
  content: [{ type: "paragraph", content }],
})
const text = (value: string) => ({ type: "text", text: value })

export const RICH_TEXT_EMPTINESS_CASES: readonly RichTextEmptinessCase[] = [
  {
    name: "doc with an empty paragraph",
    doc: { type: "doc", content: [{ type: "paragraph" }] },
    empty: true,
  },
  { name: "doc without content", doc: { type: "doc" }, empty: true },
  { name: "text", doc: paragraph(text("a")), empty: false },
  {
    name: "spaces, tab and newline",
    doc: paragraph(text(" \t\n\r\v\f")),
    empty: true,
  },
  { name: "NBSP only", doc: paragraph(text(" ")), empty: true },
  { name: "U+3000 only", doc: paragraph(text("　")), empty: true },
  { name: "U+FEFF only", doc: paragraph(text("﻿")), empty: true },
  { name: "U+2028 and U+2029 only", doc: paragraph(text("  ")), empty: true },
  { name: "U+200B only (not in \\s)", doc: paragraph(text("​")), empty: false },
  {
    name: "whitespace around a letter",
    doc: paragraph(text(" x　")),
    empty: false,
  },
  { name: "astral character", doc: paragraph(text("\u{1f600}")), empty: false },
  {
    name: "whitespace across text nodes",
    doc: paragraph(text(" "), { type: "hardBreak" }, text("　")),
    empty: true,
  },
  {
    name: "text in a nested list",
    doc: {
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [{ type: "paragraph", content: [text("deep")] }],
            },
          ],
        },
      ],
    },
    empty: false,
  },
  {
    name: "horizontal rule only",
    doc: { type: "doc", content: [{ type: "horizontalRule" }] },
    empty: true,
  },
  {
    name: "text only in an attribute",
    doc: {
      type: "doc",
      content: [{ type: "codeBlock", attrs: { language: "text" } }],
    },
    empty: true,
  },
  {
    name: "text only in a mark attribute",
    doc: paragraph({
      type: "hardBreak",
      marks: [{ type: "link", attrs: { href: "https://a", title: "title" } }],
    }),
    empty: true,
  },
  {
    name: "text node object under attrs",
    doc: {
      type: "doc",
      content: [
        { type: "paragraph", attrs: { x: { type: "text", text: "a" } } },
      ],
    },
    empty: false,
  },
  {
    name: "text node object at the root",
    doc: { type: "text", text: "a" },
    empty: false,
  },
  {
    name: "text node inside an array of arrays",
    doc: [[{ type: "text", text: "a" }]],
    empty: false,
  },
  {
    name: "type text without a string text",
    doc: paragraph({ type: "text", text: 1 }),
    empty: true,
  },
  {
    name: "type not exactly text",
    doc: paragraph({ type: ["text"], text: "a" }),
    empty: true,
  },
  { name: "text without type", doc: paragraph({ text: "a" }), empty: true },
  { name: "empty text", doc: paragraph(text("")), empty: true },
  { name: "array", doc: [], empty: true },
  { name: "string", doc: "x", empty: true },
  { name: "number", doc: 1, empty: true },
  { name: "boolean", doc: true, empty: true },
  { name: "empty object", doc: {}, empty: true },
  // Кожен символ сталої T0 окремо: мутація одного символу сталої чи класу SQL
  // червоніє, а не ховається за переліком руками.
  ...RICH_TEXT_WHITESPACE.map((code) => ({
    name: `only U+${code.toString(16).toUpperCase().padStart(4, "0")}`,
    doc: paragraph(text(String.fromCodePoint(code))),
    empty: true,
  })),
]
