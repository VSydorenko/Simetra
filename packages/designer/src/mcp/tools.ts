import type { CallToolResult, McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"
import { formatDiagnostics } from "../io/report"
import { TOOLS, type Tool, type ToolResult } from "../tools/catalog"
import { invoke } from "../tools/invoke"
import { ALLOW_WRITE_FLAG } from "../tools/write-access"

export interface McpToolOptions {
  dir: string
  allowWrite: boolean
}

const dryRun = z.boolean().optional().meta({
  description: "Report the changes without writing them.",
})

// Необов'язкове: перегляд руйнівної зміни (`dryRun`) не потребує підтвердження.
const confirm = z.boolean().optional().meta({
  description: "Must be true to actually perform a destructive change.",
})

/**
 * Схема входу MCP = вхід каталогу плюс транспортні поля. Дозвіл, підтвердження
 * й запис вирішує `invoke`, тож тут лише перелік полів, які він отримує.
 */
export function mcpInputSchema(tool: Tool): z.ZodType {
  if (tool.effect === "read") return tool.input
  if (!(tool.input instanceof z.ZodObject)) {
    throw new Error(`tool ${tool.name} needs an object input to take dryRun`)
  }
  const base = tool.input.extend({ dryRun })
  return tool.destructive ? base.extend({ confirm }) : base
}

function describe(tool: Tool): string {
  // Однаковий у будь-якому режимі, щоб `tools/list` не залежав від прапорця.
  return tool.effect === "read"
    ? tool.description
    : `${tool.description} Requires the server to run with ${ALLOW_WRITE_FLAG}.`
}

function lineFor(
  c: { path: string; deleted: boolean },
  written: boolean
): string {
  if (written) return `${c.deleted ? "deleted" : "written"} ${c.path}`
  return `${c.deleted ? "would delete" : "would write"} ${c.path}`
}

function toResponse(
  tool: Tool,
  result: ToolResult,
  o: McpToolOptions,
  dry: boolean
): CallToolResult {
  const { ok, written, changes, diagnostics, refusal } = result
  if (refusal !== undefined) {
    return {
      isError: true,
      structuredContent: { ok, written, changes, diagnostics },
      content: [{ type: "text", text: refusal.message }],
    }
  }
  // `explain` віддає саме пояснення; решта — єдину обгортку результату.
  if (tool.name === "explain" && ok && result.data !== undefined) {
    return {
      structuredContent: { ...(result.data as Record<string, unknown>) },
      content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }],
    }
  }
  const report = formatDiagnostics(diagnostics, {
    dir: o.dir,
    locale: "en",
    format: "text",
  })
  const lines = ok
    ? [
        ...changes.map((c) => lineFor(c, written)),
        ...(dry && tool.effect === "files" ? ["dry run: nothing written"] : []),
        ...(tool.effect === "read" ? [`${tool.name}: no errors`] : []),
      ]
    : tool.effect === "files"
      ? ["nothing written: the operation was refused or the result has errors"]
      : [`${tool.name}: the metadata has errors`]
  return {
    isError: !ok,
    structuredContent: { ok, written, changes, diagnostics },
    content: [{ type: "text", text: [...lines, report].join("\n") }],
  }
}

/** Реєструє весь каталог: транспорт лише переказує `confirm`/`dryRun` у `invoke`. */
export function registerCatalog(server: McpServer, o: McpToolOptions): void {
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        description: describe(tool),
        inputSchema: mcpInputSchema(tool),
        annotations: {
          readOnlyHint: tool.effect === "read",
          destructiveHint: tool.destructive,
        },
      },
      async (args: unknown) => {
        const {
          dryRun: dry,
          confirm: confirmed,
          ...input
        } = (args ?? {}) as Record<string, unknown>
        const result = await invoke(tool, input, {
          dir: o.dir,
          allowWrite: o.allowWrite,
          dryRun: dry === true,
          confirmed: confirmed === true,
        })
        return toResponse(tool, result, o, dry === true)
      }
    )
  }
}
