/**
 * The `RichText` profile (multilingual data spec §5.7): the one set of nodes,
 * marks and attributes a `RichText` value may hold — the schema of Tiptap
 * StarterKit 3.35.0 — its check and the emptiness predicate.
 */

/** A primitive attribute value of a rich-text node or mark. */
export type RichTextAttrValue = string | number | boolean | null

/** A mark of a rich-text node in ProseMirror JSON (`getJSON` form). */
export interface RichTextMark {
  type: string
  attrs?: Record<string, RichTextAttrValue>
}

/** A node of a rich-text document in ProseMirror JSON (`getJSON` form). */
export interface RichTextNode {
  type: string
  attrs?: Record<string, RichTextAttrValue>
  content?: RichTextNode[]
  marks?: RichTextMark[]
  text?: string
}

/** The value of a `RichText` attribute: the top `doc` node. */
export interface RichTextDocument {
  type: "doc"
  content: RichTextNode[]
}

/**
 * An attribute of a profile node or mark: the value a missing attribute
 * means (`getJSON` writes every attribute with its default) and its domain.
 */
export interface RichTextAttrSpec {
  readonly default: RichTextAttrValue
  readonly valid: (value: unknown) => boolean
  /** The rule a value outside the domain breaks; `attr-value` when unset. */
  readonly rule?: RichTextRule
}

/**
 * The content expression of a node, the subset of ProseMirror's that
 * StarterKit needs: when `first` is set, the first child must be that node;
 * every other child matches `rest` (a node name or a group), at least `min`
 * of them. `null` — a leaf: no children.
 */
export interface RichTextContentSpec {
  readonly first?: string
  readonly rest: string
  readonly min: number
}

export interface RichTextNodeSpec {
  readonly groups: readonly string[]
  readonly attrs: Readonly<Record<string, RichTextAttrSpec>>
  readonly content: RichTextContentSpec | null
  /** Whether the children of this node may carry marks. */
  readonly childMarks: boolean
}

export interface RichTextMarkSpec {
  readonly attrs: Readonly<Record<string, RichTextAttrSpec>>
  /** `"_"` — the mark excludes every other mark; `""` — only itself. */
  readonly excludes: "_" | ""
}

export interface RichTextProfile {
  /** The node type of the document root. */
  readonly top: string
  readonly nodes: Readonly<Record<string, RichTextNodeSpec>>
  readonly marks: Readonly<Record<string, RichTextMarkSpec>>
  /**
   * Node types that refer to an attachment: a document holding one is not
   * empty even without text.
   */
  readonly attachments: readonly string[]
}

/**
 * Most node levels of a rich-text document; the `doc` node is level 1. Nested
 * lists take two levels each (list and item).
 */
export const RICH_TEXT_MAX_DEPTH = 64

/**
 * Code points of JavaScript's `\s`, spelled out: the SQL emptiness check is
 * built from this list, because the `\s` of Postgres depends on the locale.
 */
export const RICH_TEXT_WHITESPACE: readonly number[] = [
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002,
  0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028,
  0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
]

const nullable =
  (valid: (value: string) => boolean) =>
  (value: unknown): boolean =>
    value === null || (typeof value === "string" && valid(value))

const integerFrom =
  (min: number, max = Number.MAX_SAFE_INTEGER) =>
  (value: unknown): boolean =>
    Number.isSafeInteger(value) &&
    (value as number) >= min &&
    (value as number) <= max

const LANGUAGE = /^[A-Za-z0-9_+#.-]{1,32}$/
const ORDERED_LIST_TYPES: readonly string[] = ["1", "a", "A", "i", "I"]
const REL_TOKENS: readonly string[] = [
  "noopener",
  "noreferrer",
  "nofollow",
  "ugc",
]
const HREF_SCHEMES: readonly string[] = ["http", "https", "mailto"]
const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):/

const WHITESPACE = new Set(RICH_TEXT_WHITESPACE)

/**
 * `href` of a link: an absolute `http:`/`https:`/`mailto:` URL, a path from
 * the root or an anchor.
 */
