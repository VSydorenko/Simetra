import { diffTool, introspectTool } from "./database-tools"
import { addTool, createTool, deleteTool, renameTool } from "./mutations"
import { compileTool, explainTool, fixTool } from "./read"
import type { Tool } from "./types"

export type {
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
  introspectTool,
  diffTool,
]

export function toolByName(name: string): Tool | undefined {
  return TOOLS.find((t) => t.name === name)
}
