import {
  buildRuntimeCatalog,
  compile,
  diagnostic,
  type CompiledModel,
  type Diagnostic,
} from "simetra/compiler"
import {
  batchSchema,
  readQuerySchema,
  type Change,
  type CommandError,
  type MetadataRef,
  type ReadCount,
  type SessionClaims,
  CommandFailure,
} from "simetra/model"
import {
  createAgentCore,
  createCommandRuntime,
  toJson,
  type CommandRuntime,
  type LogEntry,
} from "simetra/server"
import { z } from "zod"
import { DataFailure, withData } from "../io/data"
import { readMetadataDir } from "../io/metadata-dir"
import { dataPolicyRefusal } from "./data-policy"
import {
  defineTool,
  type DataResource,
  type RunOutcome,
  type ToolContext,
} from "./types"

/** Рядок результату для JSON: `bigint` — десятковим рядком, бо JSON не має `bigint`. */
export type JsonRow = Record<string, unknown>

export interface JsonCommandResult {
  rows: JsonRow[]
  changes: Change[]
  /** Row version epoch read in the command transaction; `null` — the database has no epoch. */
  epoch: string | null
}

/** A read result for JSON: rows with `bigint` as decimal strings, or a count. */
export type JsonReadResult =
  | {
      rows: JsonRow[]
      included?: Record<string, JsonRow[]>
      ownerVersion?: number
    }
  | ReadCount

export type DataReadData = JsonReadResult | { error: CommandError }
export type DataCommandData =
  { result: JsonCommandResult } | { error: CommandError }

/**
 * Зведення результату даних для тексту MCP і CLI: кількість рядків чи змін
 * або код помилки T3 з причиною — повні дані йдуть у структурований вивід.
 */
export function summarizeData(
  name: string,
  data: DataReadData | DataCommandData
): string {
  if ("error" in data)
    return `${name}: ${data.error.code}${data.error.reason === undefined ? "" : `: ${data.error.reason}`}`
  const count = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"}`
  if ("count" in data)
    return `${name}: ${data.capped === true ? "over " : ""}${count(data.count, "row")} counted`
  return "rows" in data
    ? `${name}: ${count(data.rows.length, "row")}`
    : `${name}: ${count(data.result.changes.length, "change")}`
}

const SQLSTATE = /^[0-9A-Z]{5}$/

/**
 * Журнал рантайму: T3 кладе сюди сирий виняток бази, а stderr MCP-сервера
 * йде в журнали клієнта. Тож лише вид запису, SQLSTATE і таблиця — ні
 * тексту, ні `detail`, де Postgres цитує значення й ім'я входу. Stdout —
 * канал протоколу MCP, туди не пишемо нічого.
 */
export function logRuntimeEntry(entry: LogEntry): void {
  const error = entry.error as { code?: unknown; table?: unknown } | null
  const code =
    typeof error?.code === "string" && SQLSTATE.test(error.code)
      ? ` SQLSTATE ${error.code}`
      : ""
  // Ідентифікатор Postgres може містити перенос рядка: сирим він підробив би
  // рядки журналу, тож — як рядок JSON
  const table =
    typeof error?.table === "string"
      ? ` table ${JSON.stringify(error.table)}`
      : ""
  process.stderr.write(`simetra: runtime ${entry.kind} error${code}${table}\n`)
}

function required(data: DataResource | undefined): DataResource {
  if (data === undefined)
    throw new Error("invoke passes the data resource to a data tool")
  return data
}

type Compiled =
  | { model: CompiledModel; diagnostics: Diagnostic[] }
  | { failed: RunOutcome<never, "read"> }

/**
 * Попередження компіляції, що стосуються об'єктів операції, і жодних
 * чужих: успішна модель може нести попередження про інші об'єкти проєкту, а
 * агентові по даних одного об'єкта вони лише шум. Об'єкт знаходиться за
 * файлом діагностики; невідомий об'єкт (його відхилить схема T3) нічого не
 * додає.
 */
export function warningsFor(
  model: CompiledModel,
  diagnostics: readonly Diagnostic[],
  objects: readonly MetadataRef[]
): Diagnostic[] {
  const files = new Set(
    model.objects
      .filter((x) =>
        objects.some((o) => o.kind === x.kind && o.name === x.name)
      )
      .map((x) => x.file)
  )
  return diagnostics.filter(
    (d) => d.severity === "warning" && files.has(d.file)
  )
}

/**
 * Компіляція на кожен виклик (спека П4 §6.14): зміна теки між викликами дає нову
 * модель, і рантайм звіряє її хеш із застосованим — кешу, який треба
 * інвалідувати, немає.
 */
async function compileDir(dir: string): Promise<Compiled> {
  const compiled = await compile(await readMetadataDir(dir))
  if (compiled.model === undefined)
    return {
      failed: { ok: false, changes: [], diagnostics: compiled.diagnostics },
    }
  return { model: compiled.model, diagnostics: compiled.diagnostics }
}

