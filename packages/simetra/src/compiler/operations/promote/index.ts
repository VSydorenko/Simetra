import {
  KIND_REGISTRY,
  postsMovements,
  standardLogicalName,
  type MetadataRef,
  type PhysicalTable,
} from "simetra/model"
import { polymorphicTargets } from "../../assigned-once"
import type { CompiledModel, SourceObject } from "../../compile"
import { diagnostic, toPointer, type Diagnostic } from "../../diagnostics"
import { loadSqlParser } from "../../sql/parse"
import { completeNarrowAndCompile, type CompletionOptions } from "../fix"
import type { PromoteInput } from "../inputs"
import { compileInput, refused, refuseSuppliedId } from "../refuse"
import { objectFiles } from "../target"
import type { OperationResult } from "../types"
import { cascadeReferences, type PromotedReferences } from "./cascade"
import { fillStepKind, fillTargetKey, modelVolatileFunctions } from "./fill"
import { kindFile, type PromotedSection } from "./kind-file"
import {
  missingFills,
  placeColumns,
  structuralSubjects,
  type ConversionSubject,
  type PromotedTable,
  type PromotionTarget,
} from "./mapping"
import {
  promotionRecord,
  type PlannedStep,
  type PlannedTarget,
  type PromoteResult,
} from "./record"

const MODULE_SUFFIX = ".module.ts"

/**
 * Відмова, якщо частина входу, з якої народжуються нові елементи, несе `id`
 * (як у `create`/`add`). Ключі мапінгу — імена колонок, тож перевіряються
 * лише тіла елементів і дані виду, а не весь вхід: колонка `id` не є id.
 */
function suppliedId(
  files: ReadonlyMap<string, string>,
  input: PromoteInput
): OperationResult | undefined {
  const bodies: [unknown, string[]][] = [[input.into.data, ["into", "data"]]]
  const columns = (mappings: PromoteInput["columns"], at: string[]) => {
    for (const [name, mapping] of Object.entries(mappings)) {
      if (mapping.to === "attribute") {
        bodies.push([mapping.element, [...at, name, "element"]])
      }
    }
  }
  columns(input.columns, ["columns"])
  input.tabularSections.forEach((section, i) => {
    const at = ["tabularSections", String(i)]
    bodies.push([section.data, [...at, "data"]])
    columns(section.columns, [...at, "columns"])
  })
  for (const [value, root] of bodies) {
    const found = refuseSuppliedId(files, value, root)
    if (found !== undefined) return found
  }
  return undefined
}

/** Вид описує прийняту таблицю: її промотують. */
const isAdoptedTable = (object: SourceObject) =>
  KIND_REGISTRY[object.kind].declared &&
  KIND_REGISTRY[object.kind].materializes === "table"

/** Таблиця прийнятого об'єкта у знімку моделі до промоції. */
const adoptedTable = (model: CompiledModel, object: SourceObject) =>
  model.physical.tables.find(
    ({ origin }) => origin.objectId === object.id && origin.part === undefined
  )

/**
 * Гейти одиниці (рішення 4, 6; §11), до будь-яких змін: ціль, яку
 * промоція вміє, — за фактами реєстру й даними виду, а не за його ім'ям.
 */
function unitGates(
  files: ReadonlyMap<string, string>,
  input: PromoteInput,
  object: SourceObject,
  data: unknown
): Diagnostic[] {
  const { kind, name } = input.into
  const def = KIND_REGISTRY[kind]
  const problems: Diagnostic[] = []
  const unsupported = (detail: string) =>
    problems.push(
      diagnostic("promote.unit-unsupported", "", "", { kind, name, detail })
    )
  // Документ, що пише рухи, промотується разом зі своїми регістрами (Пр15).
  const document = data as { posting?: unknown; registerMovements?: unknown[] }
  if (
    postsMovements(kind) &&
    (document.posting !== undefined ||
      (document.registerMovements ?? []).length > 0)
  ) {
    unsupported("it writes register movements")
  }
  // Рухи регістра, що їх пише реєстратор, — частина групи документа (Пр15).
  if (def.registerKeys?.(data).movementsPrimaryKey === "recorder") {
    unsupported("its records are written by a recorder")
  }
  if (
    input.tabularSections.length > 0 &&
    def.tabularSectionColumns === undefined
  ) {
    unsupported("the kind has no tabular sections")
  }
  // Вид без мітки її губить, а дискримінатор поліморфної пари лежить у даних
  // (рішення 4).
  if (
    def.kindLabel !== true &&
    polymorphicTargets(files).has(`${object.kind}:${object.name}`)
  ) {
    problems.push(
      diagnostic("promote.label-target", object.file, "", {
        kind,
        name: object.name,
      })
    )
  }
  return problems
}

