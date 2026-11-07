import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { ESLint } from "eslint"
import { beforeAll, describe, expect, it } from "vitest"

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..")
const eslint = new ESLint({ cwd: PKG })

// Перший lintText вантажить конфіг пакета з typescript-eslint і пакетом
// `typescript` — разова ціна процесу (0,6 с у спокої, до 4,7 с під повним
// `pnpm test`), а не перевірки межі. Тайм-аут тесту має міряти тест,
// тому холодний старт винесено в хук зі своїм запасом.
beforeAll(async () => {
  await eslint.lintText("", {
    filePath: join(PKG, "src/model/index.ts"),
    warnIgnored: true,
  })
}, 60_000)
// Таблицю ярусів тест тримає сам, а не імпортує з конфігу: інакше ярус,
// що випав із конфігу, випав би й з тесту.
const TIERS = ["model", "compiler", "schema", "server", "data", "ui", "shell"]

async function restricted(code: string, file: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, {
    filePath: join(PKG, file),
    warnIgnored: true,
  })
  return (result?.messages ?? [])
    .filter((m) => m.ruleId === "no-restricted-imports")
    .map((m) => m.message)
}
async function purity(code: string, file: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, {
    filePath: join(PKG, file),
    warnIgnored: true,
  })
  return (result?.messages ?? [])
    .filter((m) => m.ruleId === "@typescript-eslint/no-restricted-imports")
    .map((m) => m.message)
}
async function props(code: string, file: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, {
    filePath: join(PKG, file),
    warnIgnored: true,
  })
  return (result?.messages ?? [])
    .filter((m) => m.ruleId === "no-restricted-properties")
    .map((m) => m.message)
}
async function ruleIds(code: string, file: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, {
    filePath: join(PKG, file),
    warnIgnored: true,
  })
  return (result?.messages ?? []).flatMap((m) => (m.ruleId ? [m.ruleId] : []))
}
const importOf = (s: string) =>
  `import { probe } from "${s}"\nexport const used = probe\n`

