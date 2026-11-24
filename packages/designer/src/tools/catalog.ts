import { applyTool, planTool } from "./apply-tools"
import { diffTool, introspectTool } from "./database-tools"
import { dataCommandTool, dataReadTool } from "./data-tools"
import {
  addTool,
  createTool,
  declareFunctionTool,
  deleteTool,
  promoteTool,
  renameTool,
} from "./mutations"
import { compileTool, explainTool, fixTool } from "./read"
import { rightsMaintenanceTool } from "./rights-maintenance-tool"
import { rolesTool } from "./roles-tool"
import { signalsConfigTool } from "./signals-config"
import type { Tool, ToolResult } from "./types"

export type {
  DataAccess,
  DataResource,
  DataSession,
  DatabaseAccess,
  DatabaseContext,
  DatabaseResource,
  FilesAccess,
  InvokeOptions,
  Presentation,
  PresentationView,
  RefusalReason,
  RunOutcome,
  Tool,
  ToolContext,
  ToolName,
  ToolResult,
} from "./types"

/** Єдиний каталог інструментів: CLI, MCP і студія — лише його адаптери. */
export const TOOLS: readonly Tool[] = [
  compileTool,
  explainTool,
  fixTool,
  createTool,
  addTool,
  declareFunctionTool,
  renameTool,
  deleteTool,
  promoteTool,
  introspectTool,
  diffTool,
  planTool,
  applyTool,
  rolesTool,
  rightsMaintenanceTool,
  signalsConfigTool,
  dataReadTool,
  dataCommandTool,
]

/**
 * Поля `data` інструмента у структурованому результаті обох каналів: їх
 * вирішує `tool.present`, не ім'я інструмента.
 */
export function structureOf(
  tool: Tool,
  data: unknown
): Record<string, unknown> {
  return (
    tool.present?.structure?.(data as never) ??
    (data as Record<string, unknown>)
  )
}

/**
 * Що з результату показують канали: єдиний розв'язок для CLI і MCP. `data`
 * не показується, коли в інструмента нема `present`, коли він лише
 * діагностичний (`compile`: модель — не відповідь агентові, вона ~МБ) і коли
 * `bare`-результат не `ok`. Інструмент осі `artifact` показується й без
 * `data`: відмова теж має артефакти.
 */
export function presentation(
  tool: Tool,
  r: Pick<ToolResult, "ok" | "data">
): { shown: boolean; data: unknown } {
  const p = tool.present
  const shown =
    p !== undefined &&
    p.diagnosticsOnly !== true &&
    (p.bare === true
      ? r.ok && r.data !== undefined
      : r.data !== undefined || tool.files === "artifact")
  return { shown, data: shown ? r.data : undefined }
}

export function toolByName(name: string): Tool | undefined {
  return TOOLS.find((t) => t.name === name)
}
