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

/** Названий об'єкт не в каталозі рантайму (`catalog.unknown-object`). */
export class AgentUnknownObject extends Error {
  readonly object: MetadataRef

  constructor(object: MetadataRef) {
    super("catalog.unknown-object")
    this.name = "AgentUnknownObject"
    this.object = object
  }
}

export interface AgentCorePermissions {
  /** Дозвіл писати права: довідники прав і корінь із творцем. */
  rightsWrite?: boolean
}

/**
 * Що каталогу потрібно від `CommandRuntime`: структурна межа, бо зона чистоти
 * T3 не пускає `../` з теки каталогу; рантайм її задовольняє без адаптера.
 */
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
 * Ядро каталогу інструментів агента: дані в JSON-формі без меж подання.
 * Кличе лише методи `CommandRuntime`, нового шляху в базу немає. Відмова —
 * `CommandFailure` рантайму, `AgentWriteRefused` запобіжника чи
 * `AgentUnknownObject`.
 */
export interface AgentCore {
  /** Без імені — перелік усіх об'єктів каталогу, з іменем — опис одного. */
  describe(): { objects: AgentObjectSummary[] }
  describe(object: MetadataRef): AgentObjectDescription
  describe(
    object?: MetadataRef
  ): { objects: AgentObjectSummary[] } | AgentObjectDescription
  read(session: SessionClaims, query: ReadQuery): Promise<unknown>
  /** Пакет одного чи кількох об'єктів: усі дієслова ділять цю одну точку. */
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
