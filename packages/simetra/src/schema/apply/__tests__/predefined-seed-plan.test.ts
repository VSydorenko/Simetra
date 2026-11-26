import { describe, expect, it } from "vitest"
import {
  canonicalSnapshot,
  canonicalize,
  compile,
  sha256Hex,
  type CompiledModel,
  type PredefinedSeedContract,
} from "simetra/compiler"
import {
  predefinedSeedSql,
  predefinedSeedSteps,
  readSeedTargetRows,
  seedVerdict,
  type ApplyTransaction,
  type SeedTargetRows,
} from "simetra/schema"
import {
  catalog,
  languagesCatalog,
  metaFiles,
  project,
  uuid,
} from "../../../compiler/__tests__/helpers"

/**
 * Засів основної мови (Р-B2-7) і звірка цілі перед ним (Р-B2-8): факт T1, з
 * якого apply будує крок, вердикт над рядками цілі й крок плану.
 */

const LANGUAGES = "catalogs/Languages/Languages.meta.json"
const TABLE = { schema: "public", name: "languages" }

async function compiled(
  primaryDataLanguage: string | undefined,
  extra: Record<string, unknown> = {}
): Promise<CompiledModel> {
  const result = await compile(
    metaFiles({
      "project.meta.json": project(
        primaryDataLanguage === undefined ? {} : { primaryDataLanguage }
      ),
      ...(primaryDataLanguage === undefined
        ? {}
        : { [LANGUAGES]: languagesCatalog({ id: uuid(80) }) }),
      ...extra,
    })
  )
  const errors = result.diagnostics.filter((d) => d.severity === "error")
  expect(errors).toEqual([])
  return result.model!
}

const seedOf = async (code = "uk"): Promise<PredefinedSeedContract> => {
  const [seed] = (await compiled(code)).contracts.predefinedSeeds
  if (seed === undefined) throw new Error("no seed contract")
  return seed
}

/** Рядок цілі в іменах контракту; `::text` дає `true`/`false` для boolean. */
const row = (o: {
  label?: string | null
  primary?: boolean
  code?: string
  state?: string
}) => ({
  predefined_name: o.label ?? null,
  is_primary: String(o.primary ?? false),
  code: o.code ?? "en",
  state: o.state ?? "draft",
})

const SEEDED = row({
  label: "primary_language",
  primary: true,
  code: "uk",
  state: "published",
})

describe("predefined seed contract (Р-B2-7)", () => {
  it("derives the primary language row from the role facts and primaryDataLanguage", async () => {
    expect(await seedOf()).toEqual({
      objectId: uuid(80),
      table: TABLE,
      label: {
        column: "predefined_name",
        value: "primary_language",
        where: "predefined_name IS NOT NULL",
      },
      keyColumn: "id",
      values: [
        { column: "code", value: "uk" },
        { column: "description", value: "uk" },
        { column: "state", value: "published" },
        { column: "is_primary", value: true },
      ],
      unique: ["is_primary", "code"],
      fixed: ["state"],
      subject: "uk",
    })
  })

  it("has no seed without a languages catalog", async () => {
    const model = await compiled(undefined, {
      "catalogs/Items/Items.meta.json": catalog("Items"),
    })
    expect(model.contracts.predefinedSeeds).toEqual([])
  })

  // Хеш моделі покриває проєкт цілком, тож зміна поля проєкту змінює його й
  // без контракту; другий тест — що контракт сам входить у хеш
  it("changes the model hash when primaryDataLanguage changes", async () => {
    expect((await compiled("uk")).hash).not.toBe((await compiled("en")).hash)
  })

  it("covers the seed contract with the model hash", async () => {
    const { hash, ...model } = await compiled("uk")
    const hashOf = (m: typeof model) =>
      sha256Hex(canonicalize(canonicalSnapshot(m)))
    expect(await hashOf(model)).toBe(hash)
    const seed = model.contracts.predefinedSeeds[0]!
    const changed = {
      ...model,
      contracts: {
        ...model.contracts,
        predefinedSeeds: [{ ...seed, subject: "en" }],
      },
    }
    expect(await hashOf(changed)).not.toBe(hash)
  })
})

describe("seed verdict (Р-B2-8)", () => {
  it.each<[string, SeedTargetRows]>([
    ["no table or columns of the role on the target", "absent"],
    ["no labelled, primary or same-code row", []],
  ])("seeds when there is %s", async (_, rows) => {
    expect(seedVerdict(await seedOf(), rows)).toEqual({ status: "seed" })
  })

  it("does not seed again over the seeded row", async () => {
    expect(seedVerdict(await seedOf(), [SEEDED])).toEqual({
      status: "seeded",
    })
  })

  it.each<[string, SeedTargetRows]>([
    ["the labelled primary has another code", [{ ...SEEDED, code: "en" }]],
    ["the labelled row is not primary", [{ ...SEEDED, is_primary: "false" }]],
    [
      "the labelled primary is not published",
      [{ ...SEEDED, state: "disabled" }],
    ],
    [
      "the primary has no label",
      [row({ primary: true, code: "en", state: "published" })],
    ],
    [
      "an unlabelled row holds the primary code",
      [row({ code: "uk", state: "draft" })],
    ],
    [
      "the seeded row stands next to an unlabelled row with a seed key",
      [SEEDED, row({ code: "uk" })],
    ],
  ])("refuses when %s", async (_, rows) => {
    expect(seedVerdict(await seedOf(), rows)).toEqual({
      status: "refused",
      diagnostic: expect.objectContaining({
        code: "apply.primary-language-changed",
        severity: "error",
        params: { table: "public.languages", language: "uk" },
      }),
    })
  })
})

