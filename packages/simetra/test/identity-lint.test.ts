import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { ESLint } from "eslint"
import { SQL_UNIT_CLASSES } from "simetra/model"
import { beforeAll, describe, expect, it } from "vitest"

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..")
// Конфіг — JS без декларацій типів: читаємо перелік класів динамічно.
const { IDENTITY_CLASSES } = (await import(
  join(PKG, "eslint.identity.js")
)) as { IDENTITY_CLASSES: string[] }
const simetra = new ESLint({ cwd: PKG })

beforeAll(async () => {
  await simetra.lintText("", {
    filePath: join(PKG, "src/schema/__fixture.ts"),
    warnIgnored: true,
  })
}, 60_000)

// Фатальна помилка парсингу не має мовчки давати «нуль порушень».
async function syntax(eslint: ESLint, code: string, file: string) {
  const [result] = await eslint.lintText(code, {
    filePath: file,
    warnIgnored: true,
  })
  const messages = result?.messages ?? []
  const broken = messages.filter((m) => m.fatal || m.ruleId === null)
  if (broken.length > 0)
    throw new Error(
      `lint did not run: ${broken.map((m) => m.message).join("; ")}`
    )
  return messages.filter((m) => m.ruleId === "no-restricted-syntax")
}
const inSimetra = (code: string, file = "src/schema/__fixture.ts") =>
  syntax(simetra, code, join(PKG, file))

const TEMPLATE = "export const id = (t: string) => `trigger:${t}`\n"
const CONCAT = `export const id = (t: string) => "view:" + t\n`
const STANDARD = `export const r = (o: { standard: string }) => o.standard === "x"\n`

describe("unit identity assembled only in compiler/sql/identity.ts (#297, R4)", () => {
  it("covers every SQL unit class the model declares", () => {
    for (const cls of SQL_UNIT_CLASSES) expect(IDENTITY_CLASSES).toContain(cls)
  })

  it("rejects a template identity in production src", async () => {
    const msgs = await inSimetra(TEMPLATE)
    expect(msgs).toHaveLength(1)
    expect(msgs[0]!.message).toMatch(/identity\.ts/)
  })

  it("rejects a concatenated identity", async () => {
    expect(await inSimetra(CONCAT)).toHaveLength(1)
  })

  it("rejects every identity class prefix", async () => {
    for (const cls of IDENTITY_CLASSES)
      expect(
        await inSimetra(`export const id = (t: string) => \`${cls}:\${t}\`\n`)
      ).toHaveLength(1)
  })

  it("rejects it in T5 too (own option arrays)", async () => {
    expect(await inSimetra(TEMPLATE, "src/ui/__fixture.ts")).toHaveLength(1)
  })

  it("allows identity.ts, tests and support files", async () => {
    expect(await inSimetra(TEMPLATE, "src/compiler/sql/identity.ts")).toEqual(
      []
    )
    expect(await inSimetra(TEMPLATE, "src/schema/__tests__/x.ts")).toEqual([])
    expect(await inSimetra(TEMPLATE, "src/schema/x.support.ts")).toEqual([])
  })

  it("allows an engine id with a disable comment and text that only looks alike", async () => {
    const code =
      "// eslint-disable-next-line no-restricted-syntax -- engine StableId\n" +
      "export const a = (t: string) => `trigger:${t}`\n" +
      'export const b = "table: not found"\n' +
      "export const c = (t: string) => `schema:${t}`\n"
    expect(await inSimetra(code)).toEqual([])
  })

  it("keeps the standard-column selectors on the same glob", async () => {
    expect(await inSimetra(STANDARD)).toHaveLength(1)
    expect(await inSimetra(STANDARD + TEMPLATE)).toHaveLength(2)
    expect(await inSimetra(STANDARD, "src/ui/__fixture.ts")).toHaveLength(1)
  })
})
