import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { ESLint } from "eslint"
import { describe, expect, it } from "vitest"

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..")
const eslint = new ESLint({ cwd: PKG })
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
