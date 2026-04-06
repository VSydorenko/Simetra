import type {
  MetadataKind,
  MetadataObject,
  Attribute,
  TabularSection,
  ProjectModel,
} from "@simetra/core"
import { fieldTypeSchema, referenceableKindSchema } from "@simetra/core"
import { KIND_TO_KEY } from "@/lib/metadata-defaults"
import { formatRefDisplay } from "@/lib/format-ref-display"
import { SECTION_ORDER, type TreeNodeData } from "./tree-types"

/** Вузли полів для attributes/dimensions/resources */
function buildFieldNodes(
  kind: MetadataKind,
  objectName: string,
  groupKey: string,
  attrs: Attribute[],
  tabularSectionName?: string
): TreeNodeData[] {
  const basePath = tabularSectionName
    ? `${kind}/${objectName}/tabularSections/${tabularSectionName}`
    : `${kind}/${objectName}/${groupKey}`

  return attrs.map((attr) => ({
    id: `${basePath}/${attr.name}`,
    name: attr.name,
    kind,
    nodeType: "field" as const,
    objectName,
    groupKey: tabularSectionName ? "attributes" : groupKey,
    tabularSectionName,
    fieldType: attr.type,
    fieldTypeDisplay: formatRefDisplay(attr),
  }))
}

/** Вузол структурної групи (📂 Реквізити, 📂 Виміри тощо) */
function buildGroupNode(
  kind: MetadataKind,
  objectName: string,
  groupKey: string,
  children: TreeNodeData[]
): TreeNodeData {
  return {
    id: `${kind}/${objectName}/${groupKey}`,
    name: groupKey,
    kind,
    nodeType: "group",
    objectName,
    groupKey,
    children,
  }
}

/** Дочірні вузли обʼєкта залежно від kind */
function buildObjectChildren(
  kind: MetadataKind,
  obj: MetadataObject
): TreeNodeData[] {
  const children: TreeNodeData[] = []

  if (kind === "Enumeration") {
    if ("values" in obj) {
      const values = obj.values as { name: string }[]
      children.push(
        buildGroupNode(
          kind,
          obj.name,
          "values",
          values.map((v) => ({
            id: `${kind}/${obj.name}/values/${v.name}`,
            name: v.name,
            kind,
            nodeType: "field" as const,
            objectName: obj.name,
            groupKey: "values",
          }))
        )
      )
    }
  } else if (
    kind === "InformationRegister" ||
    kind === "AccumulationRegister"
  ) {
    if ("dimensions" in obj) {
      children.push(
        buildGroupNode(
          kind,
          obj.name,
          "dimensions",
          buildFieldNodes(
            kind,
            obj.name,
            "dimensions",
            obj.dimensions as Attribute[]
          )
        )
      )
    }
    if ("resources" in obj) {
      children.push(
        buildGroupNode(
          kind,
          obj.name,
          "resources",
          buildFieldNodes(
            kind,
            obj.name,
            "resources",
            obj.resources as Attribute[]
          )
        )
      )
    }
    if ("attributes" in obj) {
      children.push(
        buildGroupNode(
          kind,
          obj.name,
          "attributes",
          buildFieldNodes(
            kind,
            obj.name,
            "attributes",
            obj.attributes as Attribute[]
          )
        )
      )
    }
  } else if (kind === "Constant") {
    // Константа не має дочірніх структурних груп
  } else {
    // Catalog, Document, CustomTable
    if ("attributes" in obj) {
      children.push(
        buildGroupNode(
          kind,
          obj.name,
          "attributes",
          buildFieldNodes(
            kind,
            obj.name,
            "attributes",
            obj.attributes as Attribute[]
          )
        )
      )
    }
    if (
      "tabularSections" in obj &&
      (kind === "Catalog" || kind === "Document")
    ) {
      const sections = obj.tabularSections as TabularSection[]
      children.push(
        buildGroupNode(
          kind,
          obj.name,
          "tabularSections",
          sections.map((section) => ({
            id: `${kind}/${obj.name}/tabularSections/${section.name}`,
            name: section.name,
            kind,
            nodeType: "tabularSection" as const,
            objectName: obj.name,
            groupKey: "tabularSections",
            children: buildFieldNodes(
              kind,
              obj.name,
              "attributes",
              section.attributes,
              section.name
            ),
          }))
        )
      )
    }
  }

  return children
}

