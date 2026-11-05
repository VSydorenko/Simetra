import {
  COMMAND_SETTING,
  OPERATION_EVENTS,
  batchSchema,
  encodeAttributes,
  isPlainObject,
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
import { decodeRecord } from "./decode"
import { CommandFailure } from "./errors"
import { callHook, type HookPhase } from "./hook-context"
import { ident, issuePath, literal } from "./read"
import type { Statement, Transaction } from "./transaction"
import { encodeItem } from "./values"

/** The catalog entries an operation addresses. */
interface Target {
  object: RuntimeObject
  target: RuntimeOperationTarget
}

/**
 * An operation after {@link prepareInput}: `id` is always there; a scope
 * root `create` also carries the member row id when its kind has a creator.
 * Обидва id T3 генерує раз на `run` (Р-A6-20): повтор бере ті самі, тож
 * `ctx.id` хуків між спробами не змінюється.
 */
export type PreparedOperation = Operation & { id: string; memberId?: string }

/**
 * Створення кореня виду скоупу (спека П4 §6.13); `membership` — довідник
 * членства, коли вид має роль з `rootCreator`.
 */
interface RootCreate {
  membership: RuntimeObject | undefined
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

/** `create` кореня скоупу; `undefined` — звичайна операція. */
function rootCreateOf(
  catalog: RuntimeCatalog,
  object: RuntimeObject,
  op: Operation
): RootCreate | undefined {
  const root =
    op.action === "create" ? object.operations.create?.root : undefined
  if (root === undefined) return undefined
  return {
    // Схема каталогу гарантує, що об'єкт є (`runtimeCatalogSchema`).
    membership:
      root.membership === undefined
        ? undefined
        : catalog.objects.find((o) => o.id === root.membership),
  }
}

const MEMBER = "creatorMember"

/**
 * `creatorMember` тим самим обходом T0, що й `values` (Р-A6-13): дозволені —
 * ключі вставки довідника членства, крім примушених скоупу й користувача
 * (ключ таблиці поза реквізитами й так невідомий обходу).
 */
function encodeMember(membership: RuntimeObject, values: unknown) {
  const forced = membership.attributes
    .filter(
      (a) =>
        a.column === membership.scopeColumn ||
        a.column === membership.membership?.userColumn
    )
    .map((a) => a.name)
  return encodeAttributes(membership.attributes, values, {
    allowed: (a) => a.insert,
    forced,
    path: MEMBER,
    prefix: `${MEMBER}.`,
  })
}

/**
 * Вхід операції з урахуванням кореня скоупу: `id` — лише поза коренем,
 * `tabularSections` кореня на створенні не пишуться, `creatorMember` — лише
 * в кореня з довідником членства. Повертає id, які генерує T3.
 */
function rootInput(
  catalog: RuntimeCatalog,
  object: RuntimeObject,
  op: Operation
): { id: string; memberId?: string } | { error: CommandError } {
  const creation = rootCreateOf(catalog, object, op)
  if (op.action !== "create") return { id: op.id }
  if (creation === undefined) {
    if (op.id === undefined) return { error: invalid("id") }
    if (op.creatorMember !== undefined) return { error: invalid(MEMBER) }
    return { id: op.id }
  }
  if (op.id !== undefined) return { error: invalid("id") }
  if (op.tabularSections !== undefined) {
    return { error: invalid("tabularSections") }
  }
  const { membership } = creation
  if (membership === undefined) {
    return op.creatorMember === undefined
      ? { id: globalThis.crypto.randomUUID() }
      : { error: invalid(MEMBER) }
  }
  const member = encodeMember(membership, op.creatorMember ?? {})
  if ("error" in member) return member
  return {
    id: globalThis.crypto.randomUUID(),
    memberId: globalThis.crypto.randomUUID(),
  }
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
): PreparedOperation[] {
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
  return parsed.data.map((op) => {
    const found = targetOf(catalog, op)
    if ("error" in found) throw new CommandFailure(found.error)
    const ids = rootInput(catalog, found.object, op)
    if ("error" in ids) throw new CommandFailure(ids.error)
    const prepared: PreparedOperation = { ...op, ...ids }
    if (prepared.action === "create" || prepared.action === "update") {
      const encoded = encodeItem(found.object, prepared, draftOf(prepared))
      if ("error" in encoded) throw new CommandFailure(encoded.error)
    }
    return prepared
  })
}

const fn = (target: RuntimeOperationTarget) =>
  `${ident(target.function.schema)}.${ident(target.function.name)}`

/** Виклик функції ядра фази зі зв'язаними параметрами. */
function callOf(
  { object, target }: Target,
  op: PreparedOperation,
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
  draft: unknown,
  path: (key: string) => string = (key) => key
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
  if (bad !== undefined) tx.abort(invalid(path(bad)))
  return draft as Draft<object>
}

/** Фаза `ctx.run`: той самий вхід, що й у команди, — копія й перевірка. */
async function runNested(
  tx: Transaction,
  operation: unknown
): Promise<Record<string, unknown>> {
  let op: PreparedOperation
  try {
    // Пакет — не операція; копія — щоб хук не змінив входу після перевірки.
    if (Array.isArray(operation)) throw new CommandFailure(invalid())
    ;[op] = prepareInput(tx.state.catalog, structuredClone(operation))
  } catch (error) {
    tx.abort(error instanceof CommandFailure ? error.error : invalid())
  }
  return runPhase(tx, op)
}

/** Модуль об'єкта, коли операція піднімає подію запису (Р-A3-2). */
function moduleOf(
  tx: Transaction,
  object: RuntimeObject,
  op: Operation
): ObjectModule<object> | undefined {
  return OPERATION_EVENTS[op.action] === "write"
    ? tx.state.objectModules[`${object.kind}.${object.name}`]
    : undefined
}

const phaseOf = (
  tx: Transaction,
  object: RuntimeObject,
  op: PreparedOperation
): HookPhase => ({
  object,
  op,
  additionalProperties: new Map(),
  runNested: (operation) => runNested(tx, operation),
})

/** `beforeWrite` фази й перевірка повернутої чернетки. */
async function beforeWrite(
  tx: Transaction,
  phase: HookPhase,
  module: ObjectModule<object> | undefined,
  draft: Draft<object>,
  path?: (key: string) => string
): Promise<Draft<object>> {
  if (module?.beforeWrite === undefined) return draft
  const hook = module.beforeWrite.bind(module)
  const returned: unknown = await callHook(tx, phase, (ctx) =>
    hook({ ctx, draft })
  )
  return checkDraft(tx, phase.op, returned, path)
}

/** `onWrite` фази над копією рядка: зміна копії не змінює результату (Р-A3-15). */
async function onWrite(
  tx: Transaction,
  phase: HookPhase,
  module: ObjectModule<object> | undefined,
  row: Record<string, unknown>
): Promise<void> {
  if (module?.onWrite === undefined) return
  const hook = module.onWrite.bind(module)
  await callHook(tx, phase, (ctx) => hook({ ctx, row: structuredClone(row) }))
}

/**
 * One phase: `beforeWrite`, the command context and the core call as one
 * queue unit, the row decoded before `COMMIT`, then `onWrite`. Повертає
 * рядок фази за логічними іменами.
 */
export async function runPhase(
  tx: Transaction,
  op: PreparedOperation
): Promise<Record<string, unknown>> {
  const found = targetOf(tx.state.catalog, op)
  if ("error" in found) tx.abort(found.error)
  const creation = rootCreateOf(tx.state.catalog, found.object, op)
  if (creation !== undefined) return runRootPhase(tx, found, op, creation)
  const { object } = found
  // Подію визначає операція (Р-A3-2): `delete` хуків не викликає.
  const module = moduleOf(tx, object, op)
  const phase = phaseOf(tx, object, op)
  // Контекст фази ставиться після хука «до» (Рт5): фаза його `ctx.run`
  // ставить свій раніше.
  const draft = await beforeWrite(tx, phase, module, draftOf(op))
  const call = callOf(found, op, draft)
  if ("error" in call) tx.abort(call.error)
  const text = await callCore(tx, found, op, call)
  const row = decodeCoreRow(tx, object, () => JSON.parse(text) as unknown)
  recordChange(tx, object, op, row)
  await onWrite(tx, phase, module, row.row)
  return row.row
}

/**
 * Створення тенанта (спека П4 §6.13, Р-A6-14): `beforeWrite` кореня →
 * `beforeWrite` довідника членства над `{ values: creatorMember }` → повторна
 * перевірка обох чернеток → контекст кореня й ядро `<корінь>_create_root`
 * однією одиницею черги → `onWrite` кореня → `onWrite` членства. Набір змін —
 * один запис фази кореня, результат — рядок кореня.
 */
async function runRootPhase(
  tx: Transaction,
  found: Target,
  op: PreparedOperation,
  { membership }: RootCreate
): Promise<Record<string, unknown>> {
  const { object, target } = found
  if (op.action !== "create") throw new Error("internal: root phase")
  const module = moduleOf(tx, object, op)
  const phase = phaseOf(tx, object, op)
  const draft = await beforeWrite(tx, phase, module, draftOf(op))
  let member:
    | {
        object: RuntimeObject
        module: ObjectModule<object> | undefined
        phase: HookPhase
        draft: Draft<object>
      }
    | undefined
  if (membership !== undefined) {
    if (op.memberId === undefined) throw new Error("internal: member id")
    const memberOp: PreparedOperation = {
      action: "create",
      object: { kind: membership.kind, name: membership.name },
      id: op.memberId,
      values: op.creatorMember ?? {},
    }
    const memberModule = moduleOf(tx, membership, memberOp)
    const memberPhase = phaseOf(tx, membership, memberOp)
    member = {
      object: membership,
      module: memberModule,
      phase: memberPhase,
      // Ключ поза чернеткою — дефект `creatorMember`, а не входу кореня.
      draft: await beforeWrite(
        tx,
        memberPhase,
        memberModule,
        draftOf(memberOp),
        () => MEMBER
      ),
    }
  }
  // Повторна перевірка обох чернеток: хук міг повернути ТЧ.
  if (draft.tabularSections !== undefined) tx.abort(invalid("tabularSections"))
  let memberColumns: Record<string, unknown> | undefined
  if (member !== undefined) {
    if (member.draft.tabularSections !== undefined) tx.abort(invalid(MEMBER))
    const encoded = encodeMember(member.object, member.draft.values ?? {})
    if ("error" in encoded) tx.abort(encoded.error)
    memberColumns = encoded.columns
  }
  const encoded = encodeItem(object, op, draft)
  if ("error" in encoded) tx.abort(encoded.error)
  const call: Statement = {
    text: `SELECT ${fn(target)}($1::jsonb, $2::jsonb, $3::uuid) AS r`,
    params: [
      JSON.stringify(encoded.item),
      // Вид без творця: обидва аргументи членства — `NULL` (спека П4 §6.13).
      memberColumns === undefined ? null : JSON.stringify(memberColumns),
      op.memberId ?? null,
    ],
  }
  const text = await callCore(tx, found, op, call, membership)
  let result: unknown
  const rootRow = decodeCoreRow(tx, object, () => {
    result = JSON.parse(text)
    if (!isPlainObject(result)) throw new Error("root core result")
    return result.root
  })
  recordChange(tx, object, op, rootRow)
  let memberRow: Record<string, unknown> | undefined
  if (member !== undefined) {
    const { object: memberObject } = member
    memberRow = decodeCoreRow(
      tx,
      memberObject,
      () => (result as Record<string, unknown>).member
    ).row
  } else if ((result as Record<string, unknown>).member !== null) {
    coreAnomaly(tx, object)
  }
  await onWrite(tx, phase, module, rootRow.row)
  if (member !== undefined) {
    await onWrite(tx, member.phase, member.module, memberRow!)
  }
  return rootRow.row
}

/**
 * Контекст і виклик ядра — неподільна одиниця черги (Рт5, Р-A3-15): між
 * ними не стане оператор іншої фази. Повертає текст рядка ядра.
 */
async function callCore(
  tx: Transaction,
  { object, target }: Target,
  op: PreparedOperation,
  call: Statement,
  membership?: RuntimeObject
): Promise<string> {
  const context: CommandContext = {
    action: target.context,
    object: object.kindLabel,
    root: op.id,
  }
  const { rows } = await tx.enqueue(
    [{ text: CONTEXT_TEXT, params: [JSON.stringify(context)] }, call],
    {
      kind: "write",
      object,
      operation: op.action,
      ...(membership === undefined ? {} : { membership }),
    }
  )
  const text = rows[0]?.r
  if (typeof text !== "string") coreAnomaly(tx, object)
  return text
}

/** Відповідь бази не тієї форми — аномалія: назовні код, у журнал — подробиці. */
function coreAnomaly(
  tx: Transaction,
  object: RuntimeObject,
  cause?: unknown
): never {
  tx.anomaly(
    new Error(
      `core row of ${object.kind}.${object.name} does not match the catalog`,
      { cause }
    )
  )
}

/** Рядок ядра за каталогом: ключ, версія й скоуп мусять бути. */
function decodeCoreRow(
  tx: Transaction,
  object: RuntimeObject,
  parse: () => unknown
): { row: Record<string, unknown>; scope: unknown } {
  let row: Record<string, unknown>
  let scope: unknown
  try {
    const raw = parse()
    row = decodeRecord(object, raw)
    scope =
      object.scopeColumn === undefined
        ? undefined
        : (raw as Record<string, unknown>)[object.scopeColumn]
  } catch (error) {
    coreAnomaly(tx, object, error)
  }
  if (
    typeof row[object.keyName] !== "string" ||
    typeof row[object.versionName] !== "number" ||
    (object.scopeColumn !== undefined && typeof scope !== "string")
  ) {
    coreAnomaly(tx, object)
  }
  return { row, scope }
}

function recordChange(
  tx: Transaction,
  object: RuntimeObject,
  op: Operation,
  { row, scope }: { row: Record<string, unknown>; scope: unknown }
): void {
  tx.changes.push({
    object: { kind: object.kind, name: object.name },
    ...(object.scopeKindId === undefined
      ? {}
      : { scopeKind: object.scopeKindId }),
    ...(typeof scope === "string" ? { scope } : {}),
    id: row[object.keyName] as string,
    version: row[object.versionName] as number,
    operation: op.action,
  })
}