function hrefValid(value: unknown): boolean {
  if (typeof value !== "string" || value.length === 0) return false
  // Керівні й пробільні символи та `\` — до розбору схеми: парсер WHATWG
  // викидає їх зі схеми (`java\tscript:`), обрізає (` javascript:`) і читає
  // `\` як `/` (`/\host` — це `//host`, чужий хост).
  for (const char of value) {
    const code = char.codePointAt(0)!
    if (code <= 0x1f || code === 0x7f || WHITESPACE.has(code)) return false
  }
  if (value.includes("\\")) return false
  if (value.startsWith("#")) return true
  if (value.startsWith("/")) return !value.startsWith("//")
  const scheme = SCHEME.exec(value)
  return scheme !== null && HREF_SCHEMES.includes(scheme[1]!.toLowerCase())
}

function relValid(value: unknown): boolean {
  return (
    value === null ||
    (typeof value === "string" &&
      value.split(" ").every((token) => REL_TOKENS.includes(token)))
  )
}

const NO_ATTRS: Readonly<Record<string, RichTextAttrSpec>> = {}
const INLINE = { rest: "inline", min: 0 } as const
const BLOCKS = { rest: "block", min: 1 } as const
const ITEMS = { rest: "listItem", min: 1 } as const

/**
 * The profile of `RichText`: nodes and marks of Tiptap StarterKit 3.35.0
 * with their attributes (defaults — StarterKit's), content expressions and
 * mark exclusions. A change is additive only: a stored document must stay
 * valid.
 */
export const RICH_TEXT_PROFILE: RichTextProfile = {
  top: "doc",
  nodes: {
    doc: { groups: [], attrs: NO_ATTRS, content: BLOCKS, childMarks: false },
    paragraph: {
      groups: ["block"],
      attrs: NO_ATTRS,
      content: INLINE,
      childMarks: true,
    },
    text: {
      groups: ["inline"],
      attrs: NO_ATTRS,
      content: null,
      childMarks: false,
    },
    heading: {
      groups: ["block"],
      attrs: { level: { default: 1, valid: integerFrom(1, 6) } },
      content: INLINE,
      childMarks: true,
    },
    bulletList: {
      groups: ["block", "list"],
      attrs: NO_ATTRS,
      content: ITEMS,
      childMarks: false,
    },
    orderedList: {
      groups: ["block", "list"],
      attrs: {
        start: { default: 1, valid: integerFrom(0) },
        type: {
          default: null,
          valid: nullable((v) => ORDERED_LIST_TYPES.includes(v)),
        },
      },
      content: ITEMS,
      childMarks: false,
    },
    listItem: {
      groups: [],
      attrs: NO_ATTRS,
      content: { first: "paragraph", rest: "block", min: 0 },
      childMarks: false,
    },
    blockquote: {
      groups: ["block"],
      attrs: NO_ATTRS,
      content: BLOCKS,
      childMarks: false,
    },
    codeBlock: {
      groups: ["block"],
      attrs: {
        language: { default: null, valid: nullable((v) => LANGUAGE.test(v)) },
      },
      content: { rest: "text", min: 0 },
      childMarks: false,
    },
    hardBreak: {
      groups: ["inline"],
      attrs: NO_ATTRS,
      content: null,
      childMarks: false,
    },
    horizontalRule: {
      groups: ["block"],
      attrs: NO_ATTRS,
      content: null,
      childMarks: false,
    },
  },
  marks: {
    bold: { attrs: NO_ATTRS, excludes: "" },
    italic: { attrs: NO_ATTRS, excludes: "" },
    strike: { attrs: NO_ATTRS, excludes: "" },
    code: { attrs: NO_ATTRS, excludes: "_" },
    underline: { attrs: NO_ATTRS, excludes: "" },
    link: {
      attrs: {
        href: { default: null, valid: hrefValid, rule: "href" },
        target: { default: "_blank", valid: nullable((v) => v === "_blank") },
        rel: {
          default: "noopener noreferrer nofollow",
          valid: relValid,
          rule: "rel",
        },
        class: { default: null, valid: (v) => v === null },
        title: { default: null, valid: nullable(() => true) },
      },
      excludes: "",
    },
  },
  attachments: [],
}

