import { applyTool, planTool } from "./apply-tools"
import { diffTool, introspectTool } from "./database-tools"
import {
  addTool,
  createTool,
  deleteTool,
  promoteTool,
  renameTool,
} from "./mutations"
import { compileTool, explainTool, fixTool } from "./read"
import { rightsMaintenanceTool } from "./rights-maintenance-tool"
import { rolesTool } from "./roles-tool"
import type { Tool } from "./types"

export type {
  DataAccess,
  DataResource,
  DataSession,
  DatabaseAccess,
  DatabaseContext,
  DatabaseResource,
  FilesAccess,
  InvokeOptions,
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
  renameTool,
  deleteTool,
  promoteTool,
  introspectTool,
  diffTool,
  planTool,
  applyTool,
  rolesTool,
  rightsMaintenanceTool,
]

export function toolByName(name: string): Tool | undefined {
  return TOOLS.find((t) => t.name === name)
}
