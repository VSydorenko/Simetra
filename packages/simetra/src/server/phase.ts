import {
  COMMAND_SETTING,
  batchSchema,
  operationSchema,
  type CommandContext,
  type CommandError,
  type Operation,
  type RuntimeCatalog,
  type RuntimeObject,
  type RuntimeOperationTarget,
} from "simetra/model"
import type { z } from "zod"
import { decodeRow } from "./decode"
import { CommandFailure } from "./errors"
import { ident, literal } from "./read"
import type { Statement, Transaction } from "./transaction"
import { encodeItem } from "./values"

/** The catalog entries an operation addresses. */
interface Target {
  object: RuntimeObject
  target: RuntimeOperationTarget
}

const invalid = (path?: string): CommandError => ({
  code: "command.invalid",
  ...(path === undefined ? {} : { path }),
})

function targetOf(
  catalog: RuntimeCatalog,
  op: Operation
): Target | { error: CommandError } {
  const object = catalog.objects.find(
    (o) => o.kind === op.object.kind && o.name === op.object.name
  )
  if (object === undefined) return { error: invalid("object") }
  // Функцію ядра й дію контексту дає каталог, а не вхід (Р-A3-1): операції
  // без функції в каталозі в цього об'єкта немає.
  const target = object.operations[op.action]
  if (target === undefined) return { error: invalid("action") }
  return { object, target }
}

const draftOf = (op: Operation) =>
  op.action === "create" || op.action === "update"
    ? { values: op.values, tabularSections: op.tabularSections }
    : {}

function issuePath(error: z.ZodError): string | undefined {
  const [issue] = error.issues
  return issue === undefined || issue.path.length === 0
    ? undefined
    : issue.path.join(".")
}

/**
 * Перевірка до транзакції (спека П4 §6.5): схема операції, об'єкт і операція
 * каталогу, значення за каталогом — без звернення до бази.
 */
export function prepareInput(
  catalog: RuntimeCatalog,
  input: unknown
): Operation[] {
  let parsed: ReturnType<typeof batchSchema.safeParse>
  try {
    parsed = Array.isArray(input)
      ? batchSchema.safeParse(input)
      : operationSchema.transform((op) => [op]).safeParse(input)
  } catch {
    // Геттер, що кидає, чи відкликаний `Proxy` у вході.
    throw new CommandFailure(invalid())
  }
  if (!parsed.success) {
    throw new CommandFailure(invalid(issuePath(parsed.error)))
  }
  for (const op of parsed.data) {
    const found = targetOf(catalog, op)
    if ("error" in found) throw new CommandFailure(found.error)
    if (op.action === "create" || op.action === "update") {
      const encoded = encodeItem(found.object, op, draftOf(op))
      if ("error" in encoded) throw new CommandFailure(encoded.error)
    }
  }
  return parsed.data
}

const fn = (target: RuntimeOperationTarget) =>
  `${ident(target.function.schema)}.${ident(target.function.name)}`

/** Виклик функції ядра фази зі зв'язаними параметрами. */
function callOf(
  { object, target }: Target,
  op: Operation
): Statement | { error: CommandError } {
  switch (op.action) {
    case "create":
    case "update": {
      const encoded = encodeItem(object, op, draftOf(op))
      if ("error" in encoded) return encoded
      return {
        text: `SELECT ${fn(target)}($1::jsonb, $2::bigint) AS r`,
        params: [
          JSON.stringify(encoded.item),
          // `create` завжди передає ядру `NULL` (Р-A3-1).
          op.action === "create" ? null : String(op.expectedVersion),
        ],
      }
    }
    case "markDeletion":
      return {
        text: `SELECT ${fn(target)}($1::uuid, $2::bigint, $3::boolean) AS r`,
        params: [op.id, String(op.expectedVersion), String(op.mark)],
      }
    case "delete":
      return {
        text: `SELECT ${fn(target)}($1::uuid, $2::bigint) AS r`,
        params: [op.id, String(op.expectedVersion)],
      }
  }
}

const CONTEXT_TEXT = `SELECT set_config(${literal(COMMAND_SETTING)}, $1, true)`

/**
 * One phase: the command context and the core call as one queue unit, then
 * the row decoded before `COMMIT`. Повертає рядок фази за логічними іменами.
 */
export async function runPhase(
  tx: Transaction,
  op: Operation
): Promise<Record<string, unknown>> {
  const found = targetOf(tx.state.catalog, op)
  if ("error" in found) tx.abort(found.error)
  const { object, target } = found
  const call = callOf(found, op)
  if ("error" in call) tx.abort(call.error)
  const context: CommandContext = {
    action: target.context,
    object: object.kindLabel,
    root: op.id,
  }
  // Контекст і виклик ядра — неподільна одиниця черги (Рт5, Р-A3-15): між
  // ними не стане оператор іншої фази.
  const { rows } = await tx.enqueue(
    [{ text: CONTEXT_TEXT, params: [JSON.stringify(context)] }, call],
    { kind: "write", object, operation: op.action }
  )
  const text = rows[0]?.r
  if (typeof text !== "string") tx.abort({ code: "command.internal" })
  let row: Record<string, unknown>
  let scope: unknown
  try {
    row = decodeRow(object, text)
    scope =
      object.scopeColumn === undefined
        ? undefined
        : (JSON.parse(text) as Record<string, unknown>)[object.scopeColumn]
  } catch (error) {
    tx.abort(
      error instanceof CommandFailure
        ? error.error
        : { code: "command.internal" }
    )
  }
  const id = row[object.keyName]
  const version = row[object.versionName]
  if (
    typeof id !== "string" ||
    typeof version !== "number" ||
    (object.scopeColumn !== undefined && typeof scope !== "string")
  ) {
    tx.abort({ code: "command.internal" })
  }
  tx.changes.push({
    object: { kind: object.kind, name: object.name },
    ...(object.scopeKindId === undefined
      ? {}
      : { scopeKind: object.scopeKindId }),
    ...(typeof scope === "string" ? { scope } : {}),
    id,
    version,
    operation: op.action,
  })
  return row
}
