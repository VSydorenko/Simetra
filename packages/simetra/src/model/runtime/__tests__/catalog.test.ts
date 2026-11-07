import { describe, expect, expectTypeOf, it } from "vitest"
import {
  catalogEntrySchema,
  runtimeCatalogSchema,
  runtimeObjectSchema,
  runtimeSectionSchema,
  type CatalogEntry,
  type RuntimeObject,
} from "../catalog"
import { standardElementId } from "../../schemas/element-id"
import {
  KERNEL_HASH,
  MEMBERSHIP_ID,
  OBJECT_ID,
  catalogEntry,
  catalogEntrySection,
  runtimeObject,
} from "./entries"

describe("catalog entries", () => {
  const entry = runtimeObject()
  const [section] = entry.tabularSections
  // id ТЧ — її ідентичність у формі передачі (рішення В4, В12): ім'я ТЧ
  // змінне; стандартна ТЧ має синтетичний id елемента.
  it.each([
    ["a runtime entry", runtimeObjectSchema, entry, true],
    ["a shared entry", catalogEntrySchema, catalogEntry(), true],
    [
      "a runtime section without id",
      runtimeObjectSchema,
      { ...entry, tabularSections: [{ ...section, id: undefined }] },
      false,
    ],
    [
      "a standard section with a synthetic id",
      runtimeObjectSchema,
      {
        ...entry,
        tabularSections: [
          {
            ...section,
            id: standardElementId(OBJECT_ID, { logicalName: "delta" }),
          },
        ],
      },
      true,
    ],
    [
      "a runtime section with a non-element id",
      runtimeObjectSchema,
      { ...entry, tabularSections: [{ ...section, id: "lines" }] },
      false,
    ],
    [
      "a shared section with a non-element id",
      catalogEntrySchema,
      catalogEntry({ tabularSections: [catalogEntrySection({ id: "lines" })] }),
      false,
    ],
    [
      "a runtime object with a non-UUID id",
      runtimeObjectSchema,
      { ...entry, id: "Task" },
      false,
    ],
    [
      "a shared object with a non-UUID id",
      catalogEntrySchema,
      catalogEntry({ id: "Task" }),
      false,
    ],
    // Спільна частина не несе розширень рантайму: строгий об'єкт їх відхиляє.
    [
      "a shared entry with runtime constraints",
      catalogEntrySchema,
      { ...catalogEntry(), constraints: [] },
      false,
    ],
    [
      "a kernelHash not in lowercase hex",
      catalogEntrySchema,
      catalogEntry({ kernelHash: "A".repeat(64) }),
      false,
    ],
  ])("%s", (_, schema, input, ok) => {
    expect(schema.safeParse(input).success).toBe(ok)
  })

  it("a runtime entry is a shared entry", () => {
    expectTypeOf<RuntimeObject>().toExtend<CatalogEntry>()
  })
})

describe("runtimeObjectSchema: creatorMembership", () => {
  const withRoot = (membership?: string): RuntimeObject => {
    const entry = runtimeObject()
    return {
      ...entry,
      operations: {
        ...entry.operations,
        create: {
          ...entry.operations!.create!,
          root: membership === undefined ? {} : { membership },
        },
      },
    }
  }
  const OTHER_ID = "00000000-0000-4000-8000-000000000106"

  // Клієнт мапить `creatorMember` за полем спільної частини, ядро перевіряє
  // за `operations`: розбіжність дала б запис не в той довідник членства.
  it.each<[string, RuntimeObject, boolean]>([
    [
      "both name the same membership catalog",
      { ...withRoot(MEMBERSHIP_ID), creatorMembership: MEMBERSHIP_ID },
      true,
    ],
    ["a root without a creator and no field", withRoot(), true],
    [
      "the root names a membership the entry omits",
      withRoot(MEMBERSHIP_ID),
      false,
    ],
    [
      "the entry names a membership the root lacks",
      { ...withRoot(), creatorMembership: MEMBERSHIP_ID },
      false,
    ],
    [
      "a field on a non-root entry",
      runtimeObject({ creatorMembership: MEMBERSHIP_ID }),
      false,
    ],
    [
      "different membership catalogs",
      { ...withRoot(MEMBERSHIP_ID), creatorMembership: OTHER_ID },
      false,
    ],
  ])("%s", (_, input, ok) => {
    expect(runtimeObjectSchema.safeParse(input).success).toBe(ok)
  })
})

describe("runtimeCatalogSchema", () => {
  it("accepts an object without the operations field", () => {
    // Об'єкт без команд (лише читання) не мусить нести порожній запис.
    const parsed = runtimeCatalogSchema.parse({
      format: 1,
      snapshotHash: "hash-1",
      provider: "supabase",
      objects: [
        {
          id: "00000000-0000-4000-8000-000000000001",
          name: "Report",
          kind: "Catalog",
          kindLabel: "report",
          table: { schema: "public", name: "report" },
          key: "id",
          keyName: "ref",
          versionColumn: "version",
          versionName: "version",
          kernelHash: KERNEL_HASH,
          signal: true,
          attributes: [],
          tabularSections: [],
          constraints: [],
        },
      ],
    })
    expect(parsed.objects[0]!.operations).toBeUndefined()
  })
})

describe("runtimeSectionSchema", () => {
  const section = runtimeObject().tabularSections[0]!
  const parentKey = section.constraints[0]!

  // Будівник корелює ТЧ з власником за всіма колонками FK власника: без
  // `references` чи з чужим іменем кореляції не з чого побудувати.
  it.each([
    ["a parent foreign key with its references", true, section],
    ["no parentConstraint", false, { ...section, parentConstraint: undefined }],
    [
      "a parentConstraint naming no constraint",
      false,
      { ...section, parentConstraint: "missing_fkey" },
    ],
    [
      "a parentConstraint naming a unique",
      false,
      {
        ...section,
        constraints: [{ ...parentKey, kind: "unique", references: undefined }],
      },
    ],
    [
      "a parent foreign key without references",
      false,
      { ...section, constraints: [{ ...parentKey, references: undefined }] },
    ],
    [
      "references on a non-foreign-key constraint",
      false,
      {
        ...section,
        constraints: [
          parentKey,
          {
            name: "lines_pkey",
            kind: "primaryKey",
            columns: ["id"],
            references: ["id"],
          },
        ],
      },
    ],
    [
      "references not matching the columns",
      false,
      { ...section, constraints: [{ ...parentKey, references: ["id"] }] },
    ],
  ])("parses %s as %s", (_, ok, input) => {
    expect(runtimeSectionSchema.safeParse(input).success).toBe(ok)
  })
})