/** Таблиця одиниці з тим, у що вона стає. */
interface UnitTable {
  promoted: PromotedTable
  target: PromotionTarget
  /** Вхід ТЧ і її індекс у `tabularSections`; немає — основна таблиця. */
  section?: { index: number; input: PromoteInput["tabularSections"][number] }
  /** Дані елемента з входу: `into.data` чи `data` ТЧ — реквізити поза колонками. */
  data?: Record<string, unknown>
}

/**
 * Кроки `fill` (рішення 12, 15): таблиця, ціль і вираз кожного кроку. Вид
 * кроку виводиться з того, що читає вираз; порушення форми —
 * `promote.expression-invalid`.
 */
async function planSteps(
  model: CompiledModel,
  input: PromoteInput,
  tables: readonly UnitTable[]
): Promise<{ steps: PlannedStep[]; problems: Diagnostic[] }> {
  const steps: PlannedStep[] = []
  const problems: Diagnostic[] = []
  if (input.fill.length === 0) return { steps, problems }
  const parse = await loadSqlParser()
  const volatile = modelVolatileFunctions(model)
  const unknown = (path: (string | number)[], detail: string) =>
    problems.push(
      diagnostic("promote.mapping-unknown", "", "", {
        at: toPointer(["fill", ...path.map(String)]),
        detail,
      })
    )
  const taken = new Set<string>()
  for (const [i, step] of input.fill.entries()) {
    const table = tables.find((t) => t.section?.input.table === step.table)
    if (table === undefined) {
      unknown(
        [i, "table"],
        `${step.table} is not a tabular section table of the unit`
      )
      continue
    }
    const { promoted } = table
    const key = `${step.table ?? ""} ${fillTargetKey(step.target)}`
    if (taken.has(key)) {
      unknown(
        [i, "target"],
        `${step.target.name} is already filled by another step`
      )
      continue
    }
    taken.add(key)
    const target = plannedTarget(table, step.target)
    if (target === undefined) {
      unknown(
        [i, "target", "name"],
        `${promoted.object.name} becomes no ${step.target.to} ${step.target.name} that a step can fill`
      )
      continue
    }
    const physical = adoptedTable(model, promoted.object)
    if (physical === undefined) {
      throw new Error(`adopted table ${promoted.object.name} has no table`)
    }
    const columnName = (id: string | undefined) =>
      physical.columns.find((c) => c.origin.elementId === id)?.name
    const mapped = new Set<string>()
    const retired = new Set<string>()
    for (const { column, fate } of promoted.columns) {
      if (fate.to === "standard") mapped.add(`standard ${fate.def.logicalName}`)
      if (fate.to === "attribute") {
        mapped.add(`attribute ${String(fate.element.name)}`)
      }
      const name = columnName(column.id)
      if (fate.to === "retire" && name !== undefined) retired.add(name)
    }
    const keyColumns = physical.primaryKey?.columns ?? []
    const shape = {
      schema: physical.schema,
      name: physical.name,
      ...(keyColumns.length === 1 ? { key: keyColumns[0] } : {}),
      columns: physical.columns.map((c) => c.name),
    }
    const kind = fillStepKind(step, mapped, retired, parse, shape, volatile)
    if ("reason" in kind) {
      problems.push(
        diagnostic("promote.expression-invalid", "", "", {
          expression: step.expression,
          reason: kind.reason,
        })
      )
      continue
    }
    steps.push({
      promoted,
      ...(table.section === undefined ? {} : { section: promoted.object.id }),
      target,
      expression: step.expression,
      kind: kind.kind,
      schema: physical.schema,
      table: physical.name,
      key: shape.key!,
    })
  }
  return { steps, problems }
}

