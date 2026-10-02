import { compileTool, explainTool, fixTool } from "./read"
import type { Tool } from "./types"

export type {
  Effect,
  InvokeOptions,
  RefusalReason,
  RunOutcome,
  Tool,
  ToolName,
  ToolResult,
} from "./types"

/** Єдиний каталог інструментів: CLI, MCP і студія — лише його адаптери. */
export const TOOLS: readonly Tool[] = [compileTool, explainTool, fixTool]

export function toolByName(name: string): Tool | undefined {
  return TOOLS.find((t) => t.name === name)
}
