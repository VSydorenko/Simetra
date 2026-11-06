import {
  buildRuntimeCatalog,
  compile,
  diagnostic,
  type CompiledModel,
} from "simetra/compiler"
import {
  batchSchema,
  readQuerySchema,
  type Change,
  type CommandError,
  type SessionClaims,
  CommandFailure,
} from "simetra/model"
import {
  createCommandRuntime,
  type CommandRuntime,
  type LogEntry,
} from "simetra/server"
import { z } from "zod"
import { DataFailure, withData } from "../io/data"
import { readMetadataDir } from "../io/metadata-dir"
import { dataCommandRefusal } from "./data-policy"
import {
  defineTool,
  type DataResource,
  type RunOutcome,
  type ToolContext,
} from "./types"

/** Рядок результату для JSON: `bigint` — десятковим рядком (Р-A5-13). */
export type JsonRow = Record<string, unknown>

export interface JsonCommandResult {
  rows: JsonRow[]
  changes: Change[]
}

export type DataReadData = { rows: JsonRow[] } | { error: CommandError }
export type DataCommandData =
  { result: JsonCommandResult } | { error: CommandError }

/**
 * JSON не має `bigint`, а формат передачі клієнтам — справа П4-B: інструмент
 * не клієнт П4-B, тож віддає десятковий рядок, який вхід `BigInt` T0 уже
 * приймає назад.
 */
export function toJson(value: unknown): unknown {
  if (typeof value === "bigint") return String(value)
  if (Array.isArray(value)) return value.map(toJson)
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, toJson(v)])
    )
  return value
}

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

type Compiled = { model: CompiledModel } | { failed: RunOutcome<never> }

/**
 * Компіляція на кожен виклик (Р-A5-5): зміна теки між викликами дає нову
 * модель, і рантайм звіряє її хеш із застосованим — кешу, який треба
 * інвалідувати, немає.
 */
async function compileDir(dir: string): Promise<Compiled> {
  const compiled = await compile(await readMetadataDir(dir))
  if (compiled.model === undefined)
    return {
      failed: { ok: false, changes: [], diagnostics: compiled.diagnostics },
    }
  return { model: compiled.model }
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
  act: (runtime: CommandRuntime, session: SessionClaims) => Promise<D>
): Promise<RunOutcome<D | { error: CommandError }>> {
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
    return { ok: ran.ok, changes: [], diagnostics: [], data: ran.data }
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
    "Read application data of the development database as the user given by --as, with that user's rights: one row by id, or a page of rows by equality filter (where, after, limit up to 200). BigInt values come as decimal strings. A runtime error comes as data.error with a code.",
  input: z.strictObject({ query: readQuerySchema }),
  files: "read",
  database: "none",
  data: "read",
  destructive: false,
  async run(ctx, input): Promise<RunOutcome<DataReadData>> {
    const compiled = await compileDir(ctx.dir)
    if ("failed" in compiled) return compiled.failed
    return onRuntime("data-read", ctx, compiled.model, async (rt, session) => ({
      rows: toJson(await rt.read(session, input.query)) as JsonRow[],
    }))
  },
})

export const dataCommandTool = defineTool({
  name: "data-command",
  description:
    "Change application data of the development database as the user given by --as, with that user's rights: a batch of create, update, markDeletion and delete operations in one transaction (update, markDeletion and delete need expectedVersion). Rights catalogs and create of a scope root whose creator gets a role need --allow-rights-write; objects with a module are refused, and for such a root also when its membership catalog has one. BigInt values may be passed as decimal strings. A runtime error comes as data.error with a code.",
  input: z.strictObject({ operations: batchSchema }),
  files: "read",
  database: "none",
  data: "write",
  destructive: false,
  async run(ctx, input): Promise<RunOutcome<DataCommandData>> {
    const compiled = await compileDir(ctx.dir)
    if ("failed" in compiled) return compiled.failed
    const { model } = compiled
    // Політика — до з'єднання: база не бачить пакета, якому відмовлено
    const refusal = dataCommandRefusal(
      model,
      buildRuntimeCatalog(model),
      input.operations,
      {
        allowRightsWrite: ctx.allowRightsWrite === true,
      }
    )
    if (refusal?.kind === "command")
      return {
        ok: false,
        changes: [],
        diagnostics: [],
        data: { error: refusal.error },
      }
    if (refusal?.kind === "rights")
      return {
        ok: false,
        changes: [],
        diagnostics: [],
        refusalReason: "rights-write-disabled",
      }
    return onRuntime("data-command", ctx, model, async (rt, session) => {
      const result = await rt.run(session, input.operations)
      return { result: toJson(result) as JsonCommandResult }
    })
  },
})
