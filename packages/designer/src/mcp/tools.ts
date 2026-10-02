import type { CallToolResult, McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"
import { formatDiagnostics, renderDiff } from "../io/report"
import { TOOLS, type Tool, type ToolResult } from "../tools/catalog"
import { invoke } from "../tools/invoke"
import type { DiffData } from "../tools/database-tools"
import type { DatabaseResource } from "../tools/types"

export interface McpToolOptions {
  dir: string
  readOnly: boolean
  /** Ресурс запуску; без нього інструменти бази відмовляють із підказкою. */
  database?: DatabaseResource
  /** Ім'я змінної середовища з рядком підключення: його називає відмова. */
  databaseEnv?: string
  /** Справжній argv запуску: потрапляє в підказку відмови запису. */
  launchArgs?: readonly string[]
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
  if (tool.files === "read") return tool.input
  if (!(tool.input instanceof z.ZodObject)) {
    throw new Error(`tool ${tool.name} needs an object input to take dryRun`)
  }
  const base = tool.input.extend({ dryRun })
  return tool.destructive ? base.extend({ confirm }) : base
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
  // Дані бази — повністю в `structuredContent`, текст — зведення. Відмінності
  // звірки — не помилка виклику: `isError` лише за помилками діагностики
  if (tool.name === "diff" && result.data !== undefined) {
    const data = result.data as DiffData
    return {
      isError: !ok,
      structuredContent: { ok, written, changes, ...data },
      content: [{ type: "text", text: renderDiff(data, report) }],
    }
  }
  const lines = ok
    ? [
        ...changes.map((c) => lineFor(c, written)),
        ...(dry && tool.files === "write" ? ["dry run: nothing written"] : []),
        ...(tool.files === "read" ? [`${tool.name}: no errors`] : []),
      ]
    : tool.files === "write"
      ? ["nothing written: the operation was refused or the result has errors"]
      : [`${tool.name}: the metadata has errors`]
  return {
    isError: !ok,
    structuredContent: {
      ok,
      written,
      changes,
      diagnostics,
      ...(tool.name === "introspect" && result.data !== undefined
        ? (result.data as Record<string, unknown>)
        : {}),
    },
    content: [{ type: "text", text: [...lines, report].join("\n") }],
  }
}

/** Реєструє весь каталог: транспорт лише переказує `confirm`/`dryRun` у `invoke`. */
export function registerCatalog(server: McpServer, o: McpToolOptions): void {
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        // Опис не залежить від режиму, щоб `tools/list` не залежав від прапорця.
        description: tool.description,
        inputSchema: mcpInputSchema(tool),
        annotations: {
          readOnlyHint: tool.files === "read" && tool.database !== "write",
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
          readOnly: o.readOnly,
          dryRun: dry === true,
          confirmed: confirmed === true,
          database: o.database,
          ...(o.databaseEnv === undefined
            ? {}
            : { databaseEnv: o.databaseEnv }),
          launchArgs: o.launchArgs,
        })
        return toResponse(tool, result, o, dry === true)
      }
    )
  }
}
