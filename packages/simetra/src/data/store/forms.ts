import {
  keysetNodesMax,
  type CatalogEntry,
  type CatalogIndex,
  type MetadataRef,
} from "simetra/model"
import {
  checkFilterBudget,
  compareRows,
  compileFilter,
  type FieldInfo,
} from "./filter"
import { includeSteps, type IncludeStep } from "./include"
import type { ObjectStore } from "./object-store"
import type { SectionStore } from "./section-store"
import type { Key, ObjectName, Values, ViewSpec } from "./types"

/*
 * Форми виглядів (спека П4-B §6.1 «Вигляди й форми підмножин»): перевірка
 * опису вигляду до будь-якого запиту й канонічний ключ форми, за яким
 * мемоізовано хендли й однозначна підмножина.
 */

/** The stores and catalog facts of one object. */
export interface ObjectState {
  readonly name: ObjectName
  readonly ref: MetadataRef
  readonly entry: CatalogEntry
  readonly info: FieldInfo
  readonly lazyFields: readonly string[]
  readonly rows: ObjectStore
  readonly sections: SectionStore
}

/** A validated view form: what every subset and handle of it shares. */
export interface Form {
  readonly spec: ViewSpec
  readonly specKey: string
  readonly object: ObjectState
  readonly keys: readonly Key[]
  readonly test: (values: Values) => boolean
  readonly compare: ((a: Values, b: Values) => number) | undefined
  readonly include: readonly IncludeStep[]
}

/** What form validation needs from the core. */
export interface FormContext {
  readonly index: CatalogIndex
  readonly filterCollator: Intl.Collator
  readonly userCollator: Intl.Collator
  objectOf(name: ObjectName): ObjectState
}

// Канонічний JSON: рівні фільтри з різним порядком полів — одна форма.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .filter((k) => record[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(record[k])}`)
      .join(",")}}`
  }
  return JSON.stringify(value) ?? "null"
}

/**
 * Validates a view spec and gives its form. Every refusal comes here, before
 * any request: an unknown object or section and a bad `include` are
 * `TypeError`; a `full` filter or order the core cannot evaluate is
 * `DataError` / `CommandFailure` from the evaluator.
 */
export function formOf(ctx: FormContext, spec: ViewSpec): Form {
  const object = ctx.objectOf(spec.object)
  const { entry } = object
  const all = () => true
  switch (spec.kind) {
    case "keys": {
      const keys = [...new Set(spec.keys)]
      return {
        spec,
        specKey: canonical([spec.kind, spec.object, keys]),
        object,
        keys,
        test: all,
        compare: undefined,
        include: [],
      }
    }
    case "card":
      return {
        spec,
        specKey: canonical([spec.kind, spec.object, spec.key]),
        object,
        keys: [spec.key],
        test: all,
        compare: undefined,
        include: [],
      }
    case "section":
      if (!entry.tabularSections.some((s) => s.name === spec.section)) {
        throw new TypeError(`${spec.object}: unknown section ${spec.section}`)
      }
      return {
        spec,
        specKey: canonical([spec.kind, spec.object, spec.owner, spec.section]),
        object,
        keys: [],
        test: all,
        compare: undefined,
        include: [],
      }
    case "full": {
      // Усі відмови — тут, до запиту (§6.1 «Предикати», §6.4 «Бюджет фільтра»).
      const orderBy = spec.orderBy ?? []
      const test =
        spec.where === undefined
          ? all
          : compileFilter(spec.where, object.info, ctx.filterCollator)
      const compare = compareRows(
        orderBy,
        object.info,
        entry.keyName,
        ctx.userCollator
      )
      // Бюджет — за найгіршою keyset-умовою порядку (§6.4), а не за курсором
      // першої сторінки: інакше сторінка з іншим курсором відмовила б на
      // сервері. Умова глибиною ≤ 5 не обмежує `and` над `where`, тож
      // перевірці досить заглушки з тим самим числом вузлів.
      if (spec.where !== undefined) {
        const keyset =
          orderBy.at(-1)?.attribute === entry.keyName
            ? orderBy.slice(0, -1)
            : orderBy
        checkFilterBudget({
          and: [
            spec.where,
            {
              or: Array.from({ length: keysetNodesMax(keyset) - 1 }, () => ({
                attribute: entry.keyName,
                op: "isNull" as const,
              })),
            },
          ],
        })
      }
      const include = includeSteps(spec.object, entry, ctx.index, spec.include)
      return {
        spec,
        specKey: canonical([
          spec.kind,
          spec.object,
          spec.where ?? null,
          orderBy,
          include.map((s) => s.attribute).sort(),
        ]),
        object,
        keys: [],
        test,
        compare,
        include,
      }
    }
  }
}
