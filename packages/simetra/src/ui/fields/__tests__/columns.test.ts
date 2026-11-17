import { describe, expect, it } from "vitest"
import {
  catalogEntry,
  catalogEntryAttribute,
} from "../../../model/runtime/__tests__/entries"
import { cardFields, headerColumns } from "../columns"

const names = (columns: readonly { name: string }[]) =>
  columns.map((c) => c.name)

// Типовий запис: `org` — колонка скоупу, `subject` — пара, `notes` — лінивий.
describe("headerColumns / cardFields", () => {
  it("список без лінивих і без колонки скоупу, картка — з лінивими, в порядку каталогу", () => {
    const entry = catalogEntry()
    expect(names(headerColumns(entry))).toEqual(["title", "status", "subject"])
    expect(names(cardFields(entry))).toEqual([
      "title",
      "status",
      "subject",
      "notes",
    ])
  })

  it("заголовок колонки — логічне ім'я", () => {
    expect(headerColumns(catalogEntry())[0]).toMatchObject({
      name: "title",
      title: "title",
    })
  })

  it("колонка скоупу не службова, коли запис скоупу не має", () => {
    const entry = catalogEntry({
      scopeKindId: undefined,
      scopeColumn: undefined,
    })
    expect(names(headerColumns(entry))).toContain("org")
  })

  it("службові колонки: ключ, версія й мітка пари не потрапляють", () => {
    const entry = catalogEntry({
      attributes: [
        ...catalogEntry().attributes,
        catalogEntryAttribute({ name: "key", column: "id" }),
        catalogEntryAttribute({ name: "ver", column: "version" }),
        catalogEntryAttribute({ name: "mark", column: "subject_type" }),
      ],
    })
    expect(names(headerColumns(entry))).toEqual(["title", "status", "subject"])
    expect(names(cardFields(entry))).toEqual([
      "title",
      "status",
      "subject",
      "notes",
    ])
  })
})
