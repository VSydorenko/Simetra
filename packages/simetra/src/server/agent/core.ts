import type {
  Batch,
  CommandResult,
  RuntimeCatalog,
  MetadataRef,
  ReadQuery,
  ReadResult,
  SessionClaims,
} from "simetra/model"
import {
  describeObject,
  summarizeObject,
  type AgentObjectDescription,
  type AgentObjectSummary,
} from "./describe"
import { toJson } from "./json"
import { AgentWriteRefused, agentWriteRefusal } from "./write-refusal"

/** A named object is not in the runtime catalog (`catalog.unknown-object`). */
export class AgentUnknownObject extends Error {
  readonly object: MetadataRef

  constructor(object: MetadataRef) {
    super("catalog.unknown-object")
    this.name = "AgentUnknownObject"
    this.object = object
  }
}

export interface AgentCorePermissions {
  /** Permission to write rights: rights catalogs and a scope root with a creator. */
  rightsWrite?: boolean
}

// Структурна межа замість імпорту `CommandRuntime`: зона чистоти T3 не пускає
// `../` з теки каталогу. Що `CommandRuntime` її задовольняє, закріплює
// перевірка типів у `server/index.ts`. З пакета не експортується.
/** What the catalog needs from a command runtime. */
export interface AgentRuntime {
  readonly catalog: RuntimeCatalog
  run(
    session: SessionClaims,
    input: readonly Batch[number][]
  ): Promise<CommandResult>
  read(session: SessionClaims, query: ReadQuery): Promise<ReadResult>
}

export interface AgentCoreOptions {
  runtime: AgentRuntime
  permissions?: AgentCorePermissions
}

/**
 * The core of the agent tool catalog: data in JSON form, with no presentation
 * limits. It calls only the command runtime methods; there is no other path to
 * the database. A refusal is the runtime's `CommandFailure`, the guard's
 * `AgentWriteRefused` or `AgentUnknownObject`.
 */
export interface AgentCore {
  /** Without a name: every catalog object; with a name: that object's description. */
  describe(): { objects: AgentObjectSummary[] }
  describe(object: MetadataRef): AgentObjectDescription
  describe(
    object?: MetadataRef
  ): { objects: AgentObjectSummary[] } | AgentObjectDescription
  read(session: SessionClaims, query: ReadQuery): Promise<unknown>
  /** Runs a batch of one or more objects; every verb goes through this one point. */
  execute(session: SessionClaims, batch: Batch): Promise<unknown>
}

export function createAgentCore(options: AgentCoreOptions): AgentCore {
  const { runtime } = options
  // Дозволи беруться тут, а не на виклик: шляху запису повз запобіжник на
  // об'єкті каталогу немає.
  const rightsWrite = options.permissions?.rightsWrite === true
  function describe(): { objects: AgentObjectSummary[] }
  function describe(object: MetadataRef): AgentObjectDescription
  function describe(
    object?: MetadataRef
  ): { objects: AgentObjectSummary[] } | AgentObjectDescription {
    const { catalog } = runtime
    if (object === undefined)
      return { objects: catalog.objects.map(summarizeObject) }
    const found = catalog.objects.find(
      (o) => o.kind === object.kind && o.name === object.name
    )
    if (found === undefined) throw new AgentUnknownObject(object)
    return describeObject(catalog, found)
  }
  return {
    describe,
    async read(session, query) {
      const result: ReadResult = await runtime.read(session, query)
      return toJson(result)
    },
    async execute(session, batch) {
      const refusal = agentWriteRefusal(runtime.catalog, batch, {
        rightsWrite,
      })
      if (refusal !== undefined) throw new AgentWriteRefused(refusal.object)
      const result: CommandResult = await runtime.run(session, batch)
      return toJson(result)
    },
  }
}
