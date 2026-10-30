import { z } from "zod"
import {
  canonicalize,
  derivePromotionFacts,
  promoteInput,
  promotionMapping,
  promotionRecordHash,
  type CompiledModel,
  type DiagnosticParams,
  type PromotionFacts,
  type PromotionRecord,
  type RuleCode,
} from "simetra/compiler"
import {
  KIND_REGISTRY,
  metadataKindSchema,
  type MetadataKind,
  type PhysicalTable,
} from "simetra/model"
import type { EngineDiagnostic } from "../../engine"
import { applyDiagnostic } from "../diagnostic"
import type { ApplyTransaction } from "../port"
import type { ApplyState, MarkerRecord } from "../state"
import { tableKey } from "../table-key"

/** Запис промоції з `plans/` і файл, з якого його прочитано. */
export interface PromotionInput {
  record: PromotionRecord
  file: string
}

export type TransitionVerdict =
  | { status: "none"; diagnostics: EngineDiagnostic[] }
  | { status: "refused"; diagnostics: EngineDiagnostic[] }
  | {
      status: "promotion"
      record: PromotionRecord
      recordHash: string
      /**
       * Факти, виведені зі знімків до й після: власні `deleteSemantics`
       * збігаються із записом, вхідні — лише звідси. Єдине джерело пунктів
       * дозволу `delete:*`.
       */
      facts: PromotionFacts
      /**
       * Фізичні таблиці стану «до» зі знімка marker: з них заміри збереження
       * беруть первинний ключ (спека промоції §7.2), а не з живої цілі.
       */
      source: PhysicalTable[]
      diagnostics: EngineDiagnostic[]
    }

/**
 * Знімок marker читається вузько: лише поля, з яких виявляється перехід і
 * виводяться факти. Решту знімка T2 не тлумачить, тож зміна інших його
 * частин не ламає читання.
 */
const markerSnapshotSchema = z.looseObject({
  objects: z.array(z.looseObject({ id: z.string(), kind: metadataKindSchema })),
  physical: z.looseObject({
    tables: z.array(
      z.looseObject({
        schema: z.string(),
        name: z.string(),
        origin: z.looseObject({
          objectId: z.string(),
          tabularSectionId: z.string().optional(),
          part: z.string().optional(),
        }),
        rowLevelSecurity: z.string(),
        columns: z.array(
          z.looseObject({
            name: z.string(),
            type: z.string(),
            notNull: z.boolean(),
            origin: z.looseObject({
              elementId: z.string().optional(),
              // Копія носія (спека прав §5.2, спека промоції §7.2): бажана копія, що не була
              // копією з тим самим джерелом, отримує крок даних плану
              copyOf: z
                .looseObject({
                  table: z.looseObject({
                    schema: z.string(),
                    name: z.string(),
                  }),
                  column: z.string(),
                  through: z.string(),
                })
                .optional(),
            }),
          })
        ),
        primaryKey: z.looseObject({ name: z.string() }).optional(),
        foreignKeys: z.array(
          z.looseObject({
            columns: z.array(z.string()),
            onDelete: z.string(),
          })
        ),
      })
    ),
  }),
})

interface MarkerSnapshot {
  kinds: ReadonlyMap<string, MetadataKind>
  tables: PhysicalTable[]
}

function markerSnapshot(marker: MarkerRecord): MarkerSnapshot {
  const parsed = markerSnapshotSchema.safeParse(marker.snapshot)
  // Знімок пише сама платформа під перевіреною формою стану: інша форма —
  // помилка платформи, а не стан цілі, який план уміє назвати.
  if (!parsed.success)
    throw new Error(
      `marker snapshot does not have the canonical form: ${parsed.error.message}`
    )
  return {
    kinds: new Map(parsed.data.objects.map((o) => [o.id, o.kind])),
    tables: parsed.data.physical.tables as unknown as PhysicalTable[],
  }
}

/**
 * Фізичні таблиці знімка marker: стан останнього застосування, з яким план
 * звіряє копії носіїв (спека прав §5.2).
 */
export const markerTables = (marker: MarkerRecord): PhysicalTable[] =>
  markerSnapshot(marker).tables

/** Види, у які промоція вміє перетворювати: їх задає вхід операції. */
const PROMOTION_KINDS: ReadonlySet<MetadataKind> = new Set(
  promoteInput.shape.into.shape.kind.options
)

/** Прийнята таблиця — за фактами реєстру, як її бачить `promote`. */
const isAdopted = (kind: MetadataKind | undefined): boolean =>
  kind !== undefined &&
  KIND_REGISTRY[kind].declared &&
  KIND_REGISTRY[kind].materializes === "table"