/**
 * Рантайм на виклик: пул ролі входу, звірка хешу, дія й закриття пулу
 * (`withData`). `CommandFailure` — відповідь T3, тож дані результату, а не
 * збій; збій бази — `database.failed` лише з адресою й кодом.
 */
async function onRuntime<D>(
  tool: string,
  ctx: ToolContext,
  model: CompiledModel,
  warnings: Diagnostic[],
  act: (runtime: CommandRuntime, session: SessionClaims) => Promise<D>
): Promise<RunOutcome<D | { error: CommandError }, "read">> {
  try {
    const ran = await withData(
      required(ctx.data),
      model.project.database.provider,
      async (s) => {
        try {
          const runtime = await createCommandRuntime({
            database: s.database,
            catalog: buildRuntimeCatalog(model),
            log: logRuntimeEntry,
          })
          return { ok: true, data: await act(runtime, s.session) }
        } catch (error) {
          if (error instanceof CommandFailure)
            return { ok: false, data: { error: error.error } }
          throw error
        }
      }
    )
    return { ok: ran.ok, changes: [], diagnostics: warnings, data: ran.data }
  } catch (error) {
    if (error instanceof DataFailure)
      return {
        ok: false,
        changes: [],
        diagnostics: [
          diagnostic("database.failed", "", "", { tool, ...error.params }),
        ],
      }
    throw error
  }
}

export const dataReadTool = defineTool({
  name: "data-read",
  description:
    "Reads rows under RLS as the user given by --as: a card by id, a page by filter tree (where, orderBy, offset, limit up to 200) or a capped count. A card may carry its tabular sections; a card or a page may include the target rows of Ref attributes. A tabular section reads as the lines of one owner (with ownerVersion), a page or a count. BigInt values come as decimal strings. A runtime error comes as data.error with a code.",
  input: z.strictObject({ query: readQuerySchema }),
  files: "read",
  database: "none",
  data: "read",
  destructive: false,
  async run(ctx, input): Promise<RunOutcome<DataReadData, "read">> {
    const compiled = await compileDir(ctx.dir)
    if ("failed" in compiled) return compiled.failed
    return onRuntime(
      "data-read",
      ctx,
      compiled.model,
      warningsFor(compiled.model, compiled.diagnostics, [input.query.object]),
      async (rt, session) =>
        (await createAgentCore({ runtime: rt }).read(
          session,
          input.query
        )) as JsonReadResult
    )
  },
  present: {
    structure: (data) => toJson(data) as Record<string, unknown>,
    // Попередження про об'єкти операції — після зведення, як звіт інших
    // інструментів
    text: (data, v) =>
      data === undefined
        ? undefined
        : [
            summarizeData("data-read", data),
            ...(v.diagnostics.length > 0 ? [v.report] : []),
          ].join("\n"),
  },
})

export const dataCommandTool = defineTool({
  name: "data-command",
  description:
    "Change application data of the development database as the user given by --as, with that user's rights: a batch of create, update, markDeletion and delete operations in one transaction (update, markDeletion and delete need expectedVersion). A tabular section array in update replaces the section: every existing row must be in the array or in deleteIds. Rights catalogs and create of a scope root whose creator gets a role need --allow-rights-write; objects with a module are refused, and for such a root also when its membership catalog has one. BigInt values may be passed as decimal strings. Each result row has the shape of a read card: the tabular sections the operation wrote come under tabularSections. A runtime error comes as data.error with a code.",
  input: z.strictObject({ operations: batchSchema }),
  files: "read",
  database: "none",
  data: "write",
  destructive: false,
  async run(ctx, input): Promise<RunOutcome<DataCommandData, "read">> {
    const compiled = await compileDir(ctx.dir)
    if ("failed" in compiled) return compiled.failed
    const { model } = compiled
    const warnings = warningsFor(
      model,
      compiled.diagnostics,
      input.operations.map((op) => op.object)
    )
    const catalog = buildRuntimeCatalog(model)
    // Політика — до з'єднання: база не бачить пакета, якому відмовлено
    const rightsWrite = ctx.allowRightsWrite === true
    const refusal = dataPolicyRefusal(model, catalog, input.operations, {
      rightsWrite,
    })
    if (refusal?.kind === "command")
      return {
        ok: false,
        changes: [],
        diagnostics: [],
        data: { error: refusal.error },
      }
    if (refusal !== undefined)
      return {
        ok: false,
        changes: [],
        diagnostics: [],
        refusalReason: "rights-write-disabled",
      }
    return onRuntime(
      "data-command",
      ctx,
      model,
      warnings,
      async (rt, session) => {
        const result = await createAgentCore({
          runtime: rt,
          permissions: { rightsWrite },
        }).execute(session, input.operations)
        return { result: result as JsonCommandResult }
      }
    )
  },
  present: {
    structure: (data) => toJson(data) as Record<string, unknown>,
    // Попередження про об'єкти операції — після зведення, як звіт інших
    // інструментів
    text: (data, v) =>
      data === undefined
        ? undefined
        : [
            summarizeData("data-command", data),
            ...(v.diagnostics.length > 0 ? [v.report] : []),
          ].join("\n"),
  },
})
