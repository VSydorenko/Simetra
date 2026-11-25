import type { AgentToolError } from "./errors"

/**
 * `awaiting_confirmation` is reserved for a two-step write confirmed by a
 * human (ADR-0104); the first release never returns it.
 */
export type AgentToolState = "done" | "awaiting_confirmation"

/** A successful tool result. */
export interface AgentToolSuccess {
  state: AgentToolState
  data?: unknown
  /** The result was cut to fit the size limit. */
  truncated?: true
  /** Where the next page of a cut `read` starts. */
  continuation?: { offset: number }
  /** How to get the rest of a cut result. */
  hint?: string
}

export type AgentToolResult = AgentToolSuccess | AgentToolError

export const isAgentError = (r: AgentToolResult): r is AgentToolError =>
  "code" in r

/** The one text form of a result: its length is what the size limit measures. */
export const renderResult = (result: AgentToolResult): string =>
  JSON.stringify(result)

/** A tool result in the shape of an MCP `CallToolResult`. */
export interface AgentMcpResult {
  structuredContent?: AgentToolSuccess
  content: [{ type: "text"; text: string }]
  isError?: true
}

/**
 * Presents a result for MCP without the SDK. Clients show the model different
 * parts, so both are self-contained: `structuredContent` is the result object
 * and `content` its full JSON text. An error carries only `content`: clients
 * show nothing else when `isError` is set.
 */
export function agentResultToMcp(result: AgentToolResult): AgentMcpResult {
  const content: AgentMcpResult["content"] = [
    { type: "text", text: renderResult(result) },
  ]
  if (isAgentError(result)) return { isError: true, content }
  return { structuredContent: result, content }
}