const isPromoted = (kind: MetadataKind | undefined): boolean =>
  kind !== undefined && PROMOTION_KINDS.has(kind)

const error = (code: RuleCode, params: DiagnosticParams) =>
  applyDiagnostic(code, "error", params)

const warning = (code: RuleCode, params: DiagnosticParams) =>
  applyDiagnostic(code, "warning", params)

/** Факти, які T2 звіряє із записом; вхідні `deleteSemantics` — поза звіркою. */
const RECONCILED = [
  "tables",
  "columns",
  "typeChanges",
  "retired",
  "relaxed",
  "tightened",
  "rowLevelSecurity",
  "deleteSemantics",
] as const satisfies readonly (keyof PromotionFacts)[]

function reconciled(
  facts: PromotionFacts,
  key: (typeof RECONCILED)[number]
): readonly unknown[] {
  return key === "deleteSemantics"
    ? facts.deleteSemantics.filter((d) => d.direction === "own")
    : facts[key]
}

/** Перший розбіжний факт у канонічній формі; `undefined` — усе збіглось. */
function firstDifference(
  derived: PromotionFacts,
  record: PromotionRecord
): string | undefined {
  for (const key of RECONCILED) {
    const ours = reconciled(derived, key)
    const theirs = reconciled(record, key)
    for (let i = 0; i < Math.max(ours.length, theirs.length); i++) {
      const a = i < ours.length ? canonicalize(ours[i]) : "nothing"
      const b = i < theirs.length ? canonicalize(theirs[i]) : "nothing"
      if (a !== b) return `${key}[${i}]: derived ${a}, recorded ${b}`
    }
  }
  return undefined
}

const byCodeUnit = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0

/**
 * Таблиці одиниці з ідентичності (спека промоції §7.1): сам об'єкт і кожна його ТЧ, що
 * в marker була `CustomTable` з тим самим id. Факти виводяться лише з таблиць
 * запису, тож пропущена таблиця ТЧ інакше звузила б і факти, і звірку —
 * а план без її перейменування перестворив би таблицю з даними.
 */
function unitTablesDifference(
  record: PromotionRecord,
  before: MarkerSnapshot,
  model: CompiledModel
): string | undefined {
  const { objectId } = record
  const expected = new Set([objectId])
  for (const { origin } of model.physical.tables) {
    const section = origin.tabularSectionId
    if (
      origin.objectId === objectId &&
      origin.part === undefined &&
      section !== undefined &&
      isAdopted(before.kinds.get(section))
    )
      expected.add(section)
  }
  const recorded = new Set(record.tables.map((t) => t.id))
  for (const id of [...expected].sort(byCodeUnit)) {
    if (!recorded.has(id))
      return `tables: ${id} was a CustomTable and is now part of ${objectId}, but the record does not name it`
  }
  for (const id of [...recorded].sort(byCodeUnit)) {
    if (!expected.has(id))
      return `tables: ${id} is neither ${objectId} nor its tabular section adopted from a CustomTable`
  }
  return undefined
}

type Reconciliation =
  | { ok: true; recordHash: string; facts: PromotionFacts }
  | { ok: false; diagnostics: EngineDiagnostic[] }

/**
 * Рядки 2–4 таблиці рішень: прив'язка до marker, звірка фактів, межі підтримуваної промоції.
 * Факти виводить та сама функція, що й `promote`, над знімком marker і
 * бажаною моделлю, тож пізніший коміт, що зачепив промотований об'єкт,
 * розходиться звіркою, а не проходить мовчки.
 */