/** Why `checkRichText` refused a value. */
export type RichTextRule =
  /** Not the JSON type the place needs (node, `content`, `marks`, `attrs`). */
  | "shape"
  /** The root is not a `doc` node. */
  | "root"
  | "unknown-node"
  | "unknown-key"
  | "unknown-mark"
  | "unknown-attr"
  /** An attribute outside its domain (`href` and `rel` have their own). */
  | "attr-value"
  | "href"
  /** `rel` outside its tokens, or `target: "_blank"` without `noopener`. */
  | "rel"
  /** A child the content expression of its parent does not allow. */
  | "content"
  /** A text node whose `text` is not a non-empty string. */
  | "text"
  | "mark-duplicate"
  | "mark-excluded"
  /** A mark on a child of a node whose children carry none (`codeBlock`). */
  | "marks-not-allowed"
  | "depth"

export type RichTextPath = readonly (string | number)[]

export type RichTextCheck =
  { ok: true } | { ok: false; at: RichTextPath; rule: RichTextRule }

const NODE_KEYS: readonly string[] = ["type", "attrs", "content", "marks"]
const TEXT_KEYS: readonly string[] = ["type", "text", "marks"]
const MARK_KEYS: readonly string[] = ["type", "attrs"]

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** Own lookup: `constructor` or `__proto__` is not a profile entry. */
function own<T>(
  record: Readonly<Record<string, T>>,
  key: string
): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined
}

type Refusal = Extract<RichTextCheck, { ok: false }>

function refuse(at: RichTextPath, rule: RichTextRule): Refusal {
  return { ok: false, at, rule }
}

/** Keys of `value` beyond `allowed` — the first, or `undefined`. */
function extraKey(
  value: Record<string, unknown>,
  allowed: readonly string[]
): string | undefined {
  return Object.keys(value).find((key) => !allowed.includes(key))
}

/**
 * Checks `attrs` against the specs: no unknown attribute, each value — the
 * given one or, when missing, the default — in its domain. Returns the
 * refusal or `undefined`.
 */
function checkAttrs(
  attrs: unknown,
  specs: Readonly<Record<string, RichTextAttrSpec>>,
  at: RichTextPath
): Refusal | undefined {
  if (attrs !== undefined && !isPlainObject(attrs)) return refuse(at, "shape")
  const given = attrs ?? {}
  const unknownAttr = Object.keys(given).find(
    (key) => !Object.hasOwn(specs, key)
  )
  if (unknownAttr !== undefined)
    return refuse([...at, unknownAttr], "unknown-attr")
  for (const [name, spec] of Object.entries(specs)) {
    // Пропущений атрибут — типове значення, як у `getJSON`; перевірка його не
    // дописує, але й не пропускає типове поза доменом (`href: null`).
    const value = Object.hasOwn(given, name) ? given[name] : spec.default
    if (!spec.valid(value)) {
      return refuse([...at, name], spec.rule ?? "attr-value")
    }
  }
  return undefined
}

