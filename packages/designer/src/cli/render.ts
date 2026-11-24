import type { Locale } from "simetra/compiler"
import { formatDiagnostics } from "../io/report"
import {
  presentation,
  structureOf,
  type PresentationView,
  type Tool,
  type ToolResult,
} from "../tools/catalog"

/** Кінцевий результат одного виклику в тексті/JSON для терміналу. */
export function renderResult(
  tool: Tool,
  r: ToolResult,
  o: { dir: string; locale: Locale; format: "text" | "json" }
): { stdout: string; json?: unknown[] } {
  const report = formatDiagnostics(r.diagnostics, o)
  // Усі відмінності між інструментами — у `tool.present`, не в гілках за іменем
  const present = tool.present
  if (present?.diagnosticsOnly === true) {
    return o.format === "json"
      ? { stdout: "", json: JSON.parse(report) as unknown[] }
      : { stdout: report }
  }
  const view: PresentationView = {
    channel: "cli",
    ok: r.ok,
    written: r.written,
    diagnostics: r.diagnostics,
    report,
  }
  const { shown: shows, data } = presentation(tool, r)
  if (shows && present?.bare === true && o.format === "json")
    return { stdout: JSON.stringify(r.data, null, 2) }
  if (shows && o.format === "text") {
    const text = present?.text?.(r.data, view)
    if (text !== undefined) return { stdout: text }
  }
  if (!shows && tool.files === "read") return { stdout: report }
  const changed = r.changes.map((c) => c.path)
  if (o.format === "json") {
    return {
      stdout: JSON.stringify(
        {
          ok: r.ok,
          written: r.written,
          ...(r.wouldWrite === true ? { wouldWrite: true } : {}),
          changed,
          ...(tool.files === "artifact"
            ? { artifacts: r.artifacts ?? [] }
            : {}),
          ...(data !== undefined ? structureOf(tool, data) : {}),
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
      ...(r.ok
        ? []
        : r.written
          ? [
              "written: the result keeps only repair-class errors the directory already had",
            ]
          : r.wouldWrite === true
            ? [
                "would write: the result keeps only repair-class errors the directory already had",
              ]
            : ["nothing written: the result has errors"]),
      report,
      ...(data !== undefined && present?.appendix !== undefined
        ? [present.appendix(data, view)]
        : []),
    ].join("\n"),
  }
}