/**
 * Колонка, яку заповнює крок: змаплена з колонки, стандартна колонка виду
 * (не пара й не генерована) чи реквізит, що його задає вхід. Інша ціль —
 * нічого, що крок міг би заповнити.
 */
function plannedTarget(
  table: UnitTable,
  target: PromoteInput["fill"][number]["target"]
): PlannedTarget | undefined {
  const placed = table.promoted.columns.find(({ fate }) =>
    target.to === "standard"
      ? fate.to === "standard" && fate.def.logicalName === target.name
      : fate.to === "attribute" && fate.element.name === target.name
  )
  if (placed !== undefined) return { placed }
  if (target.to === "standard") {
    const standard = table.target.standard.find(
      (s) =>
        s.logicalName === target.name &&
        s.polymorphic === undefined &&
        s.generated === undefined
    )
    return standard === undefined ? undefined : { standard }
  }
  const declared = table.target.collections.some((collection) => {
    const items = table.data?.[collection]
    return (
      Array.isArray(items) &&
      items.some((e) => (e as { name?: unknown }).name === target.name)
    )
  })
  return declared ? { attribute: target.name } : undefined
}

/**
 * Промоція прийнятої таблиці у вид 1С (спека промоції §4, §7.1): чисто
 * файлова мутація. Файл виду заміняє файли `CustomTable` основної таблиці й
 * таблиць ТЧ з перенесеними id і канонічними фізичними іменами, посилання з
 * інших файлів переходять на вид, а запис промоції несе все, що П3 має знати
 * про старий стан. Як і інші мутації: повний вхід або відмова, компіляція
 * перед записом, усе або нічого.
 */