function checkMarks(
  marks: unknown,
  allowed: boolean,
  at: RichTextPath
): Refusal | undefined {
  if (marks === undefined) return undefined
  if (!Array.isArray(marks)) return refuse(at, "shape")
  if (marks.length > 0 && !allowed) return refuse(at, "marks-not-allowed")
  const seen: string[] = []
  for (let i = 0; i < marks.length; i++) {
    const mark: unknown = marks[i]
    const markAt = [...at, i]
    if (!isPlainObject(mark) || typeof mark.type !== "string") {
      return refuse(markAt, "shape")
    }
    const spec = own(RICH_TEXT_PROFILE.marks, mark.type)
    if (spec === undefined) return refuse([...markAt, "type"], "unknown-mark")
    const key = extraKey(mark, MARK_KEYS)
    if (key !== undefined) return refuse([...markAt, key], "unknown-key")
    if (seen.includes(mark.type)) return refuse(markAt, "mark-duplicate")
    seen.push(mark.type)
    const attrsRefusal = checkAttrs(mark.attrs, spec.attrs, [
      ...markAt,
      "attrs",
    ])
    if (attrsRefusal !== undefined) return attrsRefusal
    // Посилання з `target: "_blank"` без `noopener` дає сторінці-цілі
    // `window.opener` — доступ до вкладки застосунку.
    if (mark.type === "link") {
      const attrs = (mark.attrs ?? {}) as Record<string, unknown>
      const target = Object.hasOwn(attrs, "target")
        ? attrs.target
        : spec.attrs.target!.default
      const rel = Object.hasOwn(attrs, "rel")
        ? attrs.rel
        : spec.attrs.rel!.default
      if (
        target === "_blank" &&
        !(typeof rel === "string" && rel.split(" ").includes("noopener"))
      ) {
        return refuse([...markAt, "attrs", "rel"], "rel")
      }
    }
  }
  const exclusive = seen.find(
    (type) => RICH_TEXT_PROFILE.marks[type]!.excludes === "_"
  )
  if (exclusive !== undefined && seen.length > 1) {
    return refuse([...at, seen.indexOf(exclusive)], "mark-excluded")
  }
  return undefined
}

function matches(spec: RichTextNodeSpec, type: string, rest: string): boolean {
  return type === rest || spec.groups.includes(rest)
}

/**
 * Checks a value against {@link RICH_TEXT_PROFILE}. Answers only yes or no:
 * the value is never changed, a missing attribute is accepted as its default
 * but not filled in. The walk is iterative and never throws, on any value; a
 * refusal names the first offending place (`at`, a path of keys and indexes
 * inside the value) and its rule.
 */
export function checkRichText(value: unknown): RichTextCheck {
  // Шлях кадру — ланцюжок до батька, а не копія масиву: копія на кожен вузол
  // коштувала б глибина × вузли ще до межі глибини.
  type Frame = {
    node: unknown
    up: Frame | undefined
    index: number
    depth: number
    parent: RichTextNodeSpec | undefined
  }
  const pathOf = (frame: Frame, tail: RichTextPath): RichTextPath => {
    const at: (string | number)[] = []
    for (let f: Frame | undefined = frame; f?.up !== undefined; f = f.up) {
      at.push(f.index, "content")
    }
    return [...at.reverse(), ...tail]
  }
  const stack: Frame[] = [
    { node: value, up: undefined, index: 0, depth: 1, parent: undefined },
  ]
  while (stack.length > 0) {
    const frame = stack.pop()!
    const { node, depth, parent } = frame
    const fail = (tail: RichTextPath, rule: RichTextRule) =>
      refuse(pathOf(frame, tail), rule)
    if (depth > RICH_TEXT_MAX_DEPTH) return fail([], "depth")
    if (!isPlainObject(node) || typeof node.type !== "string") {
      return fail([], "shape")
    }
    const spec = own(RICH_TEXT_PROFILE.nodes, node.type)
    if (spec === undefined) return fail(["type"], "unknown-node")
    if (parent === undefined && node.type !== RICH_TEXT_PROFILE.top) {
      return fail(["type"], "root")
    }
    const isText = node.type === "text"
    const key = extraKey(node, isText ? TEXT_KEYS : NODE_KEYS)
    if (key !== undefined) return fail([key], "unknown-key")
    if (isText && (typeof node.text !== "string" || node.text.length === 0)) {
      return fail(["text"], "text")
    }
    const marksRefusal = checkMarks(node.marks, parent?.childMarks ?? false, [
      "marks",
    ])
    if (marksRefusal !== undefined)
      return fail(marksRefusal.at, marksRefusal.rule)
    const attrsRefusal = checkAttrs(node.attrs, spec.attrs, ["attrs"])
    if (attrsRefusal !== undefined)
      return fail(attrsRefusal.at, attrsRefusal.rule)

    if (node.content !== undefined && !Array.isArray(node.content)) {
      return fail(["content"], "shape")
    }
    const children: unknown[] = node.content ?? []
    const content = spec.content
    if (content === null) {
      if (children.length > 0) return fail(["content", 0], "content")
      continue
    }
    const start = content.first === undefined ? 0 : 1
    if (content.first !== undefined) {
      const first: unknown = children[0]
      if (!isPlainObject(first) || first.type !== content.first) {
        return fail(["content", 0], "content")
      }
    }
    if (children.length - start < content.min)
      return fail(["content"], "content")
    for (let i = start; i < children.length; i++) {
      const child: unknown = children[i]
      // Форму дитини перевіряє її власний крок; тут — лише чи дозволяє її
      // вираз вмісту батька.
      if (!isPlainObject(child) || typeof child.type !== "string") continue
      const childSpec = own(RICH_TEXT_PROFILE.nodes, child.type)
      if (
        childSpec !== undefined &&
        !matches(childSpec, child.type, content.rest)
      ) {
        return fail(["content", i], "content")
      }
    }
    // У зворотному порядку: стек віддає першу дитину першою, тож відмова
    // називає перше місце документа.
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push({
        node: children[i],
        up: frame,
        index: i,
        depth: depth + 1,
        parent: spec,
      })
    }
  }
  return { ok: true }
}

