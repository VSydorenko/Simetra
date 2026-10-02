import type { Explanation, Locale } from "simetra/compiler"
import { formatDiagnostics, renderDiff } from "../io/report"
import type { Tool, ToolResult } from "../tools/catalog"
import type { DiffData } from "../tools/database-tools"

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
    ].join("\n"),
  }
}
