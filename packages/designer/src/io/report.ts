import type { Diagnostic, Locale } from "simetra/compiler"
import { localize } from "simetra/compiler"

export interface ReportOptions {
  dir: string
  locale: Locale
  format: "text" | "json"
}

/** Діагностика з текстом потрібною мовою; саме її віддають обидва формати. */
function localized(d: Diagnostic, locale: Locale): Diagnostic {
  const { message, hint } = localize(d, locale)
  // Англійську підказку самої діагностики замінює локалізована.
  const rest = { ...d }
  delete rest.hint
  return { ...rest, message, ...(hint === undefined ? {} : { hint }) }
}

export function formatDiagnostics(
  diagnostics: readonly Diagnostic[],
  { dir, locale, format }: ReportOptions
): string {
  const items = diagnostics.map((d) => localized(d, locale))
  if (format === "json") {
    return JSON.stringify(
      items.map((d) => ({ ...d, dir })),
      null,
      2
    )
  }
  const lines: string[] = []
  for (const d of items) {
    lines.push(`${placeOf(d, dir)} ${d.severity} ${d.code} ${d.message}`)
    if (d.hint !== undefined) lines.push(`  hint: ${d.hint}`)
  }
  const errors = items.filter((d) => d.severity === "error").length
  lines.push(`${errors} error(s), ${items.length - errors} warning(s)`)
  return lines.join("\n")
}

/**
 * Місце діагностики в тексті. Позиція друкується лише тоді, коли вона є:
 * діагностика без файлу (вхід операції загалом) чи файлу, якого немає в
 * теці, отримала б фальшиве `:1:1`, а читач шукав би там неіснуючу причину.
 */
function placeOf(d: Diagnostic, dir: string): string {
  if (d.file === "") return `${dir}:`
  if (d.range === undefined) return `${dir}/${d.file}:`
  // Позиції LSP 0-базні, а редактори й термінали чекають 1-базні.
  const { line, character } = d.range.start
  return `${dir}/${d.file}:${line + 1}:${character + 1}`
}