describe("tier zones", () => {
  it("rejects every higher tier, bare form", async () => {
    for (let i = 0; i < TIERS.length; i++) {
      for (let j = i + 1; j < TIERS.length; j++) {
        const msgs = await restricted(
          importOf(`simetra/${TIERS[j]}`),
          `src/${TIERS[i]}/__fixture.ts`
        )
        expect(msgs, `${TIERS[i]} -> simetra/${TIERS[j]}`).toHaveLength(1)
        expect(msgs[0]).toContain("Tier zone")
      }
    }
  })

  it("rejects every higher tier, relative forms", async () => {
    for (let i = 0; i < TIERS.length; i++) {
      for (let j = i + 1; j < TIERS.length; j++) {
        const tier = TIERS[i]
        const up = TIERS[j]
        const cases: [string, string][] = [
          [`../${up}`, `src/${tier}/__fixture.ts`],
          [`../${up}/x`, `src/${tier}/__fixture.ts`],
          [`../../../${up}`, `src/${tier}/a/b/__fixture.ts`],
          [`../../../../src/${up}`, `src/${tier}/a/b/__fixture.ts`],
          [`./../${up}`, `src/${tier}/__fixture.ts`],
        ]
        for (const [spec, file] of cases) {
          const msgs = await restricted(importOf(spec), file)
          expect(msgs, `${file}: ${spec}`).toHaveLength(1)
          expect(msgs[0]).toContain("Tier zone")
        }
      }
    }
  })

  it("allows lower tiers and own tier", async () => {
    for (let i = 0; i < TIERS.length; i++) {
      for (let j = 0; j < i; j++) {
        const file = `src/${TIERS[i]}/__fixture.ts`
        // data і ui не імпортують server попри нижчий ярус (A3-10)
        if (TIERS[j] === "server" && (TIERS[i] === "data" || TIERS[i] === "ui"))
          continue
        expect(
          await restricted(importOf(`simetra/${TIERS[j]}`), file),
          `${TIERS[i]} -> simetra/${TIERS[j]}`
        ).toEqual([])
        expect(
          await restricted(importOf(`../${TIERS[j]}/x`), file),
          `${TIERS[i]} -> ../${TIERS[j]}/x`
        ).toEqual([])
      }
    }
    // Реальна тека T0 `schemas` не збігається з ярусом `schema`.
    expect(
      await restricted(
        importOf("../schemas/catalog"),
        "src/model/a/__fixture.ts"
      ),
      "model/schemas is not tier schema"
    ).toEqual([])
    expect(
      await restricted(importOf("./local"), "src/model/__fixture.ts"),
      "own-folder import"
    ).toEqual([])
  })

  it("same imports outside tier folders are clean", async () => {
    expect(
      await restricted(importOf("simetra/shell"), "test/__fixture.ts"),
      "bare from test"
    ).toEqual([])
    expect(
      await restricted(importOf("../src/shell"), "test/__fixture.ts"),
      "relative from test"
    ).toEqual([])
  })

  it("type imports and re-exports are covered", async () => {
    const file = "src/model/__fixture.ts"
    const codes = [
      `import type { X } from "simetra/compiler"\nexport type Y = X\n`,
      `export { X } from "../compiler"\n`,
      `export * from "../compiler"\n`,
    ]
    for (const code of codes) {
      expect(await restricted(code, file), code).toHaveLength(1)
    }
  })

  it("tsx files are covered", async () => {
    expect(
      await restricted(importOf("simetra/shell"), "src/ui/__fixture.tsx"),
      "tsx in ui"
    ).toHaveLength(1)
  })

  it("ui rejects router, host framework and data-engine libraries", async () => {
    const file = "src/ui/__fixture.ts"
    for (const spec of [
      "@tanstack/react-router",
      "@tanstack/react-start/server",
      "@tanstack/react-db",
      "@tanstack/react-query",
      "next/link",
      "@supabase/supabase-js",
    ]) {
      const msgs = await restricted(importOf(spec), file)
      expect(msgs, spec).toHaveLength(1)
      expect(msgs[0]).toContain("Framework boundary")
    }
    for (const spec of [
      "react",
      "react-dom/client",
      "@tanstack/react-virtual",
      "next-themes",
    ]) {
      expect(await restricted(importOf(spec), file), spec).toEqual([])
    }
  })

  it("framework libraries are legal in shell", async () => {
    expect(
      await restricted(
        importOf("@tanstack/react-router"),
        "src/shell/__fixture.ts"
      )
    ).toEqual([])
  })

  // Межу data → server уже тримає `SERVER_MESSAGE`; кейс фіксує, що T4 бере
  // клас саме з T0 і що імпорт із server лишається відмовою після переїзду.
  it("data takes CommandFailure from model; from server it is refused", async () => {
    expect(
      await restricted(
        `import { CommandFailure } from "simetra/model"`,
        "src/data/__fixture.ts"
      )
    ).toEqual([])
    const refused = await restricted(
      `import { CommandFailure } from "simetra/server"`,
      "src/data/__fixture.ts"
    )
    expect(refused).toHaveLength(1)
  })

  it("server no longer exports CommandFailure; model does", async () => {
    expect("CommandFailure" in (await import("simetra/server"))).toBe(false)
    expect(typeof (await import("simetra/model")).CommandFailure).toBe(
      "function"
    )
    expect((await import("simetra/model")).ZERO_UUID).toBe(
      "00000000-0000-0000-0000-000000000000"
    )
  })

  it("no zone is ignored", async () => {
    for (const t of TIERS) {
      expect(
        await eslint.isPathIgnored(join(PKG, `src/${t}/__fixture.ts`)),
        t
      ).toBe(false)
    }
  })

  it("model imports only zod", async () => {
    const file = "src/model/__fixture.ts"
    for (const spec of ["zod", "zod/v4", "./local", "../model/x"]) {
      expect(await purity(importOf(spec), file), spec).toEqual([])
    }
    for (const spec of [
      "react",
      "node:fs",
      "fs",
      "@supabase/supabase-js",
      "jsonc-parser",
    ]) {
      const msgs = await purity(importOf(spec), file)
      expect(msgs, spec).toHaveLength(1)
      expect(msgs[0]).toContain("T0 purity")
    }
  })

  it("model tests may use node", async () => {
    expect(
      await purity(importOf("node:fs"), "src/model/__tests__/__fixture.ts")
    ).toEqual([])
  })

  it("compiler uses no node api", async () => {
    const file = "src/compiler/__fixture.ts"
    for (const spec of ["node:fs", "node:path", "fs", "path", "node:crypto"]) {
      const msgs = await purity(importOf(spec), file)
      expect(msgs, spec).toHaveLength(1)
      expect(msgs[0]).toContain("T1 purity")
    }
    expect(await purity(importOf("zod"), file)).toEqual([])
    expect(
      await purity(importOf("node:fs"), "src/compiler/__tests__/__fixture.ts")
    ).toEqual([])
  })

  it("production sources import neither pg nor pg-delta", async () => {
    // Рушій схеми й читачі бази живуть у @simetrajs/designer (рішення Д5):
    // рантайм-пакет не тягне драйвер бази й двигун навіть типами
    for (const code of [
      'import pg from "pg"\nexport const used = pg\n',
      'import type pg from "pg"\nexport type Used = pg.Pool\n',
      'import pool from "pg/lib/pool"\nexport const used = pool\n',
      'import { parseId } from "@supabase/pg-delta"\nexport const used = parseId\n',
      'import { resolveView } from "@supabase/pg-delta/policy"\nexport const used = resolveView\n',
    ])
      for (const file of [
        "src/schema/engine/x.ts",
        "src/server/x.ts",
        "src/model/x.ts",
        "src/compiler/x.ts",
      ])
        expect(await ruleIds(code, file), `${file}: ${code}`).toContain(
          "@typescript-eslint/no-restricted-imports"
        )
    expect(
      await ruleIds(
        'import pg from "pg"\nexport const used = pg\n',
        "src/schema/__tests__/x.db.test.ts"
      )
    ).toEqual([])
    expect(
      await ruleIds(importOf("pg-query-emscripten"), "src/schema/engine/x.ts")
    ).toEqual([])
  })

  it("data and ui do not import server", async () => {
    for (const tier of ["data", "ui"])
      for (const spec of ["simetra/server", "../server/x", "../server"]) {
        const msgs = await restricted(
          importOf(spec),
          `src/${tier}/__fixture.ts`
        )
        expect(msgs, `${tier}: ${spec}`).toHaveLength(1)
        expect(msgs[0]).toContain("must not import simetra/server")
      }
  })

  it("server imports only local files, model, zod and async_hooks", async () => {
    const file = "src/server/__fixture.ts"
    for (const spec of [
      "simetra/compiler",
      "simetra/schema",
      "../compiler/x",
      "../schema/x",
      "../model/x",
      // `./` з виходом угору — той самий вихід з теки, що й `../model`:
      // вбудував би другу копію T0 у `dist/server`.
      "./../model/x",
      "./a/../../model/x",
      "./a/../b",
      "node:fs",
      "pg",
    ]) {
      const msgs = await ruleIds(importOf(spec), file)
      expect(msgs, spec).toContain("@typescript-eslint/no-restricted-imports")
    }
    for (const spec of [
      "./x",
      "./a/b",
      "./x.js",
      "node:async_hooks",
      "zod",
      "simetra/model",
    ]) {
      expect(await purity(importOf(spec), file), spec).toEqual([])
    }
    expect(
      await purity(importOf("node:fs"), "src/server/__tests__/__fixture.ts")
    ).toEqual([])
  })

  // Ненормалізований шлях (`..` після звичайного сегмента) обходив ярусний
  // regex, що бачить лише `..` на початку.
  it.each([
    ["src/data/__fixture.ts", "./a/../../server/x"],
    ["src/compiler/__fixture.ts", "./a/../../server/x"],
    ["src/model/runtime/__fixture.ts", "./x/../../../compiler/x"],
    ["src/shell/__fixture.ts", "./a/../b"],
  ])("%s: non-normalized %s is refused", async (file, spec) => {
    const msgs = await restricted(importOf(spec), file)
    expect(msgs, spec).toHaveLength(1)
    expect(msgs[0]).toContain("normalized relative path")
  })

  // `.` і порожні сегменти обходили регекс, що бачить лише початковий `../`.
  it.each([
    ["src/data/__fixture.ts", ".././model"],
    ["src/data/__fixture.ts", "././../model"],
    ["src/data/__fixture.ts", "..//model"],
    ["src/data/__fixture.ts", "../../src/./model"],
    ["src/data/__fixture.ts", "./.././model"],
    ["src/ui/__fixture.ts", ".././data/x"],
  ])("%s: dot or empty segment %s is refused", async (file, spec) => {
    const msgs = await restricted(importOf(spec), file)
    expect(msgs, spec).toHaveLength(1)
    expect(msgs[0]).toContain("normalized relative path")
  })

  it.each([
    ["src/data/facade/__fixture.ts", "./../supabase/x"],
    ["src/data/__fixture.ts", "../data/supabase/x"],
    ["src/data/facade/__fixture.ts", "../../data/supabase/x"],
    ["src/data/__fixture.ts", "../../src/data/supabase/x"],
  ])("%s: supabase detour %s is refused", async (file, spec) => {
    const msgs = await purity(importOf(spec), file)
    expect(msgs, spec).toHaveLength(1)
  })

  it("plain ./x and ../x stay allowed in the facade", async () => {
    for (const spec of ["./x", "../x"]) {
      expect(
        await restricted(importOf(spec), "src/data/facade/__fixture.ts"),
        spec
      ).toEqual([])
      expect(
        await purity(importOf(spec), "src/data/facade/__fixture.ts"),
        spec
      ).toEqual([])
    }
  })

  it("namespace import of @tanstack/db is refused outside the facade", async () => {
    const code = `import * as db from "@tanstack/db"\nexport const used = db\n`
    expect(await restricted(code, "src/data/__fixture.ts")).toHaveLength(1)
    expect(await restricted(code, "src/data/facade/__fixture.ts")).toEqual([])
  })

  it("normalized relative paths within the allowed tiers pass", async () => {
    for (const [file, spec] of [
      ["src/data/__fixture.ts", "./x"],
      ["src/data/facade/__fixture.ts", "../x"],
      ["src/server/__fixture.ts", "../model/x"],
      ["src/shell/__fixture.ts", "../ui/x"],
    ]) {
      expect(await restricted(importOf(spec), file), spec).toEqual([])
    }
  })

  // Блок чистоти T4 (спека П4-B §3): ярусне правило й allow-list чистоти
  // разом; кожен блок несе повний перелік, бо опції flat config заміщуються.
  describe("T4 data zone", () => {
    const refusedBoth = async (spec: string, file: string) => [
      ...(await restricted(importOf(spec), file)),
      ...(await purity(importOf(spec), file)),
    ]
    const OUTSIDE = [
      "src/data/__fixture.ts",
      "src/data/nested/__fixture.ts",
      "src/data/__tests__/__fixture.ts",
    ]
    const ALLOWED = [
      "simetra/model",
      "zod",
      "react",
      "@tanstack/db",
      "@tanstack/react-db",
      "./x",
    ]

    it.each(OUTSIDE.flatMap((f) => ALLOWED.map((s) => [f, s])))(
      "%s allows %s",
      async (file, spec) => {
        expect(await refusedBoth(spec, file)).toEqual([])
      }
    )

    it.each([
      ["src/data/__fixture.ts", "simetra/server"],
      ["src/data/__fixture.ts", "simetra/compiler"],
      ["src/data/__fixture.ts", "simetra/schema"],
      ["src/data/__fixture.ts", "pg"],
      ["src/data/__fixture.ts", "../model"],
      ["src/data/__fixture.ts", "./../model"],
      ["src/data/nested/__fixture.ts", "../../model"],
      ["src/data/__fixture.ts", "./supabase/x"],
      ["src/data/facade/__fixture.ts", "../supabase/x"],
      ["src/data/__fixture.ts", "@supabase/realtime-js"],
      ["src/data/__fixture.ts", "@tanstack/query-db-collection"],
      ["src/data/__fixture.ts", "@tanstack/query-core"],
      ["src/data/nested/__fixture.ts", "@tanstack/query-core"],
      ["src/data/facade/__fixture.ts", "simetra/server"],
      ["src/data/facade/__fixture.ts", "../../model"],
      ["src/data/facade/__fixture.ts", "pg"],
      ["src/data/facade/__fixture.ts", "@supabase/realtime-js"],
      // ярусне правило діє й на тести: фасад не обходять з __tests__
      ["src/data/__tests__/__fixture.ts", "@tanstack/query-core"],
      ["src/data/__tests__/__fixture.ts", "@tanstack/query-db-collection"],
    ])("%s refuses %s", async (file, spec) => {
      expect(await refusedBoth(spec, file)).not.toEqual([])
    })

    it("facade allows query-core, query-db-collection and ../x", async () => {
      const file = "src/data/facade/__fixture.ts"
      for (const spec of [
        "@tanstack/query-core",
        "@tanstack/query-db-collection",
        "@tanstack/db",
        "../x",
        "./y",
      ])
        expect(await refusedBoth(spec, file), spec).toEqual([])
      expect(await refusedBoth("../x", "src/data/nested/__fixture.ts")).toEqual(
        []
      )
    })

    it("createTransaction and createOptimisticAction live in the facade", async () => {
      for (const name of ["createTransaction", "createOptimisticAction"]) {
        const code = `import { ${name} } from "@tanstack/db"\nexport const used = ${name}\n`
        for (const file of OUTSIDE)
          expect(await restricted(code, file), `${file}: ${name}`).toHaveLength(
            1
          )
        expect(
          await restricted(code, "src/data/facade/__fixture.ts"),
          `facade: ${name}`
        ).toEqual([])
      }
      // інші іменовані імпорти @tanstack/db дозволено всюди в T4
      expect(
        await restricted(
          `import { createCollection } from "@tanstack/db"\nexport const used = createCollection\n`,
          "src/data/__fixture.ts"
        )
      ).toEqual([])
    })

    it("utils.write* and refetch are refused outside the facade", async () => {
      for (const name of [
        "writeInsert",
        "writeUpdate",
        "writeDelete",
        "writeUpsert",
        "writeBatch",
        "refetch",
      ]) {
        const forms = [
          `export const r = c.utils.${name}(1)\n`,
          `export const r = c.utils["${name}"](1)\n`,
          `const { ${name} } = c.utils\nexport const r = ${name}\n`,
        ]
        for (const code of forms)
          for (const file of OUTSIDE)
            expect(await props(code, file), `${file}: ${code}`).toHaveLength(1)
        for (const code of forms)
          expect(
            await props(code, "src/data/facade/__fixture.ts"),
            `facade: ${code}`
          ).toEqual([])
      }
      expect(
        await props(
          "export const r = c.utils.other(1)\n",
          "src/data/__fixture.ts"
        )
      ).toEqual([])
    })

    it("a QueryClient cannot be built outside the facade: its import is refused", async () => {
      const code = `import { QueryClient } from "@tanstack/query-core"\nexport const q = new QueryClient()\n`
      expect(await restricted(code, "src/data/__fixture.ts")).toHaveLength(1)
      expect(await restricted(code, "src/data/facade/__fixture.ts")).toEqual([])
    })

    it("standard-columns rules still apply in src/data", async () => {
      const code = `export const r = (o: { standard: string }) => o.standard === "x"\n`
      expect(await ruleIds(code, "src/data/__fixture.ts")).toContain(
        "no-restricted-syntax"
      )
      expect(await ruleIds(code, "src/data/facade/__fixture.ts")).toContain(
        "no-restricted-syntax"
      )
    })
  })

  it("ui does not import simetra/data/supabase or relative data", async () => {
    for (const spec of [
      "simetra/data/supabase",
      "../data/supabase",
      "./../data/x",
      "../data",
      "../data/x",
      "../../data/x",
    ]) {
      const msgs = await purity(importOf(spec), "src/ui/__fixture.ts")
      expect(msgs, spec).toHaveLength(1)
    }
    expect(
      await purity(importOf("simetra/data"), "src/ui/__fixture.ts")
    ).toEqual([])
    expect(await purity(importOf("../x"), "src/ui/__fixture.ts")).toEqual([])
  })

  it("mts and cts are covered", async () => {
    for (const ext of ["mts", "cts"]) {
      const msgs = await restricted(
        importOf("simetra/compiler"),
        `src/model/__fixture.${ext}`
      )
      expect(msgs, ext).toHaveLength(1)
    }
  })
})