export async function promoteObject(
  files: ReadonlyMap<string, string>,
  input: PromoteInput,
  o: CompletionOptions
): Promise<PromoteResult> {
  // 1. Вхід і чиста модель.
  const supplied = suppliedId(files, input)
  if (supplied !== undefined) return supplied
  const clean = await compileInput(files)
  if (!clean.ok) return clean.result
  const { model } = clean
  const style = model.project.naming.attributeCase

  // 2. Ціль — прийнята таблиця; ім'я нового об'єкта вільне.
  const adopted = (name: string) =>
    model.objects.find((x) => isAdoptedTable(x) && x.name === name)
  const object = adopted(input.target.name)
  if (object === undefined) {
    return refused(files, [
      diagnostic("operation.target-not-found", "", "", {
        target: `CustomTable ${input.target.name}`,
        name: input.target.name,
      }),
    ])
  }
  const { into } = input
  const def = KIND_REGISTRY[into.kind]
  const dir = `${def.dir}/${into.name}/`
  const path = `${dir}${into.name}.meta.json`
  const existing = model.objects.find(
    (x) => x.kind === into.kind && x.name === into.name
  )
  if (
    existing !== undefined ||
    [...files.keys()].some((file) => file.startsWith(dir))
  ) {
    return refused(files, [
      diagnostic("operation.object-exists", existing?.file ?? path, "", {
        kind: into.kind,
        name: into.name,
      }),
    ])
  }

  // Склад стандартних колонок залежить від налаштувань виду, тож вони
  // розбираються до розміщення колонок.
  const settings = def.schema.safeParse({
    ...into.data,
    kind: into.kind,
    name: into.name,
  })
  if (!settings.success) {
    return refused(
      files,
      settings.error.issues.map((issue) =>
        diagnostic("promote.mapping-unknown", "", "", {
          at: toPointer(["into", "data", ...issue.path]),
          detail: issue.message,
        })
      )
    )
  }
  const gates = unitGates(files, input, object, settings.data)
  if (gates.length > 0) return refused(files, gates)
  const target: PromotionTarget = {
    kind: into.kind,
    name: into.name,
    data: settings.data,
    standard: def.standardColumns(settings.data),
    collections: def.columnFields,
  }

  // 3. Повнота й гейти. Задача 9 додає сюди класифікацію SQL-одиниць і
  // гейти шляху запису та користувачів провайдера.
  const problems: Diagnostic[] = []
  const placement = placeColumns(
    model,
    object,
    input.columns,
    ["columns"],
    target,
    input.conversions
  )
  problems.push(...placement.problems)
  const main: PromotedTable = placement.table
  const tables: UnitTable[] = [{ promoted: main, target, data: into.data }]
  const sections = unitSections(files, model, input, object, target, problems)
  for (const { index, section, sectionObject, sectionTarget } of sections) {
    const placed = placeColumns(
      model,
      sectionObject,
      section.columns,
      ["tabularSections", String(index), "columns"],
      sectionTarget,
      input.conversions
    )
    problems.push(...placed.problems)
    tables.push({
      promoted: placed.table,
      target: sectionTarget,
      section: { index, input: section },
      data: section.data,
    })
  }

  const subjects: ConversionSubject[] = tables.flatMap((t) =>
    structuralSubjects(
      t.promoted,
      t.section === undefined ? into.data?.description : null,
      model.project.defaultLocale
    )
  )
  for (const s of subjects) {
    const given = input.conversions[s.subject]
    if (given === undefined) {
      if (s.required) {
        problems.push(
          diagnostic("promote.unclassified", s.file, s.pointer, {
            subject: s.subject,
          })
        )
      }
    } else if (s.allowed !== undefined && !s.allowed.includes(given)) {
      problems.push(
        diagnostic("promote.unclassified", s.file, s.pointer, {
          subject: s.subject,
          class: given,
          allowed: s.allowed.join(", "),
        })
      )
    }
  }
  const known = new Set(subjects.map((s) => s.subject))
  for (const key of Object.keys(input.conversions)) {
    if (!known.has(key)) {
      problems.push(
        diagnostic("promote.mapping-unknown", "", "", {
          at: toPointer(["conversions", key]),
          detail:
            "it names no SQL unit or structural element of the promoted tables",
        })
      )
    }
  }
  for (const t of tables) {
    problems.push(
      ...missingFills(t.promoted, t.target, input.fill, t.section?.input.table)
    )
  }
  const planned = await planSteps(model, input, tables)
  problems.push(...planned.problems)

  // 4. Файл виду.
  const becomes: MetadataRef = { kind: into.kind, name: into.name }
  const promotedSections: PromotedSection[] = tables.flatMap((t) =>
    t.section === undefined
      ? []
      : [
          {
            name: t.section.input.name,
            ...(t.section.input.data === undefined
              ? {}
              : { data: t.section.input.data }),
            promoted: t.promoted,
            target: t.target,
          },
        ]
  )
  const built = kindFile(
    { model, into, target, unit: new Map([[object.name, becomes]]) },
    main,
    promotedSections
  )
  problems.push(...built.problems)

  // 6. Каскад посилань з інших файлів.
  const references: PromotedReferences[] = tables.map((t) => ({
    objectId: t.promoted.object.id,
    table: t.promoted.object.name,
    // ТЧ не є об'єктом: посилання ззовні на її таблицю — відмова.
    becomes: t.section === undefined ? becomes : undefined,
    columns: new Map(
      t.promoted.columns.map(({ column, fate }) => [
        column.id!,
        {
          name: column.name,
          becomes:
            fate.to === "standard"
              ? standardLogicalName(fate.def, style)
              : fate.to === "attribute"
                ? String(fate.element.name)
                : undefined,
        },
      ])
    ),
  }))
  // Каскад рахується до запису, щоб його відмови прийшли разом з іншими.
  const cascade = cascadeReferences(model, files, references)
  problems.push(...cascade.problems)
  if (problems.length > 0) return refused(files, problems)

  // 5. Файли прийнятих таблиць знімаються, файл виду й каскад пишуться.
  // Модуль `.module.ts` — код застосунку, а не опис таблиці: він переїжджає
  // до файлу виду, як при перейменуванні, а не зникає мовчки.
  const after = new Map(files)
  for (const file of objectFiles(files, object)) {
    if (file.endsWith(MODULE_SUFFIX)) {
      after.set(`${dir}${into.name}${MODULE_SUFFIX}`, files.get(file)!)
    }
    after.delete(file)
  }
  for (const { sectionObject } of sections) {
    for (const file of objectFiles(files, sectionObject)) after.delete(file)
  }
  after.set(path, JSON.stringify(built.raw))
  for (const [file, text] of cascade.files) after.set(file, text)

  // 7–8. Доповнення (канонічні фізичні імена, рішення 10), звуження боргу й
  // компіляція результату.
  const completed = await completeNarrowAndCompile(
    files,
    after,
    o,
    new Set([path, ...cascade.files.keys()])
  )
  if (!completed.result.ok || completed.model === undefined) {
    return completed.result
  }
  // 9. Запис — з моделі результату.
  return {
    ...completed.result,
    record: promotionRecord(
      input,
      model,
      completed.model,
      main,
      tables.flatMap((t) =>
        t.section === undefined
          ? []
          : [{ promoted: t.promoted, section: t.promoted.object.id }]
      ),
      planned.steps
    ),
  }
}