/**
 * JSON levels a valid document may reach: a node of level `d` is the object
 * on JSON level `2d − 1`; its `marks` array, a mark and the mark's `attrs`
 * add three more, and attribute values are primitives.
 */
const MAX_JSON_DEPTH = 2 * RICH_TEXT_MAX_DEPTH + 2

/**
 * Whether the nesting of arrays and objects in `value`, under any key, stays
 * within what a document of {@link RICH_TEXT_MAX_DEPTH} levels can reach. It
 * runs before the recursive size measure of a value, which a deeper value
 * would overflow, and never refuses a value `checkRichText` accepts.
 * Iterative; never throws.
 */
export function richTextDepthOk(value: unknown): boolean {
  const stack: { value: unknown; depth: number }[] = [{ value, depth: 1 }]
  while (stack.length > 0) {
    const { value: item, depth } = stack.pop()!
    if (typeof item !== "object" || item === null) continue
    if (depth > MAX_JSON_DEPTH) return false
    for (const child of Array.isArray(item) ? item : Object.values(item)) {
      stack.push({ value: child, depth: depth + 1 })
    }
  }
  return true
}

function hasNonWhitespace(text: string): boolean {
  for (const char of text) {
    if (!WHITESPACE.has(char.codePointAt(0)!)) return true
  }
  return false
}

/**
 * Whether a `RichText` value is empty: nowhere in it, at any depth and under
 * any key, is there an object with `type: "text"` and a string `text` holding
 * a character outside {@link RICH_TEXT_WHITESPACE}, nor an object whose
 * `type` is an attachment node of the profile. Defined over any JSON value,
 * not only a profile document: an array, a string or `{}` is empty. The SQL
 * function `simetra.rich_text_is_empty` gives the same answer. Iterative;
 * never throws.
 */
export function isRichTextEmpty(value: unknown): boolean {
  const stack: unknown[] = [value]
  while (stack.length > 0) {
    const item = stack.pop()
    if (typeof item !== "object" || item === null) continue
    // Без розгортання `push(...)`: масив у сотні тисяч елементів перевищив би
    // межу аргументів виклику.
    if (Array.isArray(item)) {
      for (const child of item) stack.push(child)
      continue
    }
    const record = item as Record<string, unknown>
    const type = Object.hasOwn(record, "type") ? record.type : undefined
    if (
      type === "text" &&
      typeof record.text === "string" &&
      hasNonWhitespace(record.text)
    ) {
      return false
    }
    if (
      typeof type === "string" &&
      RICH_TEXT_PROFILE.attachments.includes(type)
    ) {
      return false
    }
    for (const child of Object.values(record)) stack.push(child)
  }
  return true
}
