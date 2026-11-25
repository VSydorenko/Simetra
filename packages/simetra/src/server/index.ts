import type { AgentRuntime } from "./agent/core"
import type { CommandRuntime } from "./runtime"

export {
  createCommandRuntime,
  readRoleOf,
  sessionKind,
  type CommandRuntime,
  type CommandRunOptions,
  type CommandRuntimeOptions,
  type ReadPartOutcome,
  type ReadPartsOptions,
  type ReadPartsResult,
} from "./runtime"
export { createDataHandler } from "./data-handler"
export {
  type AttachFileInput,
  type CheckUploadInput,
  type UploadLimits,
} from "./files"
export { FileAttachFailure } from "./transaction"
export { checkRequestOrigin, type RequestOrigin } from "./origin"
export type { LogEntry } from "./transaction"
export {
  fromPgPool,
  type CommandDatabase,
  type DatabaseClient,
  type PgPoolLike,
} from "./port"
export {
  fromS3Client,
  FileStoreError,
  INSTANCE_MARKER_KEY,
  type FileStore,
  type S3ClientLike,
} from "./file-store"
export {
  RECONCILE_GRACE_MS,
  type ReconcileLogEntry,
  type ReconcileOptions,
  type ReconcileRefusal,
  type ReconcileReport,
} from "./reconcile"
export {
  AgentUnknownObject,
  AgentWriteRefused,
  agentWriteRefusal,
  createAgentCore,
  OPERATION_VERBS,
  toJson,
  type AgentAttributeDescription,
  type AgentCore,
  type AgentCoreOptions,
  type AgentCorePermissions,
  type AgentObjectDescription,
  type AgentObjectSummary,
  AGENT_ERROR_CODES,
  AGENT_OUTCOMES,
  agentResultToMcp,
  type AgentErrorCode,
  type AgentMcpResult,
  type AgentOutcome,
  type AgentTool,
  type AgentToolAnnotations,
  type AgentToolError,
  type AgentToolResult,
  type AgentToolState,
  type AgentToolSuccess,
  type AgentVerb,
} from "./agent"
export {
  createAgentToolCatalog,
  type AgentToolCatalog,
  type AgentToolCatalogOptions,
} from "./agent-catalog"
// `CommandRuntime` задовольняє структурну межу каталогу: розбіжність
// сигнатур зламає перевірку типів тут, а не в адаптері.
void (null as unknown as CommandRuntime satisfies AgentRuntime)
