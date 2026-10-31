import {
  COMMAND_SETTING,
  OPERATION_EVENTS,
  batchSchema,
  operationSchema,
  type CommandContext,
  type CommandError,
  type Draft,
  type ObjectModule,
  type Operation,
  type RuntimeCatalog,
  type RuntimeObject,
  type RuntimeOperationTarget,
} from "simetra/model"
import { decodeRow } from "./decode"
import { CommandFailure } from "./errors"
import { callHook, type HookPhase } from "./hook-context"
import { ident, issuePath, literal } from "./read"
import type { Statement, Transaction } from "./transaction"
import { encodeItem, isPlainObject } from "./values"

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

// Без ключів зі значенням `undefined`: чернетку, яку хук повернув як є,
// перевірка не відкине.
const draftOf = (op: Operation): Draft<object> =>
  op.action === "create" || op.action === "update"
    ? {
        ...(op.values === undefined ? {} : { values: op.values }),
        ...(op.tabularSections === undefined
          ? {}
          : { tabularSections: op.tabularSections }),
      }
    : {}

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
  op: Operation,
  draft: Draft<object>
): Statement | { error: CommandError } {
  switch (op.action) {
    case "create":
    case "update": {
      const encoded = encodeItem(object, op, draft)
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
 * Чернетка хука «до» — та сама перевірка, що й вхід (спека П4 §6.5): ключі
 * поза чернеткою — `command.invalid`; значення перевіряє `encodeItem`.
 * Чернетка `markDeletion` порожня: позначку хук бачить у `ctx.mark` (Р-A3-18).
 */
function checkDraft(
  tx: Transaction,
  op: Operation,
  draft: unknown
): Draft<object> {
  const keys = op.action === "markDeletion" ? [] : ["values", "tabularSections"]
  let bad: string | undefined
  try {
    if (!isPlainObject(draft)) {
      throw new Error("beforeWrite returned no draft object")
    }
    bad = Object.keys(draft).find(
      (key) => !keys.includes(key) || draft[key] === undefined
    )
  } catch (error) {
    // Не об'єкт чи `Proxy`, що кидає, — дефект хука, а не бази.
    tx.state.log({ kind: "hook", error })
    tx.abort({ code: "command.internal" })
  }
  if (bad !== undefined) tx.abort(invalid(bad))
  return draft as Draft<object>
}

/** Фаза `ctx.run`: той самий вхід, що й у команди, — копія й перевірка. */
async function runNested(
  tx: Transaction,
  operation: unknown
): Promise<Record<string, unknown>> {
  let op: Operation
  try {
    // Пакет — не операція; копія — щоб хук не змінив входу після перевірки.
    if (Array.isArray(operation)) throw new CommandFailure(invalid())
    ;[op] = prepareInput(tx.state.catalog, structuredClone(operation))
  } catch (error) {
    tx.abort(error instanceof CommandFailure ? error.error : invalid())
  }
  return runPhase(tx, op)
}

/**
 * One phase: `beforeWrite`, the command context and the core call as one
 * queue unit, the row decoded before `COMMIT`, then `onWrite`. Повертає
 * рядок фази за логічними іменами.
 */
export async function runPhase(
  tx: Transaction,
  op: Operation
): Promise<Record<string, unknown>> {
  const found = targetOf(tx.state.catalog, op)
  if ("error" in found) tx.abort(found.error)
  const { object, target } = found
  // Подію визначає операція (Р-A3-2): `delete` хуків не викликає.
  const module: ObjectModule<object> | undefined =
    OPERATION_EVENTS[op.action] === "write"
      ? tx.state.objectModules[`${object.kind}.${object.name}`]
      : undefined
  const phase: HookPhase = {
    object,
    op,
    additionalProperties: new Map(),
    runNested: (operation) => runNested(tx, operation),
  }
  let draft = draftOf(op)
  if (module?.beforeWrite !== undefined) {
    const beforeWrite = module.beforeWrite.bind(module)
    // Контекст фази ставиться після хука «до» (Рт5): фаза його `ctx.run`
    // ставить свій раніше.
    const returned: unknown = await callHook(tx, phase, (ctx) =>
      beforeWrite({ ctx, draft })
    )
    draft = checkDraft(tx, op, returned)
  }
  const call = callOf(found, op, draft)
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
  // Відповідь бази не тієї форми — аномалія: назовні код, у журнал — подробиці.
  const anomaly: (cause?: unknown) => never = (cause) =>
    tx.anomaly(
      new Error(
        `core row of ${object.kind}.${object.name} does not match the catalog`,
        { cause }
      )
    )
  if (typeof text !== "string") anomaly()
  let row: Record<string, unknown>
  let scope: unknown
  try {
    row = decodeRow(object, text)
    scope =
      object.scopeColumn === undefined
        ? undefined
        : (JSON.parse(text) as Record<string, unknown>)[object.scopeColumn]
  } catch (error) {
    anomaly(error)
  }
  const id = row[object.keyName]
  const version = row[object.versionName]
  if (
    typeof id !== "string" ||
    typeof version !== "number" ||
    (object.scopeColumn !== undefined && typeof scope !== "string")
  ) {
    anomaly()
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
  if (module?.onWrite !== undefined) {
    const onWrite = module.onWrite.bind(module)
    // Копія: зміна рядка хуком не змінює результату команди (Р-A3-15).
    await callHook(tx, phase, (ctx) =>
      onWrite({ ctx, row: structuredClone(row) })
    )
  }
  return row
}
