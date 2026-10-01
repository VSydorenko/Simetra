import {
  KIND_REGISTRY,
  standardLogicalName,
  type LocalizedString,
  type LogicalType,
  type MetadataRef,
  type PhysicalColumn,
  type PhysicalTable,
  type StandardColumnDef,
  type TabularSection,
} from "simetra/model"
import type { CompiledModel } from "./compile"
import { registerSingletonOf } from "./stages/model"

/** Тип значення, спільний для реквізиту, константи й колонки `CustomTable`. */
interface ValueSource {
  type: string
  ref?: MetadataRef
  allowedTypes?: MetadataRef[]
  array?: boolean
  enum?: MetadataRef
  title?: LocalizedString
  description?: LocalizedString
}

/** Елемент з ідентичністю: реквізит, вимір, ресурс чи колонка `CustomTable`. */
interface ElementSource extends ValueSource {
  id?: string
  name: string
}

/** Джерело поля колонки: логічний опис або `{ raw }` стандартного реквізиту. */
type Source = ValueSource | { raw: string }

// Спека §8.5. Record за повним переліком логічних типів: новий тип без рядка
// тут не збереться.
const TS_OF_LOGICAL: Record<LogicalType, string> = {
  UUID: "string",
  Ref: "string",
  String: "string",
  Text: "string",
  Date: "string",
  DateTime: "string",
  Bytes: "string",
  Integer: "number",
  SmallInt: "number",
  // BigInt і Numeric не вміщуються в number без втрати точності.
  BigInt: "string",
  Numeric: "string",
  Boolean: "boolean",
  Json: "Json",
}

const JSON_TYPE =
  "export type Json = string | number | boolean | null | Json[] | { [key: string]: Json }"

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/**
 * Логічні TS-типи сутностей (спека §8.5): інтерфейс на кожен об'єкт з
 * таблицею й на кожну ТЧ. Нуллабельність і генерованість беруться з
 * фізичного знімка, а не виводяться наново, тож тип не розійдеться з DDL.
 * Порядок і вміст детерміновані порядком `model.objects` і колонок знімка.
 */
