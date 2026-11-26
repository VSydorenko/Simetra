import { describe, expect, it } from "vitest"
import { compile } from "simetra/compiler"
import {
  attribute,
  catalog,
  languagesCatalog,
  metaFiles,
  organization,
  project,
  scopedProject,
  uuid,
} from "./helpers"

const FILE = "catalogs/Languages/Languages.meta.json"
const PROJECT = "project.meta.json"
const SUBSCRIPTION = "event-subscriptions/Guard/Guard.meta.json"
const HANDLER_FILE = "sql/app/guard.sql"

const languages = (overrides: Record<string, unknown> = {}) =>
  languagesCatalog({ id: uuid(80), ...overrides })

const base = (overrides: Record<string, unknown> = {}) => ({
  [PROJECT]: project({ primaryDataLanguage: "uk" }),
  [FILE]: languages(),
  ...overrides,
})

const found = async (entries: Record<string, unknown>, prefix = "languages.") =>
  (await compile(metaFiles(entries))).diagnostics
    .filter((d) => d.code.startsWith(prefix))
    .map((d) => [d.code, d.file, d.pointer, d.severity])

describe("languages catalog role refusals (Р-B2-2)", () => {
  it("a catalog that matches the role facts compiles without diagnostics", async () => {
    const result = await compile(metaFiles(base()))
    expect(result.diagnostics).toEqual([])
  })

  it.each<[string, Record<string, unknown>, string, string, string]>([
    [
      "a second languages catalog",
      base({
        "catalogs/Other/Other.meta.json": catalog("Other", {
          role: "languages",
          codeLength: 12,
          autonumber: false,
        }),
      }),
      "languages.catalog-duplicate",
      "catalogs/Other/Other.meta.json",
      "/role",
    ],
    [
      "a scoped catalog",
      base({
        [PROJECT]: {
          ...scopedProject(),
          primaryDataLanguage: "uk",
        },
        "catalogs/Organization/Organization.meta.json": organization(),
        [FILE]: languages({ scope: "org" }),
      }),
      "languages.scope-not-none",
      FILE,
      "/scope",
    ],
    [
      "codeType Number",
      base({ [FILE]: languages({ codeType: "Number" }) }),
      "languages.code-form",
      FILE,
      "/codeType",
    ],
    [
      "codeLength other than the role's",
      base({ [FILE]: languages({ codeLength: 9 }) }),
      "languages.code-form",
      FILE,
      "/codeLength",
    ],
    [
      // Без колонки `code` тригер стану мови не будується, а не ламає компіляцію
      "codeLength 0",
      base({ [FILE]: languages({ codeLength: 0 }) }),
      "languages.code-form",
      FILE,
      "/codeLength",
    ],
    [
      "autonumber",
      base({ [FILE]: languages({ autonumber: true }) }),
      "languages.code-form",
      FILE,
      "/autonumber",
    ],
    [
      "codeUnique false",
      base({ [FILE]: languages({ codeUnique: false }) }),
      "languages.code-form",
      FILE,
      "/codeUnique",
    ],
    [
      "descriptionLength 0",
      base({ [FILE]: languages({ descriptionLength: 0 }) }),
      "languages.description-required",
      FILE,
      "/descriptionLength",
    ],
    [
      "publicRead",
      base({ [FILE]: languages({ publicRead: "anon" }) }),
      "languages.public-read",
      FILE,
      "/publicRead",
    ],
    [
      "declared predefinedItems",
      base({
        [FILE]: languages({
          predefinedItems: [
            { id: uuid(81), name: "Main", physicalName: "main" },
          ],
        }),
      }),
      "languages.predefined-items",
      FILE,
      "/predefinedItems",
    ],
    [
      "no primaryDataLanguage in the project",
      base({ [PROJECT]: project() }),
      "languages.primary-missing",
      FILE,
      "/role",
    ],
    [
      "primaryDataLanguage without a catalog",
      { [PROJECT]: project({ primaryDataLanguage: "uk" }) },
      "languages.primary-without-catalog",
      PROJECT,
      "/primaryDataLanguage",
    ],
  ])("%s is an error", async (_title, entries, code, file, pointer) => {
    expect(await found(entries)).toEqual([[code, file, pointer, "error"]])
  })

  it("no languages catalog and no primaryDataLanguage give no language diagnostics", async () => {
    expect(await found({ [PROJECT]: project() })).toEqual([])
  })
})

describe("own attributes of the languages catalog and the seed (Р-B2-7)", () => {
  // Засів вставляє рядок основної мови лише з колонками ролі: власний
  // реквізит мусить прийняти рядок без свого значення, інакше apply зірветься.
  const own = (overrides: Record<string, unknown>) =>
    base({
      [FILE]: languages({
        attributes: [
          attribute("nativeName", { type: "String", length: 40, ...overrides }),
        ],
      }),
    })

  it("a required attribute without defaultValue breaks the seed", async () => {
    const { diagnostics } = await compile(metaFiles(own({ required: true })))
    expect(
      diagnostics.map((d) => [d.code, d.file, d.pointer, d.severity, d.params])
    ).toEqual([
      [
        "languages.seed-unsafe",
        FILE,
        "/attributes/0",
        "error",
        {
          name: "Languages",
          element: "nativeName",
          reason: "requiredWithoutDefault",
        },
      ],
    ])
  })

  it("a required attribute with defaultValue compiles", async () => {
    const result = await compile(
      metaFiles(own({ required: true, defaultValue: "—" }))
    )
    expect(result.diagnostics).toEqual([])
  })
})

describe("beforeWrite handler and the languages role columns (Р-B2-12)", () => {
  const handler = (body: string) =>
    `CREATE FUNCTION app.guard() RETURNS trigger LANGUAGE plpgsql VOLATILE SET search_path = '' AS $$ BEGIN ${body} RETURN NEW; END $$;`
  const withHandler = (body: string, source = "Languages") =>
    base({
      "catalogs/Item/Item.meta.json": catalog("Item"),
      [SUBSCRIPTION]: {
        id: uuid(82),
        kind: "EventSubscription",
        name: "Guard",
        physicalName: "guard",
        sources: [{ kind: "Catalog", name: source }],
        event: "beforeWrite",
        handler: { schema: "app", name: "guard" },
      },
      [HANDLER_FILE]: handler(body),
    })
  const problems = async (entries: Record<string, unknown>) =>
    (await compile(metaFiles(entries))).diagnostics
      .filter((d) => d.code === "subscription.handler-assigns-mechanics")
      .map((d) => [d.file, d.pointer, d.params?.problem])

  it.each([
    ["NEW.state := 'published';", "new.state"],
    ["NEW.is_primary := true;", "new.is_primary"],
    ["NEW.code := 'xx';", "new.code"],
    ["NEW.deletion_mark := true;", "new.deletion_mark"],
  ])("%s is refused", async (body, problem) => {
    expect(await problems(withHandler(body))).toEqual([
      [SUBSCRIPTION, "/handler", problem],
    ])
  })

  it("a handler on the role that assigns another column compiles", async () => {
    expect(await problems(withHandler("NEW.description := 'x';"))).toEqual([])
  })

  it("a plain catalog may have a column named like the role's", async () => {
    expect(await problems(withHandler("NEW.state := 'x';", "Item"))).toEqual([])
  })
})