/**
 * Таблиці ТЧ одиниці (§11): прийняті таблиці, що стають табличними
 * частинами нового об'єкта. Таблиця ТЧ лежить у схемі об'єкта, а модуль
 * `.module.ts` у ТЧ місця не має — це відмова, а не мовчазне зняття.
 */
function unitSections(
  files: ReadonlyMap<string, string>,
  model: CompiledModel,
  input: PromoteInput,
  object: SourceObject,
  target: PromotionTarget,
  problems: Diagnostic[]
): {
  index: number
  section: PromoteInput["tabularSections"][number]
  sectionObject: SourceObject
  sectionTarget: PromotionTarget
}[] {
  const def = KIND_REGISTRY[target.kind]
  const objectTable = adoptedTable(model, object)
  const seen = new Set([object.name])
  const found: ReturnType<typeof unitSections> = []
  for (const [index, section] of input.tabularSections.entries()) {
    const at = ["tabularSections", String(index), "table"]
    const unknown = (detail: string) =>
      problems.push(
        diagnostic("promote.mapping-unknown", "", "", {
          at: toPointer(at),
          detail,
        })
      )
    const sectionObject = model.objects.find(
      (x) => isAdoptedTable(x) && x.name === section.table
    )
    if (sectionObject === undefined) {
      unknown(`${section.table} is not an adopted table`)
      continue
    }
    if (seen.has(section.table)) {
      unknown(`${section.table} is already in the promotion unit`)
      continue
    }
    seen.add(section.table)
    const unsupported = (detail: string) =>
      problems.push(
        diagnostic("promote.unit-unsupported", sectionObject.file, "", {
          kind: sectionObject.kind,
          name: sectionObject.name,
          detail,
        })
      )
    const table: PhysicalTable | undefined = adoptedTable(model, sectionObject)
    if (table?.schema !== objectTable?.schema) {
      unsupported(
        `a tabular section lives in schema ${objectTable?.schema ?? ""} of its object, not in ${table?.schema ?? ""}`
      )
    }
    const module = objectFiles(files, sectionObject).find((file) =>
      file.endsWith(MODULE_SUFFIX)
    )
    if (module !== undefined) {
      unsupported(`its module ${module} has no place in a tabular section`)
    }
    found.push({
      index,
      section,
      sectionObject,
      sectionTarget: {
        kind: target.kind,
        name: target.name,
        data: target.data,
        standard: def.tabularSectionColumns!(target.data),
        // Рядок ТЧ несе лише реквізити (схема табличної частини).
        collections: ["attributes"],
      },
    })
  }
  return found
}
