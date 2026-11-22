import { describe, expect, it } from "vitest"
import { standardElementId } from "../../schemas/element-id"
import { catalogIndex } from "../mapping"
import { KIND_REGISTRY } from "../../kinds/registry"
import { STRUCTURAL_PATH_WORDS, pathFromWire, pathToWire } from "../path"
import {
  MEMBERSHIP_ID,
  OBJECT_ID,
  SECTION_ID,
  catalogEntry,
  catalogEntryAttribute,
  catalogEntrySection,
} from "./entries"

const ODD_ID = "00000000-0000-4000-8000-000000000201"
const ROLES_ID = standardElementId(OBJECT_ID, { logicalName: "roles" })

// Колонки відмінні від імен: тест бачить, що сегмент справді змапився.
const root = catalogEntry({
  versionColumn: "version_no",
  creatorMembership: MEMBERSHIP_ID,
  attributes: [
    catalogEntryAttribute({ name: "title", column: "title_col" }),
    catalogEntryAttribute({ name: "tags", column: "tag_list", array: true }),
    catalogEntryAttribute({
      name: "subject",
      column: "subject_id",
      type: "Ref",
      maxLength: undefined,
      pair: {
        typeColumn: "subject_type",
        targets: [
          { object: { kind: "Catalog", name: "Project" }, label: "project" },
        ],
      },
    }),
  ],
  tabularSections: [
    catalogEntrySection({
      attributes: [
        catalogEntryAttribute({ name: "qty", column: "qty_col" }),
        catalogEntryAttribute({
          name: "marks",
          column: "mark_list",
          array: true,
        }),
      ],
    }),
    catalogEntrySection({
      id: ROLES_ID,
      name: "roles",
      table: { schema: "public", name: "task_roles" },
      attributes: [catalogEntryAttribute({ name: "role", column: "role_id" })],
    }),
  ],
})

const membership = catalogEntry({
  id: MEMBERSHIP_ID,
  name: "Member",
  key: "member_id",
  attributes: [catalogEntryAttribute({ name: "user", column: "user_id" })],
  tabularSections: [],
})

// Об'єкт без реквізитів і без членства: його шляхи проходять без змін.
const odd = catalogEntry({
  id: ODD_ID,
  name: "Odd",
  attributes: [],
  tabularSections: [],
})

const index = catalogIndex([root, membership, odd])

