import type { Diagnostic, Locale } from "simetra/compiler"
import { localize } from "simetra/compiler"
import { quoteIdent } from "simetra/model"
import { LOCK_MODE_SQL } from "simetra/schema"
import type { ApplyData, PlanData, PlanPromotion } from "../tools/apply-tools"
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

/** Режим `plpgsql_check` плану словами виводу. */
const PLPGSQL_CHECK_LABEL: Readonly<Record<PlanData["plpgsqlCheck"], string>> =
  {
    installed: "installed",
    transient: "transient (installed for the check, rolled back)",
    unavailable: "unavailable",
  }

const qualified = (schema: string, name: string): string =>
  `${quoteIdent(schema)}.${quoteIdent(name)}`

/**
 * Блок «Promotion»: що стає чим і що людина
 * дозволяє. Таблиця, що лишає своє ім'я, рядка перейменування не дає:
 * `a -> a` читався б як зміна, якої немає.
 */
function promotionLines(p: PlanPromotion, needs: Set<string>): string[] {
  const lines = [
    `promotion: ${p.kind} ${p.name} (${p.objectId})`,
    `  record hash: ${p.recordHash}`,
  ]
  for (const t of p.tables.filter((x) => x.from !== x.to))
    lines.push(
      `  table ${qualified(t.schema, t.from)} -> ${qualified(t.schema, t.to)}`
    )
  for (const c of p.columns)
    lines.push(
      `  column ${qualified(c.table.schema, c.table.name)}: ${quoteIdent(c.from)} -> ${quoteIdent(c.to)}`
    )
  for (const c of p.canonicalNames)
    lines.push(
      `  ${c.kind} ${qualified(c.table.schema, c.table.name)}: ${quoteIdent(c.from)} -> ${quoteIdent(c.to)}`
    )
  // Вираз кроку показано в старих іменах, як його обчислює раннер; тригери —
  // ті, що запис вимикає на свій час: людина бачить побічний ефект наперед
  for (const t of p.data) {
    lines.push(`  data steps ${qualified(t.after.schema, t.after.table)}:`)
    for (const c of t.columns)
      lines.push(
        `    ${c.step} ${quoteIdent(c.column)} ← ${c.expression} (${c.kind})`
      )
    if (t.triggers.length > 0)
      lines.push(
        `    triggers disabled during the write: ${t.triggers.map((x) => quoteIdent(x.name)).join(", ")}`
      )
  }
  for (const item of p.permissionItems) {
    lines.push(
      `  ${item.token}${needs.has(item.token) ? ` (needs allow: ${item.token})` : ""}`
    )
    for (const s of item.summary) lines.push(`    ${s}`)
  }
  return lines
}

/**
 * Зведення плану для людини й агента: звідки й куди, `planHash` і файл,
 * дрейф — першим блоком, до кроків (платформна спека §6.2): кроки читаються
 * вже знаючи, що ціль дрейфнула. Далі — промоція, бо кроки наміру й класи
 * конверсій читаються, знаючи, що стає чим. Повний
 * SQL — у файлі плану; тут перший рядок.
 */
export function renderPlan(
  d: PlanData | undefined,
  report: string,
  o: { ok: boolean; written: boolean }
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
    `${o.written ? "written" : "not written"} ${d.file}`,
    `planHash: ${d.planHash}`,
  ]
  if (d.drift !== null) {
    lines.push(`drift (${d.drift.reason}): needs allow: drift`)
    if (d.drift.sections.length > 0)
      lines.push(`  fingerprint sections: ${d.drift.sections.join(", ")}`)
    for (const path of d.drift.paths) lines.push(`  ${path}`)
  }
  if (d.promotion !== null) lines.push(...promotionLines(d.promotion, needs))
  const stepLine = (s: PlanData["steps"][number]): string => {
    const tags = [
      `lock ${s.lockClass}`,
      ...(s.conversion === undefined ? [] : [`conversion ${s.conversion}`]),
      ...(needs.has(s.id) ? [`needs allow: ${s.id}`] : []),
    ]
    const first = s.sql.trim().split("\n")[0] ?? ""
    return `  ${s.id} ${s.origin} ${s.class} (${tags.join("; ")}) ${first}`
  }
  // Кроки середовища — окремою групою (спека промоції §7.2): вони не
  // з метаданих, а з глобальних типових привілеїв ролі на цілі, і без цього
  // пояснення пара `REVOKE ALL` + `GRANT` виглядала б зайвою. Пара не
  // скорочується: це вивід двигуна
  const environment = d.steps.filter((s) => s.origin === "environment")
  const steps = d.steps.filter((s) => s.origin !== "environment")
  if (steps.length === 0) lines.push("steps: none")
  else {
    lines.push(`steps (${steps.length}):`)
    lines.push(...steps.map(stepLine))
  }
  if (environment.length > 0) {
    lines.push(
      `environment rights: the global default privileges of role ${quoteIdent(d.environment.role)}:`
    )
    lines.push(...environment.map(stepLine))
  }
  // Замки наперед — одна точка очікування застосування; неявний замок —
  // таблиці немає серед них, але крок її таки блокує (спека промоції §7.2)
  if (d.locks.length > 0)
    lines.push(
      `locks up front: ${d.locks.map((l) => `${qualified(l.schema, l.name)} ${LOCK_MODE_SQL[l.mode]}`).join(", ")}`
    )
  for (const l of d.implicitLocks)
    lines.push(
      `implicit lock: ${qualified(l.schema, l.name)} ${LOCK_MODE_SQL[l.mode]} taken by step ${l.step}, not up front: the apply role may not lock it explicitly`
    )
  lines.push(`plpgsql_check: ${PLPGSQL_CHECK_LABEL[d.plpgsqlCheck]}`)
  // Очікувані сліпі функції провайдера — рядок, а не попередження: інакше
  // попередження звучало б на кожній цілі провайдера (спека промоції §7.2)
  if (d.expectedBlindFunctions > 0)
    lines.push(
      `expected provider blind functions (preset): ${d.expectedBlindFunctions}`
    )
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
        : `rehearse: rolled back after ${d.attempts} attempt(s); the database was not changed; ${d.report === null ? "no rehearsal report was written" : `rehearsal report written to ${d.report}`}. The rehearsal took the plan's locks, as apply does.`
  return [head, report].join("\n")
}