describe("reading the target for the seed (Р-B2-8)", () => {
  const tx = (rows: Record<string, string | null>[] = []) => {
    const queries: { sql: string; params: readonly unknown[] }[] = []
    const fake: ApplyTransaction = {
      query: async <R extends Record<string, unknown>>(
        sql: string,
        params: readonly unknown[] = []
      ) => {
        queries.push({ sql, params })
        return rows as unknown as R[]
      },
      extract: () => {
        throw new Error("no extract")
      },
    }
    return { fake, queries }
  }
  const live = (columns: readonly string[]) => ({
    tables: [
      {
        schema: "public",
        name: "languages",
        columns: columns.map((name) => ({ name })),
      },
    ],
  })
  const ALL = ["id", "code", "predefined_name", "state", "is_primary"]

  it("reads nothing and reports absent without the table", async () => {
    const { fake, queries } = tx()
    expect(
      await readSeedTargetRows(fake, [await seedOf()], { tables: [] })
    ).toEqual(["absent"])
    expect(queries).toEqual([])
  })

  // Роль додано на наявний довідник: мітка й код уже є, колонок ролі ще
  // немає. Рядки читаються за наявними колонками, відсутні — `NULL`
  const ROLE_ADDED = live(["id", "code", "predefined_name"])

  it("reads the label and the code where the role columns are not there yet", async () => {
    const { fake, queries } = tx()
    expect(
      await readSeedTargetRows(
        fake,
        [await seedOf()],
        ROLE_ADDED as Parameters<typeof readSeedTargetRows>[2]
      )
    ).toEqual([[]])
    expect(queries).toEqual([
      {
        sql: "SELECT predefined_name::text AS predefined_name, NULL::text AS is_primary, code::text AS code, NULL::text AS state FROM public.languages WHERE predefined_name::text = $1 OR code::text = $2",
        params: ["primary_language", "uk"],
      },
    ])
  })

  it.each<[string, Record<string, string | null>[], string]>([
    ["no row matches", [], "seed"],
    [
      "a row already holds the label",
      [
        {
          predefined_name: "primary_language",
          is_primary: null,
          code: "en",
          state: null,
        },
      ],
      "refused",
    ],
    [
      "a row already holds the label and the primary code",
      [
        {
          predefined_name: "primary_language",
          is_primary: null,
          code: "uk",
          state: null,
        },
      ],
      "refused",
    ],
    [
      "an unlabelled row holds the primary code",
      [{ predefined_name: null, is_primary: null, code: "uk", state: null }],
      "refused",
    ],
  ])("without the role columns: %s → %s", async (_, rows, status) => {
    const seed = await seedOf()
    const [read] = await readSeedTargetRows(
      tx(rows).fake,
      [seed],
      ROLE_ADDED as Parameters<typeof readSeedTargetRows>[2]
    )
    expect(seedVerdict(seed, read!).status).toBe(status)
  })

  it("reads the rows with the label or a seed key value", async () => {
    const { fake, queries } = tx([SEEDED])
    expect(
      await readSeedTargetRows(
        fake,
        [await seedOf()],
        live(ALL) as Parameters<typeof readSeedTargetRows>[2]
      )
    ).toEqual([[SEEDED]])
    expect(queries).toEqual([
      {
        sql: "SELECT predefined_name::text AS predefined_name, is_primary::text AS is_primary, code::text AS code, state::text AS state FROM public.languages WHERE predefined_name::text = $1 OR is_primary::text = $2 OR code::text = $3",
        params: ["primary_language", "true", "uk"],
      },
    ])
  })

  it("reads the target in its own names", async () => {
    const { fake, queries } = tx()
    await readSeedTargetRows(
      fake,
      [await seedOf()],
      {
        tables: [
          {
            schema: "public",
            name: "old_languages",
            columns: ["old_code", "predefined_name", "state", "is_primary"].map(
              (name) => ({ name })
            ),
          },
        ],
      } as Parameters<typeof readSeedTargetRows>[2],
      {
        table: (t) =>
          t.name === "languages" ? { ...t, name: "old_languages" } : t,
        column: (_t, c) => (c === "code" ? "old_code" : c),
      }
    )
    expect(queries[0]?.sql).toBe(
      "SELECT predefined_name::text AS predefined_name, is_primary::text AS is_primary, old_code::text AS code, state::text AS state FROM public.old_languages WHERE predefined_name::text = $1 OR is_primary::text = $2 OR old_code::text = $3"
    )
  })
})

describe("seed step (Р-B2-7)", () => {
  it("inserts the row once, with the label as the conflict arbiter", async () => {
    expect(predefinedSeedSql(await seedOf())).toBe(
      "INSERT INTO public.languages (id, code, description, state, is_primary, predefined_name) VALUES (pg_catalog.gen_random_uuid(), 'uk', 'uk', 'published', true, 'primary_language') ON CONFLICT (predefined_name) WHERE predefined_name IS NOT NULL DO NOTHING"
    )
  })

  it("plans a data step only where nothing is seeded yet", async () => {
    const seed = await seedOf()
    const steps = predefinedSeedSteps(
      [
        { seed, verdict: { status: "seeded" } },
        { seed, verdict: { status: "seed" } },
      ],
      4
    )
    expect(steps).toEqual([
      expect.objectContaining({
        id: "s5",
        origin: "seeds",
        sql: predefinedSeedSql(seed),
        class: "dataStep",
        lockClass: "shareRowExclusive",
        transactionality: "transactional",
        lockedTables: [TABLE],
        dataLoss: false,
        guards: [],
      }),
    ])
  })

  it("plans no step on a seeded target", async () => {
    const seed = await seedOf()
    expect(
      predefinedSeedSteps([{ seed, verdict: seedVerdict(seed, [SEEDED]) }], 0)
    ).toEqual([])
  })
})
