import { z } from "zod"

/**
 * Verified identity of an agent access token, as the host's token verifier
 * reports it. The MCP adapter parses the verifier output with this schema; a
 * malformed shape is treated as an invalid token (401).
 */
// Звичайний `z.object` відкидає зайві поля: порт не має протягнути в адаптер
// чужі claims токена.
export const agentTokenInfoSchema = z.object({
  /** The human user the agent acts for. */
  sub: z.string().min(1),
  isAnonymous: z.boolean(),
  /** The OAuth client the token was issued to. */
  clientId: z.string().min(1),
  /** Resources the token is valid for. */
  aud: z.array(z.string()),
  /** Scope pin: the top-level scope value the token is narrowed to. */
  // `z.guid()`, а не `z.uuid()`: як у `sessionClaimsSchema`, значення скоупу —
  // UUID Postgres без RFC-варіанта.
  pin: z.guid().optional(),
})

export type AgentTokenInfo = z.infer<typeof agentTokenInfoSchema>

/**
 * The agent-token port the host supplies: verifies `token` for `resource` and
 * returns its identity, or `null` when the token is not valid for it.
 */
export type VerifyAgentToken = (
  token: string,
  resource: string
) => Promise<AgentTokenInfo | null>

/**
 * One agent tool call that passed token verification. Carries no data values,
 * input text or tokens: the input appears only as a keyed hash.
 */
export interface AgentCallEvent {
  /** ISO 8601 time the call started. */
  time: string
  durationMs: number
  tool: string
  /** HMAC-SHA-256 hex of the canonical JSON input, keyed by the host. */
  inputHash: string
  status: "ok" | "error"
  errorCode?: string
  rows?: number
  /** The human user (`sub`) the agent acts for. */
  sub: string
  /** The acting agent client. */
  actor: string
  /** Scope pin of the token, when present. */
  pin?: string
}

/** The host's sink for agent call events; a failure must not break the call. */
export type OnAgentCall = (event: AgentCallEvent) => void | Promise<void>
