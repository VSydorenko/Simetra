import {
  COMMAND_SETTING,
  LIMIT_REASONS,
  OPERATION_EVENTS,
  batchSchema,
  encodeAttributes,
  isPlainObject,
  metadataRefSchema,
  operationSchema,
  type CommandContext,
  type CommandError,
  type Draft,
  type MetadataRef,
  type ObjectModule,
  type Operation,
  type RuntimeCatalog,
  type RuntimeObject,
  type RuntimeOperationTarget,
  type RuntimeSection,
  CommandFailure,
} from "simetra/model"
import { decodeRecord } from "./decode"
import { callHook, type HookPhase } from "./hook-context"
import type { z } from "zod"
import { decidingIssue, ident, issuePath, issueReason, literal } from "./read"
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
  const target = object.operations?.[op.action]
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
    op.action === "create" ? object.operations?.create?.root : undefined
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
    maxBytes: true,
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
 * Об'єкт операції, що відмовила, — лише відомий каталогу: сирий вхід не
 * проходив схеми, тож назовні не йде нічого, чого не знає модель. Читання —
 * у `try`: геттер чи `Proxy` у вході може кинути.
 */
function rejectedObject(
  catalog: RuntimeCatalog,
  op: unknown
): MetadataRef | undefined {
  try {
    const ref = metadataRefSchema.safeParse(
      (op as { object?: unknown } | null | undefined)?.object
    )
    if (!ref.success) return undefined
    const known = catalog.objects.some(
      (o) => o.kind === ref.data.kind && o.name === ref.data.name
    )
    return known ? ref.data : undefined
  } catch {
    return undefined
  }
}

/**
 * `command.invalid` відмови схеми з причиною межі. Шлях ТЧ понад межу — її
 * логічне ім'я, як у решти помилок ТЧ, без префікса й індексу пакета;
 * операцію пакета називає `object`. Пакет понад межу — без шляху: це корінь.
 */
function schemaRefusal(
  catalog: RuntimeCatalog,
  input: unknown,
  error: z.ZodError
): CommandError {
  const reason = issueReason(error)
  if (reason === LIMIT_REASONS.tabularTooLarge) {
    const path = decidingIssue(error)?.path ?? []
    const [index] = path
    let op: unknown = input
    if (typeof index === "number") {
      try {
        op = (input as unknown[])[index]
      } catch {
        op = undefined
      }
    }
    const object = rejectedObject(catalog, op)
    return {
      code: "command.invalid",
      reason,
      path: String(path.at(-1)),
      ...(object === undefined ? {} : { object }),
    }
  }
  return {
    ...invalid(issuePath(error)),
    ...(reason === undefined ? {} : { reason }),
  }
}

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
    throw new CommandFailure(schemaRefusal(catalog, input, parsed.error))
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
      const overlap = deleteOverlapOf(found.object, prepared)
      if (overlap !== undefined) throw new CommandFailure(invalid(overlap))
    }
    return prepared
  })
}

/** Ключ рядка ТЧ для порівняння: Postgres рівняє UUID без огляду на регістр. */
const rowIdOf = (section: RuntimeSection, row: Record<string, unknown>) =>
  String(row[section.keyName]).toLowerCase()

/**
 * Шлях першого id, що водночас у масиві ТЧ і в `deleteIds`: рядок не може
 * лишитися й бути видаленим. Ключі рядків уже перевірив `encodeItem`.
 */
