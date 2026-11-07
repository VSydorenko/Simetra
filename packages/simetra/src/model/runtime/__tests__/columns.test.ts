import { describe, expect, it } from "vitest"
import { objectColumns } from "../columns"
import {
  catalogEntry,
  catalogEntryAttribute,
  catalogEntrySection,
  SECTION_ID,
} from "./entries"

describe("objectColumns", () => {
  it("lists the columns of a scoped catalog with a pair, a lazy field and a section", () => {
    const columns = objectColumns(catalogEntry())
    expect({ ...columns, tabularSections: undefined }).toEqual({
      insert: [
        "org_id",
        "title",
        "status",
        "subject_id",
        "subject_type",
        "notes",
      ],
      update: ["title", "status", "subject_id", "subject_type", "notes"],
      // Скоуп `org_id` — і колонка скоупу, і реквізит: у переліку один раз.
      read: [
        "id",
        "version",
        "org_id",
        "title",
        "status",
        "subject_id",
        "subject_type",
      ],
      lazy: ["notes"],
      tabularSections: undefined,
    })
    expect(columns.tabularSections.get(SECTION_ID)).toEqual({
      insert: ["id", "qty", "comment"],
      update: ["id", "qty", "comment"],
      read: ["id", "parent_id", "line_number", "qty", "comment"],
      lazy: [],
    })
  })

  const base = catalogEntry()
  const lists = (entry = base) => {
    const { tabularSections, ...header } = objectColumns(entry)
    return { header, section: tabularSections.get(SECTION_ID)! }
  }

  it.each([
    ["a renamed attribute", "title"],
    ["a renamed pair", "subject"],
  ])("%s keeps the lists", (_, name) => {
    const renamed = catalogEntry({
      attributes: base.attributes.map((a) =>
        a.name === name ? { ...a, name: `${name}Renamed` } : a
      ),
    })
    expect(objectColumns(renamed)).toEqual(objectColumns(base))
  })

  it("a load change moves a column between read and lazy", () => {
    const eager = catalogEntry({
      attributes: base.attributes.map((a) =>
        a.name === "notes" ? { ...a, load: undefined } : a
      ),
    })
    expect(lists(eager).header.read).toContain("notes")
    expect(lists(eager).header.lazy).toEqual([])
    expect(lists().header.read).not.toContain("notes")
    expect(lists().header.lazy).toEqual(["notes"])
  })

  it("a new optional attribute only extends the lists", () => {
    const extended = catalogEntry({
      attributes: [
        ...base.attributes,
        catalogEntryAttribute({
          name: "extra",
          column: "extra",
          required: false,
        }),
      ],
      tabularSections: [
        catalogEntrySection({
          attributes: [
            ...base.tabularSections[0]!.attributes,
            catalogEntryAttribute({
              name: "more",
              column: "more",
              required: false,
            }),
          ],
        }),
      ],
    })
    const before = lists()
    const after = lists(extended)
    for (const key of ["insert", "update", "read", "lazy"] as const) {
      expect(after.header[key]).toEqual(
        expect.arrayContaining([...before.header[key]])
      )
      expect(after.section[key]).toEqual(
        expect.arrayContaining([...before.section[key]])
      )
    }
    expect(after.header.insert).toContain("extra")
    expect(after.section.read).toContain("more")
  })

  it("a section reads key, parent, line number first and inserts the key first", () => {
    const { section } = lists()
    expect(section.read.slice(0, 3)).toEqual(["id", "parent_id", "line_number"])
    expect(section.insert[0]).toBe("id")
    expect(section.update[0]).toBe("id")
  })

  it("a generated attribute without insert and update is only read", () => {
    const entry = catalogEntry({
      attributes: [
        catalogEntryAttribute({
          name: "number",
          column: "number",
          insert: false,
          update: false,
          generated: true,
        }),
      ],
    })
    const { header } = lists(entry)
    expect(header.read).toContain("number")
    expect(header.insert).not.toContain("number")
    expect(header.update).not.toContain("number")
  })

  it.each([
    ["a scoped catalog", catalogEntry()],
    [
      "a scope root, whose scope column is the key",
      catalogEntry({ scopeColumn: "id", attributes: [] }),
    ],
  ])("%s lists no column twice", (_, entry) => {
    const { header, section } = lists(entry)
    for (const list of [...Object.values(header), ...Object.values(section)]) {
      expect(new Set(list).size).toBe(list.length)
    }
  })
})