async function reconcile(
  { record, file }: PromotionInput,
  marker: MarkerRecord,
  before: MarkerSnapshot,
  model: CompiledModel
): Promise<Reconciliation> {
  const { objectId } = record
  if (record.base !== marker.snapshotHash) {
    return {
      ok: false,
      diagnostics: [
        error("plan.promotion-base", {
          objectId,
          file,
          base: record.base,
          marker: marker.snapshotHash,
        }),
      ],
    }
  }
  const unitDifference = unitTablesDifference(record, before, model)
  if (unitDifference !== undefined) {
    return {
      ok: false,
      diagnostics: [
        error("plan.promotion-record-mismatch", {
          objectId,
          file,
          detail: unitDifference,
        }),
      ],
    }
  }
  const derived = derivePromotionFacts(
    { tables: before.tables },
    {
      physical: model.physical,
      attributeCase: model.project.naming.attributeCase,
    },
    promotionMapping(record)
  )
  const detail = derived.ok
    ? firstDifference(derived.facts, record)
    : derived.detail
  if (!derived.ok || detail !== undefined) {
    return {
      ok: false,
      diagnostics: [
        error("plan.promotion-record-mismatch", {
          objectId,
          file,
          detail: detail ?? "",
        }),
      ],
    }
  }
  const diagnostics: EngineDiagnostic[] = []
  const unsupported = (reason: string, extra: DiagnosticParams = {}) =>
    diagnostics.push(
      error("plan.promotion-unsupported", { objectId, file, reason, ...extra })
    )
  if (record.labelTranslation !== undefined) unsupported("labelTranslation")
  // Збереження значень рахується за первинним ключем «до» (спека промоції §7.2):
  // хеш мультимножини без ключа не доводить, що значення лишились у рядках.
  for (const { id } of record.tables) {
    const table = before.tables.find(
      ({ origin }) =>
        origin.objectId === id &&
        origin.tabularSectionId === undefined &&
        origin.part === undefined
    )
    if (table !== undefined && table.primaryKey === undefined)
      unsupported("primaryKey", { table: `${table.schema}.${table.name}` })
  }
  if (diagnostics.length > 0) return { ok: false, diagnostics }
  return {
    ok: true,
    recordHash: await promotionRecordHash(record),
    facts: derived.facts,
  }
}

/**
 * Перехід промоції й звірка записів за таблицею рішень (спека
 * промоції §7.1). Перехід виявляється з ідентичності, а не з наявності запису:
 * об'єкт X — прийнята таблиця в marker і вид, у який уміє промоція, у
 * бажаній моделі. Запис зіставляється з переходом за `objectId`. Без marker
 * ідентичності «до» немає, тож діють запобіжні рядки за іменами старих
 * таблиць у живій цілі.
 */
export async function promotionTransition(p: {
  state: ApplyState
  model: CompiledModel
  records: readonly PromotionInput[]
  /** `ledger.promotion->>'hash'` — застосовані записи. */
  appliedHashes: ReadonlySet<string>
  /** `tableKey(schema, name)` таблиць живої цілі. */
  liveTables: ReadonlySet<string>
}): Promise<TransitionVerdict> {
  const diagnostics: EngineDiagnostic[] = []
  // Стан «corrupt» план відмовляє раніше; тут він, як і «fresh», — без marker.
  if (p.state.status !== "applied") {
    for (const { record, file } of p.records) {
      const { objectId } = record
      const live = record.tables.find((t) =>
        p.liveTables.has(tableKey(t.schema, t.from))
      )
      diagnostics.push(
        live === undefined
          ? // Рядок 9: нове середовище, старих таблиць немає.
            warning("plan.promotion-not-applicable", { objectId, file })
          : // Рядок 8: без marker не довести, що жива таблиця — та сама.
            error("plan.promotion-needs-marker", {
              objectId,
              file,
              table: `${live.schema}.${live.from}`,
            })
      )
    }
    return verdictOf(diagnostics, undefined)
  }

  const { marker } = p.state
  const before = markerSnapshot(marker)
  const after = new Map(p.model.objects.map((o) => [o.id, o.kind]))
  const transitions = p.model.objects.filter(
    (o) => isAdopted(before.kinds.get(o.id)) && isPromoted(o.kind)
  )
  if (transitions.length > 1) {
    diagnostics.push(
      error("plan.promotion-multiple", {
        objects: transitions.map((o) => `${o.kind} ${o.name}`).join(", "),
      })
    )
  }

  let promotion: Extract<TransitionVerdict, { status: "promotion" }> | undefined
  for (const object of transitions) {
    const input = p.records.find((r) => r.record.objectId === object.id)
    if (input === undefined) {
      // Рядок 1.
      diagnostics.push(
        error("plan.promotion-record-missing", {
          objectId: object.id,
          kind: object.kind,
          name: object.name,
        })
      )
      continue
    }
    // Рядки 2–4.
    const outcome = await reconcile(input, marker, before, p.model)
    if (!outcome.ok) {
      diagnostics.push(...outcome.diagnostics)
      continue
    }
    promotion = {
      status: "promotion",
      record: input.record,
      recordHash: outcome.recordHash,
      facts: outcome.facts,
      source: before.tables,
      diagnostics,
    }
  }

  const transitionIds = new Set(transitions.map((o) => o.id))
  for (const { record, file } of p.records) {
    const { objectId } = record
    if (transitionIds.has(objectId)) continue
    const was = before.kinds.get(objectId)
    const now = after.get(objectId)
    const applied = p.appliedHashes.has(await promotionRecordHash(record))
    const settled = isPromoted(was) && isPromoted(now)
    if (settled && applied) {
      // Рядок 5: промоцію вже застосовано тут, файл чекає інших інстансів.
      diagnostics.push(warning("plan.promotion-applied", { objectId, file }))
    } else if (!applied && (settled || was === undefined)) {
      // Рядок 7: об'єкт тут не прийнятий — запис не для цього інстансу.
      diagnostics.push(
        warning("plan.promotion-not-applicable", { objectId, file })
      )
    } else {
      // Рядок 6 і решта: запис, що не відповідає жодному стану з таблиці,
      // — застарілий, а не той, який можна мовчки пропустити.
      diagnostics.push(error("plan.promotion-record-stale", { objectId, file }))
    }
  }
  return verdictOf(diagnostics, promotion)
}