function deleteOverlapOf(
  object: RuntimeObject,
  op: Operation
): string | undefined {
  if (op.action !== "update" || op.deleteIds === undefined) return undefined
  for (const [name, ids] of Object.entries(op.deleteIds)) {
    const section = object.tabularSections.find((s) => s.name === name)
    if (section === undefined) continue
    const kept = new Set(
      (op.tabularSections?.[name] ?? []).map((row) => rowIdOf(section, row))
    )
    const i = ids.findIndex((id) => kept.has(id.toLowerCase()))
    if (i !== -1) return `deleteIds.${name}.${i}`
  }
  return undefined
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

/** Оператор контексту команди фази (Рт5): той самий перед перевіркою ТЧ і ядром. */
function contextOf(
  { object, target }: Target,
  op: PreparedOperation
): Statement {
  const context: CommandContext = {
    action: target.context,
    object: object.kindLabel,
    root: op.id,
  }
  return { text: CONTEXT_TEXT, params: [JSON.stringify(context)] }
}

const tableOf = ({ schema, name }: { schema: string; name: string }) =>
  `${ident(schema)}.${ident(name)}`

/**
 * Оператор перевірки однієї ТЧ: версія власника й перший наявний рядок, якого
 * немає ні в масиві, ні в `deleteIds`. ТЧ корелює з власником за всіма
 * колонками FK `parentConstraint`; параметр на id, порожній набір —
 * `'{}'::uuid[]` (`ARRAY[]` без типу — синтаксична помилка).
 */
function tabularCheckOf(
  object: RuntimeObject,
  section: RuntimeSection,
  op: PreparedOperation,
  ids: readonly string[]
): Statement {
  // Схема каталогу гарантує FK з `references` (`runtimeSectionSchema`).
  const fk = section.constraints.find(
    (c) => c.name === section.parentConstraint
  )!
  const on = fk.columns
    .map((c, i) => `s.${ident(c)} = o.${ident(fk.references![i]!)}`)
    .join(" AND ")
  const set =
    ids.length === 0
      ? "'{}'::uuid[]"
      : `ARRAY[${ids.map((_, i) => `$${i + 2}::uuid`).join(", ")}]`
  const key = `s.${ident(section.key)}`
  return {
    text:
      `SELECT o.${ident(object.versionColumn)}::text AS version, ` +
      `(SELECT ${key} FROM ${tableOf(section.table)} s WHERE ${on} AND ` +
      `${key} <> ALL(${set}) LIMIT 1) AS missing ` +
      `FROM ${tableOf(object.table)} o WHERE o.${ident(object.key)} = $1::uuid`,
    params: [op.id, ...ids],
  }
}

/**
 * Сувора перевірка масивів ТЧ `update` (спека П4-B §7.1): кожен наявний
 * рядок — у вхідному масиві чи в `deleteIds`, інакше `command.invalid`
 * `reason: "tabular-rows-missing"` до хуків і ядра. Перевіряється вхід
 * викликача; правка масиву хуком — свідома дія довіреного коду.
 *
 * Замка рядка немає: перевірка бачить надмножину рядків ядра — fail-closed;
 * замок перевернув би порядок замків ієрархічного довідника. Коректність без
 * замка тримається на двох умовах механіки:
 * (1) `expectedVersion` обов'язковий для `update` (`operationSchema` T0) —
 *     якщо поле стане необов'язковим, перевірка без нього мусить відмовляти,
 *     а не пропускати;
 * (2) кожна зміна змістових колонок рядків ТЧ підвищує версію власника (Рд27),
 *     тож паралельна вставка між перевіркою й ядром дає `command.conflict`.
 * Власника не видно чи версія інша — вердикт за ядром.
 */
async function checkTabularRows(
  tx: Transaction,
  found: Target,
  op: PreparedOperation
): Promise<void> {
  if (op.action !== "update" || op.tabularSections === undefined) return
  const { object } = found
  for (const section of object.tabularSections) {
    const rows = op.tabularSections[section.name]
    if (rows === undefined) continue
    const ids = [
      ...rows.map((row) => row[section.keyName] as string),
      ...(op.deleteIds?.[section.name] ?? []),
    ]
    const { rows: answer } = await tx.enqueue(
      [contextOf(found, op), tabularCheckOf(object, section, op, ids)],
      { kind: "write", object, operation: op.action }
    )
    const owner = answer[0]
    if (owner === undefined) return
    if (typeof owner.version !== "string" || !("missing" in owner)) {
      coreAnomaly(tx, object)
    }
    if (owner.version !== String(op.expectedVersion)) return
    if (owner.missing !== null) {
      tx.abort({
        code: "command.invalid",
        reason: "tabular-rows-missing",
        path: section.name,
      })
    }
  }
}

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
  // `ctx.run` завжди суворий: опція виклику `run` його не вимикає.
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
  op: PreparedOperation,
  fullTabularArrays = false
): Promise<Record<string, unknown>> {
  const found = targetOf(tx.state.catalog, op)
  if ("error" in found) tx.abort(found.error)
  const creation = rootCreateOf(tx.state.catalog, found.object, op)
  if (creation !== undefined) return runRootPhase(tx, found, op, creation)
  const { object } = found
  if (!fullTabularArrays) await checkTabularRows(tx, found, op)
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
    // Рядок членства, невидимий творцю після гранту, ядро віддає формою
    // `{ключ, версія}` без скоупу (спека П4 §6.13); у набір змін він не йде,
    // тож скоуп тут не потрібен — лише в цьому шляху.
    memberRow = decodeCoreRow(
      tx,
      memberObject,
      () => (result as Record<string, unknown>).member,
      false
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
  const { rows } = await tx.enqueue([contextOf({ object, target }, op), call], {
    kind: "write",
    object,
    operation: op.action,
    ...(membership === undefined ? {} : { membership }),
  })
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

/**
 * Рядок ядра за каталогом: ключ, версія й скоуп мусять бути. Без скоупу —
 * лише рядок членства з результату ядра кореня (`requireScope = false`).
 */
function decodeCoreRow(
  tx: Transaction,
  object: RuntimeObject,
  parse: () => unknown,
  requireScope = true
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
    (requireScope &&
      object.scopeColumn !== undefined &&
      typeof scope !== "string")
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