/** Перевірка, чи будь-який нащадок обʼєкта містить збіг з пошуковим запитом */
function objectMatchesSearch(obj: MetadataObject, lowerQuery: string): boolean {
  if (obj.name.toLowerCase().includes(lowerQuery)) return true

  if ("attributes" in obj) {
    if (
      (obj.attributes as Attribute[]).some((a) =>
        a.name.toLowerCase().includes(lowerQuery)
      )
    ) {
      return true
    }
  }

  if ("dimensions" in obj) {
    if (
      (obj.dimensions as Attribute[]).some((a) =>
        a.name.toLowerCase().includes(lowerQuery)
      )
    ) {
      return true
    }
  }

  if ("resources" in obj) {
    if (
      (obj.resources as Attribute[]).some((a) =>
        a.name.toLowerCase().includes(lowerQuery)
      )
    ) {
      return true
    }
  }

  if ("tabularSections" in obj) {
    const sections = obj.tabularSections as TabularSection[]
    if (
      sections.some(
        (s) =>
          s.name.toLowerCase().includes(lowerQuery) ||
          s.attributes.some((a) => a.name.toLowerCase().includes(lowerQuery))
      )
    ) {
      return true
    }
  }

  if ("values" in obj) {
    if (
      (obj.values as { name: string }[]).some((v) =>
        v.name.toLowerCase().includes(lowerQuery)
      )
    ) {
      return true
    }
  }

  return false
}

export function buildTreeData(
  model: ProjectModel,
  searchQuery: string
): TreeNodeData[] {
  const lowerQuery = searchQuery.toLowerCase()

  return SECTION_ORDER.map((kind) => {
    const key = KIND_TO_KEY[kind]
    const objects = model[key] as MetadataObject[]

    const filtered = searchQuery
      ? objects.filter((o) => objectMatchesSearch(o, lowerQuery))
      : objects

    return {
      id: kind,
      name: kind,
      kind,
      nodeType: "kind" as const,
      objectCount: objects.length,
      children: filtered.map((obj) => ({
        id: `${kind}/${obj.name}`,
        name: obj.name,
        kind,
        nodeType: "object" as const,
        objectName: obj.name,
        children: buildObjectChildren(kind, obj),
      })),
    }
  })
}

// --- Побудова дерева для Data Type Editor діалогу ---

/** Примітивні типи (все окрім Ref — Ref представлений через refKindGroup/refTarget) */
const PRIMITIVE_TYPES = fieldTypeSchema.options.filter((t) => t !== "Ref")

/** Referenceable kinds — source of truth з core */
export const REFERENCEABLE_KINDS = referenceableKindSchema.options

/** Резолвер локалізованих лейблів для пошуку у Data Type Editor */
export type LabelResolver = (key: string) => string

/** Параметри побудови дерева типів */
export interface TypeEditorTreeOptions {
  /** Які kinds показувати (дефолт: REFERENCEABLE_KINDS) */
  allowedKinds?: readonly MetadataKind[]
  /** Чи показувати примітивні типи (дефолт: true) */
  includePrimitives?: boolean
}

export function buildTypeEditorTree(
  model: ProjectModel,
  searchQuery: string,
  getLabel?: LabelResolver,
  options?: TypeEditorTreeOptions
): TreeNodeData[] {
  const lowerQuery = searchQuery.toLowerCase()
  const nodes: TreeNodeData[] = []
  const allowedKinds = options?.allowedKinds ?? REFERENCEABLE_KINDS
  const includePrimitives = options?.includePrimitives ?? true

  // Примітивні типи
  if (includePrimitives) {
    for (const ft of PRIMITIVE_TYPES) {
      if (searchQuery) {
        const label = getLabel?.(`fieldType.${ft}`) ?? ft
        if (
          !ft.toLowerCase().includes(lowerQuery) &&
          !label.toLowerCase().includes(lowerQuery)
        )
          continue
      }
      nodes.push({
        id: `type/${ft}`,
        name: ft,
        nodeType: "primitiveType",
        fieldTypeValue: ft,
        selectable: true,
      })
    }
  }

  // Reference kind groups + targets
  for (const refKind of allowedKinds) {
    const key = KIND_TO_KEY[refKind]
    const objects = model[key] as MetadataObject[]

    const filteredObjects = searchQuery
      ? objects.filter((o) => o.name.toLowerCase().includes(lowerQuery))
      : objects

    // Показувати kind group, якщо є збіг у дочірніх або сам kind збігається
    const kindLabel = getLabel?.(`metadata.kind.${refKind}`) ?? refKind
    const kindMatches =
      refKind.toLowerCase().includes(lowerQuery) ||
      kindLabel.toLowerCase().includes(lowerQuery)
    if (searchQuery && !kindMatches && filteredObjects.length === 0) continue

    // При збігу kind — показати всі дочірні targets
    const objectsToShow = !searchQuery || kindMatches ? objects : filteredObjects

    const children: TreeNodeData[] = objectsToShow.map((obj) => ({
      id: `ref/${refKind}/${obj.name}`,
      name: obj.name,
      kind: refKind as MetadataKind,
      nodeType: "refTarget" as const,
      fieldTypeValue: "Ref" as const,
      refTarget: { kind: refKind as MetadataKind, name: obj.name },
      selectable: true,
    }))

    nodes.push({
      id: `refKind/${refKind}`,
      name: `${refKind}Ref`,
      kind: refKind as MetadataKind,
      nodeType: "refKindGroup",
      selectable: false,
      children,
    })
  }

  return nodes
}
