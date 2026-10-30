import type { Explanation, Locale, PromotionRecord } from "simetra/compiler"
import {
  formatDiagnostics,
  renderApply,
  renderDiff,
  renderPlan,
} from "../io/report"
import type { ApplyData, PlanData } from "../tools/apply-tools"
import type { Tool, ToolResult } from "../tools/catalog"
import type { DiffData } from "../tools/database-tools"
import type { RolesData } from "../tools/roles-tool"

/** Текст пояснення об'єкта для терміналу; JSON-вигляд друкується як є. */
export function renderExplanation(e: Explanation): string {
  const lines = [`${e.object.kind} ${e.object.name} (${e.object.file})`]
  if (e.object.scopeKind !== undefined) {
    lines.push(`scope: ${e.object.scopeKind}`)
  }
  for (const t of e.tables) {
    lines.push("", `table ${t.schema}.${t.name}${t.part ? ` [${t.part}]` : ""}`)
    for (const c of t.columns) {
      const tags = [
        c.notNull ? "not null" : undefined,
        c.logical === undefined ? undefined : `logical: ${c.logical}`,
        c.standard === undefined ? undefined : `standard: ${c.standard}`,
        c.scope === true ? "scope" : undefined,
      ].filter((x) => x !== undefined)
      lines.push(
        `  ${c.name} ${c.type}${tags.length > 0 ? ` (${tags.join(", ")})` : ""}`
      )
    }
    if (t.primaryKey !== undefined) {
      lines.push(`  primary key (${t.primaryKey.join(", ")})`)
    }
    for (const u of t.uniques) lines.push(`  unique (${u.join(", ")})`)
    for (const f of t.foreignKeys) {
      lines.push(`  foreign key (${f.columns.join(", ")}) -> ${f.references}`)
    }
  }
  for (const q of e.movementQueries) {
    lines.push("", `movement query ${q.identity}`, q.sql)
  }
  for (const u of e.generatedUnits) {
    lines.push("", `generated ${u.identity}`, u.sql)
  }
  if (e.contracts.length > 0) {
    lines.push("", "contracts:", JSON.stringify(e.contracts, null, 2))
  }
  if (e.referencedBy.length > 0) {
    lines.push("", "referenced by:")
    for (const r of e.referencedBy) {
      lines.push(`  ${r.file}#${r.pointer} (${r.role})`)
    }
  }
  return `${lines.join("\n")}\n`
}

/**
 * Підсумок запису промоції для терміналу: що на що перетворилось і що
 * лишається плану бази. Повний запис — у `--format json`.
 */
export function renderPromotion(r: PromotionRecord, written: boolean): string {
  // Дієслово йде за записом, як рядки змін над підсумком: прогін без запису
  // нічого не промотував.
  const verb = written ? "promoted" : "would promote"
  const lines = [`${verb} ${r.objectId} into ${r.kind}`]
  for (const t of r.tables) {
    lines.push(`  table ${t.schema}.${t.from} -> ${t.to}`)
  }
  const counts: [string, number][] = [
    ["columns renamed or moved", r.columns.length],
    ["type changes", r.typeChanges.length],
    ["data steps", r.dataSteps.length],
    ["columns retired", r.retired.length],
    ["constraints relaxed", r.relaxed.length],
    ["constraints tightened", r.tightened.length],
    ["row level security changes", r.rowLevelSecurity.length],
    ["delete semantics changes", r.deleteSemantics.length],
    ["conversions", r.conversions.length],
    ["units moved", r.movedUnits.length],
    ["units rewritten", r.rewrittenUnits.length],
    ["contract changes", r.contractChanges.length],
  ]
  for (const [label, n] of counts) if (n > 0) lines.push(`  ${label}: ${n}`)
  return lines.join("\n")
}

/** Кінцевий результат одного виклику в тексті/JSON для терміналу. */
export function renderResult(
  tool: Tool,
  r: ToolResult,
  o: { dir: string; locale: Locale; format: "text" | "json" }
): { stdout: string; json?: unknown[] } {
  const report = formatDiagnostics(r.diagnostics, o)
  if (tool.name === "compile") {
    return o.format === "json"
      ? { stdout: "", json: JSON.parse(report) as unknown[] }
      : { stdout: report }
  }
  if (tool.name === "explain" && r.ok && r.data !== undefined) {
    const explanation = r.data as Explanation
    return {
      stdout:
        o.format === "json"
          ? JSON.stringify(explanation, null, 2)
          : renderExplanation(explanation).trimEnd(),
    }
  }
  if (tool.name === "diff" && r.data !== undefined) {
    const data = r.data as DiffData
    return {
      stdout:
        o.format === "json"
          ? JSON.stringify(
              {
                ok: r.ok,
                empty: data.empty,
                plan: data.plan,
                differences: data.differences,
                diagnostics: JSON.parse(report) as unknown,
              },
              null,
              2
            )
          : renderDiff(data, report),
    }
  }
  if (tool.name === "plan" || tool.name === "apply") {
    if (o.format === "json")
      return {
        stdout: JSON.stringify(
          {
            ok: r.ok,
            written: r.written,
            artifacts: r.artifacts ?? [],
            ...(r.data as Record<string, unknown> | undefined),
            diagnostics: JSON.parse(report) as unknown,
          },
          null,
          2
        ),
      }
    return {
      stdout:
        tool.name === "plan"
          ? renderPlan(r.data as PlanData | undefined, report, {
              ok: r.ok,
              written: r.written,
            })
          : renderApply(r.data as ApplyData | undefined, r.diagnostics, report),
    }
  }
  if (tool.name === "roles" && r.data !== undefined) {
    const { roles, skipped } = r.data as RolesData
    return {
      stdout:
        o.format === "json"
          ? JSON.stringify(
              {
                ok: r.ok,
                roles,
                skipped,
                diagnostics: JSON.parse(report) as unknown,
              },
              null,
              2
            )
          : [
              ...roles.map((x) => `${x.server}: ${x.name} ${x.outcome}`),
              // Пропуск ролі входу не мовчазний: без провайдера невідомо,
              // членом якої ролі запиту вона мусить бути
              ...skipped.map(
                (x) =>
                  `target: ${x.name} skipped: the directory has no project.meta.json, so database.provider is unknown; run roles in a metadata directory with a project file to create it`
              ),
              ...(r.diagnostics.length > 0 ? [report] : []),
            ].join("\n"),
    }
  }
  if (tool.files === "read") return { stdout: report }
  const changed = r.changes.map((c) => c.path)
  if (o.format === "json") {
    return {
      stdout: JSON.stringify(
        {
          ok: r.ok,
          written: r.written,
          changed,
          diagnostics: JSON.parse(report) as unknown,
          ...(tool.name === "promote" && r.data !== undefined
            ? { record: r.data }
            : {}),
        },
        null,
        2
      ),
    }
  }
  const verb = (deleted: boolean): string =>
    r.written
      ? deleted
        ? "deleted"
        : "written"
      : deleted
        ? "would delete"
        : "would write"
  return {
    stdout: [
      ...r.changes.map((c) => `${verb(c.deleted)} ${o.dir}/${c.path}`),
      ...(r.ok ? [] : ["nothing written: the result has errors"]),
      report,
      ...(tool.name === "promote" && r.data !== undefined
        ? [renderPromotion(r.data as PromotionRecord, r.written)]
        : []),
    ].join("\n"),
  }
}
