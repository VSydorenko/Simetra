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
    filePath: join(PKG, "src/main.ts"),
    warnIgnored: true,
  })
}, 60_000)

/** Порушення меж імпорту: лише правила зон, щоб сторонні правила не маскували результат. */
async function restricted(code: string, file: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, {
    filePath: join(PKG, file),
    warnIgnored: true,
  })
  return (result?.messages ?? [])
    .filter((m) => m.ruleId?.endsWith("no-restricted-imports"))
    .map((m) => m.message)
}
const importOf = (s: string) =>
  `import { FIXTURES } from "${s}"\nexport const used = FIXTURES\n`

describe("simetra test support boundary", () => {
  it("only tests import simetra test support", async () => {
    for (const [spec, file] of [
      ["../../../simetra/test/support", "src/schema-engine/x.ts"],
      ["../../simetra/test/support.ts", "src/x.ts"],
      ["../../../../simetra/test/support", "src/cli/a/x.ts"],
    ] as const) {
      const msgs = await restricted(importOf(spec), file)
      expect(msgs, `${file}: ${spec}`).toHaveLength(1)
      expect(msgs[0]).toContain("simetra test support")
    }
    expect(
      await restricted(
        importOf("../../../../simetra/test/support"),
        "src/schema-engine/__tests__/x.test.ts"
      )
    ).toEqual([])
  })
})
