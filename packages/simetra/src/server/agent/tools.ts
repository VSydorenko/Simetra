import {
  batchSchema,
  CommandFailure,
  metadataRefSchema,
  readQuerySchema,
  type Batch,
  type MetadataRef,
  type ReadQuery,
  type RuntimeCatalog,
  type SessionClaims,
} from "simetra/model"
import { z } from "zod"
import { AgentUnknownObject, type AgentCore } from "./core"
import { agentError, failureError, type AgentToolError } from "./errors"
import {
  renderResult,
  type AgentToolResult,
  type AgentToolSuccess,
} from "./result"
import { OPERATION_VERBS, type AgentVerb } from "./verbs"
import { AgentWriteRefused } from "./write-refusal"

/** The default size limit of a result text: 20 000 tokens at about 2.2 characters. */
export const DEFAULT_MAX_RESULT_CHARS = 44_000

/** MCP tool annotations; every one is explicit, the MCP defaults are unsafe. */
export interface AgentToolAnnotations {
  readOnlyHint: boolean
  destructiveHint: boolean
  idempotentHint: boolean
  openWorldHint: false
}

/** A tool of the catalog: what an adapter lists in `tools/list`. */
export interface AgentTool {
  /** Matches `^[a-z][a-z0-9_]{0,47}$`. */
  name: string
  title: string
  /** At most 4096 characters. */
  description: string
  /** The input schema; the adapter derives the JSON Schema from it. */
  input: z.ZodType
  annotations: AgentToolAnnotations
}

const READ_ONLY: AgentToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
}

// `write` теж `destructiveHint: true`: зміна перезаписує значення й табличні
// частини, а MCP вважає неруйнівним лише суто додавальний запис.
const WRITES: AgentToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
}

// Уточнення — на вхідній схемі, тож `path` помилки веде до дії, яка не
// пасує: пакет вужчий за ядро, де змішані пакети лишаються для designer.
function narrowedBatch(verb: AgentVerb) {
  return z
    .strictObject({ operations: batchSchema })
    .superRefine((value, ctx) => {
      const first = value.operations[0]!.object
      value.operations.forEach((op, i) => {
        if (op.object.kind !== first.kind || op.object.name !== first.name)
          ctx.addIssue({
            code: "custom",
            path: ["operations", i, "object"],
            message: `A batch changes one object; expected ${first.kind}.${first.name}`,
          })
        if (OPERATION_VERBS[op.action] !== verb) {
          const other = verb === "write" ? "remove" : "write"
          ctx.addIssue({
            code: "custom",
            path: ["operations", i, "action"],
            message: `The ${verb} tool does not run "${op.action}"; use the ${other} tool`,
          })
        }
      })
    })
}

const writeInput = narrowedBatch("write")
const removeInput = narrowedBatch("remove")

export const AGENT_TOOLS: readonly AgentTool[] = [
  {
    name: "describe",
    title: "Describe objects",
    description:
      "List the objects of the application, or describe one object. Without arguments it returns every object with its title, description, tools (verbs) and runtime operations. With `object` ({ kind, name }) it returns that object's attributes (name, type, required, maxLength, enum values, Ref target), tabular sections, tools and operations. Call it first to learn the names and types that read, write and remove need. It does not judge access rights: the database does when you read or change data.",
    input: z.strictObject({ object: metadataRefSchema.optional() }),
    annotations: READ_ONLY,
  },
  {
    name: "read",
    title: "Read data",
    description:
      "Read data under the current user's rights. Forms of `query`: a card by `id` (optionally with `tabularSections` and `include` for Ref targets); a page by `where` filter tree, `orderBy`, `offset` and `limit`; a count with `count: true`; the lines of one owner or a page or count of a tabular section with `tabularSection`. A page over the size limit is cut from the end: the result has `truncated: true` and `continuation.offset` to pass as `offset` of the next call. Use describe to learn attribute names first.",
    input: z.strictObject({ query: readQuerySchema }),
    annotations: READ_ONLY,
  },
  {
    name: "write",
    title: "Create or update rows",
    description:
      "Create and update rows of ONE object in one transaction. `operations` is a non-empty list of { action: 'create' | 'update', object, ... }. An update needs `id` and `expectedVersion` (the version you read) and replaces the values and tabular sections it names. If another user changed the row, the call fails with command.conflict: read it again and resend. The result lists the written rows and changes; when it is too large the rows are cut to key and version and `truncated` is true, but the change is done. Do not repeat a write because of `truncated`.",
    input: writeInput,
    annotations: WRITES,
  },
  {
    name: "remove",
    title: "Mark or delete rows",
    description:
      "Mark rows of ONE object for deletion, unmark them, or delete them, in one transaction. `operations` is a non-empty list of { action: 'markDeletion' | 'delete', object, id, expectedVersion, ... }; markDeletion takes `mark: true | false`. Prefer markDeletion: it can be undone, delete cannot. A row changed by another user fails with command.conflict: read it again and resend. When the result is too large the rows are cut to key and version and `truncated` is true, but the change is done. Do not repeat a remove because of `truncated`.",
    input: removeInput,
    annotations: WRITES,
  },
]