function verdictOf(
  diagnostics: EngineDiagnostic[],
  promotion: Extract<TransitionVerdict, { status: "promotion" }> | undefined
): TransitionVerdict {
  if (diagnostics.some((d) => d.severity === "error"))
    return { status: "refused", diagnostics }
  return promotion === undefined
    ? { status: "none", diagnostics }
    : { ...promotion, diagnostics }
}

/**
 * Колонки таблиць одиниці, що залежать від послідовності поза схемою своєї
 * таблиці: `OWNED BY` (`pg_depend` `a`) чи `DEFAULT
 * nextval` (`pg_attrdef` → послідовність, `n`). Канонічне ім'я шукається
 * лише в схемі таблиці (спека промоції §5), тож таку послідовність двигун зняв би й
 * створив наново — тихо скинувши лічильник.
 */
const FOREIGN_SEQUENCES_SQL = `
with t as (
  select c.oid, c.relnamespace as nsp, x.schema, x.name
  from pg_catalog.json_to_recordset($1::pg_catalog.json) as x(schema text, name text)
  join pg_catalog.pg_namespace n on n.nspname = x.schema
  join pg_catalog.pg_class c on c.relnamespace = n.oid and c.relname = x.name
), dep as (
  select t.oid as relid, t.schema, t.name, t.nsp, d.refobjsubid as attnum,
    d.objid as seq
  from t join pg_catalog.pg_depend d
    on d.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
   and d.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass
   and d.refobjid = t.oid and d.deptype = 'a'
  union
  select t.oid, t.schema, t.name, t.nsp, ad.adnum, d.refobjid
  from t join pg_catalog.pg_attrdef ad on ad.adrelid = t.oid
  join pg_catalog.pg_depend d
    on d.classid = 'pg_catalog.pg_attrdef'::pg_catalog.regclass
   and d.objid = ad.oid
   and d.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass
   and d.deptype = 'n'
)
select distinct
  pg_catalog.format('%s.%s', pg_catalog.quote_ident(dep.schema), pg_catalog.quote_ident(dep.name)) as "table",
  a.attname::text as "column",
  pg_catalog.format('%s.%s', pg_catalog.quote_ident(sn.nspname), pg_catalog.quote_ident(s.relname)) as "sequence"
from dep
join pg_catalog.pg_class s on s.oid = dep.seq and s.relkind = 'S' and s.relnamespace <> dep.nsp
join pg_catalog.pg_namespace sn on sn.oid = s.relnamespace
join pg_catalog.pg_attribute a on a.attrelid = dep.relid and a.attnum = dep.attnum
`

/**
 * Відмови `plan.promotion-unsupported` (`reason: "sequenceSchema"`) за
 * послідовностями поза схемою таблиці одиниці — на рівні виявлення, до diff
 * двигуна, як `primaryKey`. Таблиці — у старих іменах, як їх бачить ціль;
 * викликач відкриває транзакцію `READ ONLY` на цілі.
 */
export async function foreignSequenceRefusals(
  tx: ApplyTransaction,
  { record, file }: PromotionInput
): Promise<EngineDiagnostic[]> {
  const rows = await tx.query<{
    table: string
    column: string
    sequence: string
  }>(FOREIGN_SEQUENCES_SQL, [
    JSON.stringify(
      record.tables.map((t) => ({ schema: t.schema, name: t.from }))
    ),
  ])
  return rows
    .map((r) => ({ ...r, key: canonicalize([r.table, r.column, r.sequence]) }))
    .sort((a, b) => byCodeUnit(a.key, b.key))
    .map(({ table, column, sequence }) =>
      error("plan.promotion-unsupported", {
        objectId: record.objectId,
        file,
        reason: "sequenceSchema",
        table,
        column,
        sequence,
      })
    )
}
