import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const COMPILER_DIR = join(__dirname, "..")

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory())
      return name === "__tests__" ? [] : sources(path)
    return path.endsWith(".ts") ? [path] : []
  })
}

/** Коментарі можуть називати коди; літерали в коді — ні. */
const stripComments = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")

describe("core error codes in the compiler", () => {
  it("takes every core error code from simetra/model, not from a literal", () => {
    const offenders = sources(COMPILER_DIR).filter((path) => {
      const code = stripComments(readFileSync(path, "utf8"))
      return (
        /["'`]command\.[a-z-]+["'`]/.test(code) ||
        /hierarchy\.isolation/.test(code)
      )
    })
    expect(offenders).toEqual([])
  })

  // Причину відмови T3 пропускає назовні лише з переліку T0 (Р-A3-8): літерал
  // у генераторі розійшовся б із ним мовчки. Ловимо форми, якими генератори
  // кидають відмову; голе слово (`"effect"`) шукати не можна — хибні збіги.
  it("takes every refusal reason from simetra/model, not from a literal", () => {
    const offenders = sources(COMPILER_DIR).filter((path) => {
      const code = stripComments(readFileSync(path, "utf8"))
      return (
        /\b(?:refusal|forbidden|conflict)\(\s*["'`]/.test(code) ||
        /DETAIL = '[a-z]/.test(code)
      )
    })
    expect(offenders).toEqual([])
  })
})