export function emitEntityTypes(model: CompiledModel): string {
  const blocks = [JSON_TYPE]
  const taken = new Set(["Json"])
  const style = model.project.naming.attributeCase

  const byRef = new Map(
    model.objects.map((object) => [`${object.kind}.${object.name}`, object])
  )
  const lookup = (ref: MetadataRef) => byRef.get(`${ref.kind}.${ref.name}`)
  const scopeNames = new Map(model.scopeKinds.map((k) => [k.id, k.name]))

  /**
   * Ім'я інтерфейсу мусить бути унікальним у модулі, а логічні імена
   * унікальні лише в межах виду (і ім'я ТЧ може збігтися з чужим об'єктом):
   * перший у порядку виводу зберігає ім'я, наступний отримує префікс.
   */
  const claim = (name: string, prefix: string): string => {
    let candidate = name
    if (taken.has(candidate)) candidate = `${prefix}${name}`
    for (let i = 2; taken.has(candidate); i += 1)
      candidate = `${prefix}${name}${i}`
    taken.add(candidate)
    return candidate
  }

  const refName = (ref: MetadataRef) =>
    JSON.stringify(`${ref.kind}.${ref.name}`)

  /** Union значень перерахування чи `PgEnum`; інша ціль — просто string. */
  const refType = (ref: MetadataRef): string => {
    const target = lookup(ref)
    if (target === undefined) return "string"
    const def = KIND_REGISTRY[target.kind]
    if (def.materializes === "table") return "string"
    const values = ((target.data as { values?: unknown[] }).values ?? []).map(
      (value) =>
        typeof value === "string" ? value : (value as { name: string }).name
    )
    return values.length === 0
      ? "never"
      : values.map((v) => JSON.stringify(v)).join(" | ")
  }

  const valueType = (
    source: Source,
    targets: readonly MetadataRef[] | undefined,
    paired: boolean
  ): { ts: string; nullable: boolean } => {
    if ("raw" in source) return { ts: "unknown", nullable: false }
    let ts: string
    if (source.type === "Raw") {
      return { ts: "unknown", nullable: false }
    } else if (source.type === "PgEnum") {
      ts = source.enum === undefined ? "string" : refType(source.enum)
    } else if (paired) {
      const types = (targets ?? source.allowedTypes ?? []).map(refName)
      ts = `{ type: ${types.length === 0 ? "never" : types.join(" | ")}; id: string }`
    } else if (source.type === "Ref" && source.ref !== undefined) {
      ts = refType(source.ref)
    } else {
      ts = TS_OF_LOGICAL[source.type as LogicalType] ?? "unknown"
    }
    if (source.array === true) {
      ts = /[|{]/.test(ts) ? `(${ts})[]` : `${ts}[]`
    }
    return { ts, nullable: true }
  }

  const doc = (
    indent: string,
    title: LocalizedString | undefined,
    description: LocalizedString | undefined
  ): string[] => {
    const lines = [pick(title), pick(description)]
      .filter((text): text is string => text !== undefined)
      // `*/` у тексті закрив би коментар достроково.
      .flatMap((text, index) => [
        ...(index > 0 ? [""] : []),
        ...text.replaceAll("*/", "*\\/").split("\n"),
      ])
    if (lines.length === 0) return []
    if (lines.length === 1) return [`${indent}/** ${lines[0]} */`]
    return [
      `${indent}/**`,
      ...lines.map((line) =>
        line === "" ? `${indent} *` : `${indent} * ${line}`
      ),
      `${indent} */`,
    ]
  }

  const emitFields = (
    table: PhysicalTable,
    standard: ReadonlyMap<string, StandardColumnDef>,
    elements: ReadonlyMap<string, ElementSource>,
    targetsOf: (def: StandardColumnDef) => readonly MetadataRef[],
    overrides: ReadonlyMap<
      string,
      { title?: LocalizedString; description?: LocalizedString }
    >
  ): string[] => {
    const lines: string[] = []
    const keyOf = (column: PhysicalColumn) => JSON.stringify(column.origin)
    table.columns.forEach((column, index) => {
      const key = keyOf(column)
      // Поліморфне поле — пара колонок з одним походженням; поле одне.
      if (index > 0 && keyOf(table.columns[index - 1]!) === key) return
      const paired =
        index + 1 < table.columns.length &&
        keyOf(table.columns[index + 1]!) === key
      const { standard: standardName, elementId, scopeKindId } = column.origin

      let name: string
      let source: Source
      let targets: readonly MetadataRef[] | undefined
      let title: LocalizedString | undefined
      let description: LocalizedString | undefined
      const def =
        standardName === undefined ? undefined : standard.get(standardName)
      const element =
        elementId === undefined ? undefined : elements.get(elementId)
      if (def !== undefined) {
        name = standardName!
        source = def.type
        targets = def.ref === undefined ? undefined : targetsOf(def)
        const override = overrides.get(def.logicalName)
        title = override?.title ?? def.title
        description = override?.description
      } else if (element !== undefined) {
        name = element.name
        source = element
        title = element.title
        description = element.description
      } else if (scopeKindId !== undefined) {
        // Носій скоупу: логічне ім'я — ім'я виду, а тип завжди ключ кореня.
        name = scopeNames.get(scopeKindId) ?? column.name
        source = { type: "UUID" }
      } else {
        name = column.name
        source = { raw: column.type }
      }

      const { ts, nullable } = valueType(source, targets, paired)
      const readonly = column.generated === undefined ? "" : "readonly "
      const field = IDENTIFIER.test(name) ? name : JSON.stringify(name)
      lines.push(
        ...doc("  ", title, description),
        `  ${readonly}${field}: ${ts}${nullable && !column.notNull ? " | null" : ""}`
      )
    })
    return lines
  }

  for (const object of model.objects) {
    const def = KIND_REGISTRY[object.kind]
    if (def.materializes !== "table") continue
    // Основна таблиця — без `part` і без ТЧ; похідні таблиці регістрів
    // інтерфейсів не мають.
    const main = model.physical.tables.find(
      (table) =>
        table.origin.objectId === object.id &&
        table.origin.part === undefined &&
        table.origin.tabularSectionId === undefined
    )
    if (main === undefined) continue

    const data = object.data as {
      title?: LocalizedString
      description?: LocalizedString
      tabularSections?: TabularSection[]
    } & Record<string, unknown>

    const styled = (columns: readonly StandardColumnDef[]) =>
      new Map(
        columns.map((column) => [standardLogicalName(column, style), column])
      )
    const singleton = registerSingletonOf(object)
    const mainStandard = styled([
      ...(singleton === undefined ? [] : [singleton]),
      ...def.standardColumns(object.data),
    ])
    const sectionStandard = styled(
      def.tabularSectionColumns?.(object.data) ?? []
    )

    const elements = new Map<string, ElementSource>()
    const addElement = (element: ElementSource) => {
      if (element.id !== undefined) elements.set(element.id, element)
    }
    for (const field of def.columnFields) {
      for (const element of (data[field] ?? []) as ElementSource[]) {
        addElement(element)
      }
    }
    const sections =
      def.tabularSectionColumns === undefined
        ? []
        : (data.tabularSections ?? [])
    for (const section of sections) {
      for (const attribute of section.attributes) addElement(attribute)
    }

    const targetsOf = (column: StandardColumnDef): MetadataRef[] => {
      const list =
        column.ref === "owners"
          ? data.owners
          : column.ref === "recorders"
            ? data.recorderTypes
            : []
      return (list ?? []) as MetadataRef[]
    }
    const block = model.presentation.find((p) => p.objectId === object.id)
    const overrides = new Map(Object.entries(block?.standardAttributes ?? {}))

    const interfaceName = claim(object.name, object.kind)
    const sectionNames = sections.map((section) => ({
      section,
      name: claim(`${object.name}${pascal(section.name)}`, object.kind),
    }))

    const body = emitFields(main, mainStandard, elements, targetsOf, overrides)
    for (const { section, name } of sectionNames) {
      body.push(
        ...doc("  ", section.title, undefined),
        `  ${fieldName(section.name)}: ${name}[]`
      )
    }
    blocks.push(
      [
        ...doc("", data.title, data.description),
        `export interface ${interfaceName} {`,
        ...body,
        "}",
      ].join("\n")
    )

    for (const { section, name } of sectionNames) {
      const table = model.physical.tables.find(
        (candidate) =>
          candidate.origin.objectId === object.id &&
          candidate.origin.tabularSectionId === section.id
      )
      if (table === undefined) continue
      blocks.push(
        [
          ...doc("", section.title, undefined),
          `export interface ${name} {`,
          ...emitFields(table, sectionStandard, elements, targetsOf, new Map()),
          "}",
        ].join("\n")
      )
    }
  }
  return `${blocks.join("\n\n")}\n`
}

function pick(text: LocalizedString | undefined): string | undefined {
  return text?.en ?? text?.uk
}

function fieldName(name: string): string {
  return IDENTIFIER.test(name) ? name : JSON.stringify(name)
}

/** `order_items` і `orderItems` дають однаковий PascalCase-хвіст імені. */
function pascal(name: string): string {
  return name
    .split(/[^A-Za-z0-9]+/)
    .filter((part) => part !== "")
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join("")
}
