import type { SessionClaims } from "simetra/model"
import {
  AGENT_TOOLS,
  createAgentCore,
  createToolCaller,
  DEFAULT_MAX_RESULT_CHARS,
  type AgentCore,
  type AgentCorePermissions,
  type AgentTool,
  type AgentToolResult,
} from "./agent"
import type { CommandRuntime } from "./runtime"

export interface AgentToolCatalogOptions {
  runtime: CommandRuntime
  /** Given at creation, not per call: no write path goes around the guard. */
  permissions?: AgentCorePermissions
  /** Size limit of a result text in characters; default 44 000. */
  maxResultChars?: number
}

/**
 * The agent tool catalog: the tool layer (`tools`, `call`) over the core
 * (`describe`, `read`, `execute`, data in JSON form).
 */
export interface AgentToolCatalog extends AgentCore {
  readonly tools: readonly AgentTool[]
  call(
    session: SessionClaims,
    name: string,
    input: unknown
  ): Promise<AgentToolResult>
}

// Фабрика приймає `CommandRuntime`, а не внутрішню структурну межу ядра:
// публічний тип не тягне за собою `AgentRuntime`.
export function createAgentToolCatalog(
  options: AgentToolCatalogOptions
): AgentToolCatalog {
  const { runtime } = options
  const core = createAgentCore({ runtime, permissions: options.permissions })
  return {
    ...core,
    tools: AGENT_TOOLS,
    call: createToolCaller({
      core,
      catalog: () => runtime.catalog,
      maxResultChars: options.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS,
    }),
  }
}