const tooLarge = (what: string): AgentToolError =>
  agentError(
    "catalog.result-too-large",
    `The ${what} does not fit the size limit of one answer`
  )

/** The largest `n` in `[min, max]` for which `fits(n)`, or `undefined`. */
function largest(
  min: number,
  max: number,
  fits: (n: number) => boolean
): number | undefined {
  let lo = min
  let hi = max
  let found: number | undefined
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (fits(mid)) {
      found = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return found
}

interface ReadRowsJson {
  rows?: Record<string, unknown>[]
  included?: Record<string, Record<string, unknown>[]>
  [key: string]: unknown
}

// Рядки `included` лишаються лише для лишених рядків сторінки: інакше агент
// бачив би цілі, на які не посилається жоден рядок результату.
function keepIncluded(
  catalog: RuntimeCatalog,
  data: ReadRowsJson,
  rows: Record<string, unknown>[],
  include: readonly string[]
): ReadRowsJson["included"] {
  if (data.included === undefined) return undefined
  const referenced = new Set<string>()
  for (const row of rows)
    for (const name of include)
      for (const value of [row[name]].flat())
        if (typeof value === "string") referenced.add(value)
  return Object.fromEntries(
    Object.entries(data.included).map(([key, list]) => {
      const object = catalog.objects.find((o) => `${o.kind}.${o.name}` === key)
      const keyName = object?.keyName
      return [
        key,
        list.filter(
          (row) => keyName !== undefined && referenced.has(String(row[keyName]))
        ),
      ]
    })
  )
}

function cutPage(
  catalog: RuntimeCatalog,
  query: Extract<ReadQuery, { limit: number }>,
  data: ReadRowsJson,
  fits: (r: AgentToolResult) => boolean
): AgentToolResult {
  const rows = data.rows ?? []
  const include = "include" in query ? (query.include ?? []) : []
  const offset = query.offset ?? 0
  const build = (n: number): AgentToolSuccess => {
    const kept = rows.slice(0, n)
    const included = keepIncluded(catalog, data, kept, include)
    return {
      state: "done",
      data: {
        ...data,
        rows: kept,
        ...(included === undefined ? {} : { included }),
      },
      truncated: true,
      continuation: { offset: offset + n },
      hint: "The page was cut to fit the size limit. Continue with continuation.offset as offset, or narrow the filter.",
    }
  }
  // Менше одного рядка не лишаємо: порожня сторінка з продовженням
  // зациклила б агента.
  const n = largest(1, rows.length - 1, (k) => fits(build(k)))
  return n === undefined ? tooLarge("row") : build(n)
}

interface CommandResultJson {
  rows: Record<string, unknown>[]
  changes: unknown[]
  epoch: string
  [key: string]: unknown
}

// Після успішного `run` запис закомічено: помилка тут змусила б агента
// повторити пакет (новий корінь, дублікати). Тому результат лише
// урізається, ніколи не стає помилкою.
function cutCommandResult(
  catalog: RuntimeCatalog,
  object: MetadataRef,
  data: CommandResultJson,
  fits: (r: AgentToolResult) => boolean
): AgentToolSuccess {
  const entry = catalog.objects.find(
    (o) => o.kind === object.kind && o.name === object.name
  )
  const slim: CommandResultJson = {
    ...data,
    rows:
      entry === undefined
        ? data.rows
        : data.rows.map((row) => ({
            [entry.keyName]: row[entry.keyName],
            [entry.versionName]: row[entry.versionName],
          })),
  }
  const build = (n: number): AgentToolSuccess => ({
    state: "done",
    data: {
      ...slim,
      rows: slim.rows.slice(0, n),
      changes: slim.changes.slice(0, n),
    },
    truncated: true,
    hint: "The change is committed; the result was cut to fit the size limit. Do not repeat the call: read the rows to see them.",
  })
  const n = largest(0, Math.max(slim.rows.length, slim.changes.length), (k) =>
    fits(build(k))
  )
  return build(n ?? 0)
}

/** The first issue of a failed parse as a catalog error. */
function invalidInput(error: z.ZodError): AgentToolError {
  const issue = error.issues[0]
  const path = issue?.path.join(".") ?? ""
  return agentError(
    "catalog.invalid-input",
    issue?.message ?? "Invalid input",
    {
      path,
    }
  )
}

export interface AgentToolCallOptions {
  core: AgentCore
  catalog: () => RuntimeCatalog
  maxResultChars: number
}

/** The tool layer over the core: parse the input, narrow, call, shape the result. */
export function createToolCaller(
  options: AgentToolCallOptions
): (
  session: SessionClaims,
  name: string,
  input: unknown
) => Promise<AgentToolResult> {
  const { core, maxResultChars } = options
  const fits = (r: AgentToolResult) => renderResult(r).length <= maxResultChars

  async function run(
    session: SessionClaims,
    tool: AgentTool,
    input: unknown
  ): Promise<AgentToolResult> {
    const catalog = options.catalog()
    switch (tool.name) {
      case "describe": {
        const { object } = input as { object?: MetadataRef }
        if (object !== undefined) {
          const full: AgentToolSuccess = {
            state: "done",
            data: core.describe(object),
          }
          return fits(full) ? full : tooLarge("object description")
        }
        const { objects } = core.describe()
        const build = (n: number): AgentToolSuccess =>
          n === objects.length
            ? { state: "done", data: { objects } }
            : {
                state: "done",
                data: { objects: objects.slice(0, n) },
                truncated: true,
                hint: "The list was cut to fit the size limit. Call describe with an object name to see an object.",
              }
        const n = largest(0, objects.length, (k) => fits(build(k)))
        return build(n ?? 0)
      }
      case "read": {
        const { query } = input as { query: ReadQuery }
        const data = (await core.read(session, query)) as ReadRowsJson
        const full: AgentToolSuccess = { state: "done", data }
        if (fits(full)) return full
        if ("limit" in query && Array.isArray(data.rows))
          return cutPage(catalog, query, data, fits)
        return tooLarge("card")
      }
      default: {
        const { operations } = input as { operations: Batch }
        const data = (await core.execute(
          session,
          operations
        )) as CommandResultJson
        const full: AgentToolSuccess = { state: "done", data }
        return fits(full)
          ? full
          : cutCommandResult(catalog, operations[0]!.object, data, fits)
      }
    }
  }

  return async (session, name, input) => {
    const tool = AGENT_TOOLS.find((t) => t.name === name)
    if (tool === undefined)
      return agentError("catalog.unknown-tool", `Unknown tool "${name}"`)
    const parsed = tool.input.safeParse(input)
    if (!parsed.success) return invalidInput(parsed.error)
    try {
      return await run(session, tool, parsed.data)
    } catch (error) {
      if (error instanceof CommandFailure) return failureError(error)
      if (error instanceof AgentUnknownObject)
        return agentError(
          "catalog.unknown-object",
          `Unknown object ${error.object.kind}.${error.object.name}`
        )
      if (error instanceof AgentWriteRefused)
        return agentError(
          "catalog.rights-write-refused",
          `Writing ${error.object.kind}.${error.object.name} changes rights`
        )
      throw error
    }
  }
}
