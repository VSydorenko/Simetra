import type { Diagnostic, Locale } from "simetra/compiler"
import { localize } from "simetra/compiler"
import type { ApplyData, PlanData } from "../tools/apply-tools"
import type { DiffData } from "../tools/database-tools"

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

/** Зведення звірки: дії плану, відмінності каталогу, діагностика. */
export function renderDiff(d: DiffData, report: string): string {
  const lines: string[] = []
  if (d.plan.length > 0) {
    lines.push(`plan (${d.plan.length} action(s), database -> metadata):`)
    for (const a of d.plan) {
      const tags = [
        a.dataLoss ? "data loss" : undefined,
        a.rewriteRisk ? "rewrite" : undefined,
      ].filter((x) => x !== undefined)
      lines.push(
        `  ${a.sql.trim()}${tags.length > 0 ? ` -- ${tags.join(", ")}` : ""}`
      )
    }
  }
  if (d.differences.length > 0) {
    lines.push(`differences (${d.differences.length}):`)
    for (const x of d.differences)
      lines.push(`  ${x.kind} ${x.path}: ${x.detail}`)
  }
  // Без стану застосування `empty` судить лише про метадані: рядок пояснює,
  // чому перше застосування все одно щось створить
  if (d.applyState === "absent")
    lines.push(
      "apply state: absent from the database; the first apply creates it"
    )
  if (d.empty) lines.push("diff: the database matches the metadata")
  lines.push(report)
  return lines.join("\n")
}

const short = (hash: string | null): string =>
  hash === null ? "initial" : hash.slice(0, 12)

/**
 * Зведення плану для людини й агента: звідки й куди, `planHash` і файл,
 * дрейф — першим блоком, до кроків (рішення 16 плану П3-1): кроки читаються
 * вже знаючи, що ціль дрейфнула. Повний SQL — у файлі плану; тут перший рядок.
 */
export function renderPlan(
  d: PlanData | undefined,
  report: string,
  o: { ok: boolean; written: boolean; dry: boolean }
): string {
  if (d === undefined)
    return [
      o.ok
        ? "plan: nothing to apply; the database is at the metadata"
        : "plan: no plan written: the plan was refused or has errors",
      report,
    ].join("\n")
  const needs = new Set(d.requiredPermissions)
  const lines = [
    `plan ${short(d.fromHash)} -> ${short(d.toHash)}`,
    `${o.written ? "written" : "would write"} ${d.file}${o.dry ? " (dry run)" : ""}`,
    `planHash: ${d.planHash}`,
  ]
  if (d.drift !== null) {
    lines.push(`drift (${d.drift.reason}): needs allow: drift`)
    if (d.drift.sections.length > 0)
      lines.push(`  fingerprint sections: ${d.drift.sections.join(", ")}`)
    for (const path of d.drift.paths) lines.push(`  ${path}`)
  }
  if (d.steps.length === 0) lines.push("steps: none")
  else {
    lines.push(`steps (${d.steps.length}):`)
    for (const s of d.steps) {
      const tags = [
        `lock ${s.lockClass}`,
        ...(needs.has(s.id) ? [`needs allow: ${s.id}`] : []),
      ]
      const first = s.sql.trim().split("\n")[0] ?? ""
      lines.push(`  ${s.id} ${s.class} (${tags.join("; ")}) ${first}`)
    }
  }
  lines.push(report)
  return lines.join("\n")
}

/**
 * Підсумок застосування; репетиція нагадує, що блокування були справжні.
 * Без даних заголовок судить за діагностикою: після обриву з невідомим
 * результатом «нічого не записано» було б неправдою, а повтор за нею міг би
 * застосувати план удруге.
 */
export function renderApply(
  d: ApplyData | undefined,
  diagnostics: readonly Diagnostic[],
  report: string
): string {
  const unknown = diagnostics.find(
    (x) => x.code === "apply.connection-lost" && x.params?.outcome === "unknown"
  )
  const head =
    d === undefined
      ? unknown === undefined
        ? "apply: nothing was written"
        : `apply: outcome unknown — check simetra.ledger for apply id ${String(unknown.params?.applyId)}`
      : d.status === "committed"
        ? `apply: committed in ${d.attempts} attempt(s)`
        : `rehearse: rolled back after ${d.attempts} attempt(s); nothing was written. The rehearsal took ACCESS EXCLUSIVE locks on the changed tables, as apply does.`
  return [head, report].join("\n")
}