describe("pathToWire / pathFromWire", () => {
  it.each([
    ["a header attribute", "title", "title_col"],
    ["an array item", "tags.1", "tag_list.1"],
    ["a pair by its id column", "subject", "subject_id"],
    ["the key", "ref", "id"],
    ["the version", "version", "version_no"],
    ["a section", "lines", SECTION_ID],
    ["a section line", "lines.0", `${SECTION_ID}.0`],
    ["a line attribute", "lines.0.qty", `${SECTION_ID}.0.qty_col`],
    ["a line key", "lines.0.ref", `${SECTION_ID}.0.id`],
    ["a line array item", "lines.0.marks.2", `${SECTION_ID}.0.mark_list.2`],
    ["a section attribute without index", "lines.qty", `${SECTION_ID}.qty_col`],
    ["a standard section", "roles.1.role", `${ROLES_ID}.1.role_id`],
    ["an unknown line name", "lines.0.nope", `${SECTION_ID}.0.nope`],
    ["creatorMember", "creatorMember", "creatorMember"],
    ["a member attribute", "creatorMember.user", "creatorMember.user_id"],
    ["the member key", "creatorMember.ref", "creatorMember.member_id"],
    ["values", "values", "values"],
    ["expectedValues", "expectedValues", "expectedValues"],
    ["a base value", "expectedValues.title", "expectedValues.title_col"],
    ["a base pair", "expectedValues.subject", "expectedValues.subject_id"],
    ["a base array item", "expectedValues.tags.1", "expectedValues.tag_list.1"],
    ["an unknown base name", "expectedValues.nope", "expectedValues.nope"],
    ["a read path", "orderBy.0.attribute", "orderBy.0.attribute"],
    ["expectedVersion", "expectedVersion", "expectedVersion"],
    ["an application path", "invoice.total.1", "invoice.total.1"],
    ["__proto__", "__proto__", "__proto__"],
    ["a line __proto__", "lines.0.__proto__", `${SECTION_ID}.0.__proto__`],
  ])("maps %s", (_, logical, wire) => {
    expect(pathToWire(index, OBJECT_ID, logical)).toBe(wire)
    expect(pathFromWire(index, OBJECT_ID, wire)).toBe(logical)
  })

  it.each([
    "action",
    "values",
    "tabularSections",
    "creatorMember",
    "orderBy.0.attribute",
    "include.0",
    "tabularSections.0",
    "tabularSection",
    "expectedVersion",
    "title",
    "lines.0.qty",
    "creatorMember.user",
    "expectedValues.title",
    // Ключ запису: T3 називає його лише `keyName` (колонка `id` на дроті).
    "ref",
    "lines.0.ref",
  ])("pathFromWire inverts pathToWire for %s", (path) => {
    expect(
      pathFromWire(index, OBJECT_ID, pathToWire(index, OBJECT_ID, path))
    ).toBe(path)
  })

  it("maps a structural prefix before a same-named attribute or column", () => {
    // Ім'я каталогу не перехоплює структурне слово: компілятор забороняє
    // такі імена (`identity.name-structural`), а фізичну колонку — ні.
    const named = catalogEntry({
      id: ODD_ID,
      name: "Odd",
      attributes: [
        catalogEntryAttribute({ name: "title", column: "title_col" }),
        catalogEntryAttribute({ name: "ev", column: "expectedValues" }),
        catalogEntryAttribute({ name: "cm", column: "creatorMember" }),
        catalogEntryAttribute({ name: "vals", column: "values" }),
        catalogEntryAttribute({ name: "mk", column: "mark" }),
        catalogEntryAttribute({ name: "expv", column: "expectedVersion" }),
        catalogEntryAttribute({ name: "secs", column: "tabularSections" }),
        catalogEntryAttribute({ name: "dels", column: "deleteIds" }),
      ],
      tabularSections: [],
    })
    const own = catalogIndex([named])
    expect(pathToWire(own, ODD_ID, "expectedValues.title")).toBe(
      "expectedValues.title_col"
    )
    expect(pathFromWire(own, ODD_ID, "expectedValues.title_col")).toBe(
      "expectedValues.title"
    )
    expect(pathToWire(own, ODD_ID, "expectedValues")).toBe("expectedValues")
    expect(pathFromWire(own, ODD_ID, "expectedValues")).toBe("expectedValues")
    expect(pathToWire(own, ODD_ID, "creatorMember.user")).toBe(
      "creatorMember.user"
    )
    expect(pathFromWire(own, ODD_ID, "creatorMember")).toBe("creatorMember")
    // Кожне структурне слово проходить як префікс в обидва боки, навіть коли
    // колонка названа так само (`values`, `mark`, …).
    for (const word of [
      "values",
      "mark",
      "expectedVersion",
      "tabularSections",
      "deleteIds",
    ]) {
      expect(pathFromWire(own, ODD_ID, word)).toBe(word)
      expect(pathToWire(own, ODD_ID, word)).toBe(word)
      expect(pathFromWire(own, ODD_ID, `${word}.0`)).toBe(`${word}.0`)
    }
  })

  it("keeps the path of an unknown object", () => {
    const unknown = "00000000-0000-4000-8000-000000000999"
    expect(pathToWire(index, unknown, "lines.0.qty")).toBe("lines.0.qty")
    expect(pathFromWire(index, unknown, `${SECTION_ID}.0`)).toBe(
      `${SECTION_ID}.0`
    )
  })

  it("keeps creatorMember paths of an object without a membership catalog", () => {
    expect(pathToWire(index, ODD_ID, "creatorMember.user")).toBe(
      "creatorMember.user"
    )
  })
})

describe("STRUCTURAL_PATH_WORDS", () => {
  // Стандартне ім'я елемента виду не резервується: діагностика обходить лише
  // названі елементи, тож резерв зробив би стандартний реквізит недійсним.
  it("shares no word with the standard names of the kind registry", () => {
    const standard = new Set<string>()
    for (const [kind, def] of Object.entries(KIND_REGISTRY)) {
      // Вид, якому мінімального файлу замало (власні обов'язкові поля), не
      // має стандартних колонок, що залежали б від них.
      const parsed = def.schema.safeParse({ kind, name: "Sample" })
      if (!parsed.success) continue
      const data = parsed.data
      const columns = [
        ...def.standardColumns(data),
        ...(def.tabularSectionColumns?.(data) ?? []),
      ]
      for (const c of columns) standard.add(c.logicalName)
      for (const s of def.standardTabularSections?.(data) ?? [])
        standard.add(s.logicalName)
    }
    expect(standard.size).toBeGreaterThan(0)
    expect(STRUCTURAL_PATH_WORDS.filter((w) => standard.has(w))).toEqual([])
  })

  it("lists the head of every operation form", () => {
    expect([...STRUCTURAL_PATH_WORDS].sort()).toEqual(
      [
        "creatorMember",
        "deleteIds",
        "expectedValues",
        "expectedVersion",
        "mark",
        "tabularSections",
        "values",
      ].sort()
    )
  })
})
