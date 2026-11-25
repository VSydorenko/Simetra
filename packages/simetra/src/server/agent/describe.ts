import type {
  LocalizedString,
  MetadataRef,
  ObjectOperation,
  RuntimeAttribute,
  RuntimeCatalog,
  RuntimeObject,
} from "simetra/model"
import { operationsOf, verbsOf, type AgentVerb } from "./verbs"

/** An attribute in a description: what an agent needs to build a query and values. */
export interface AgentAttributeDescription {
  name: string
  type: string
  array?: true
  required: boolean
  maxLength?: number
  /** May be set on create / on update. */
  insert: boolean
  update: boolean
  generated?: true
  enumValues?: { name: string; label: string }[]
  /** The target of a single-target `Ref`. */
  ref?: MetadataRef
  /** The targets of a polymorphic `Ref` (`allowedTypes`). */
  allowedTypes?: MetadataRef[]
  title?: LocalizedString
  description?: LocalizedString
}

export interface AgentObjectDescription {
  object: MetadataRef
  kindLabel: string
  title?: LocalizedString
  description?: LocalizedString
  /** The logical name of the row key and the presentation attribute. */
  key: string
  presentation?: string
  attributes: AgentAttributeDescription[]
  tabularSections: {
    name: string
    title?: LocalizedString
    attributes: AgentAttributeDescription[]
  }[]
  verbs: AgentVerb[]
  operations: ObjectOperation[]
}

/** A list entry: an object without its fields. */
export interface AgentObjectSummary {
  object: MetadataRef
  title?: LocalizedString
  description?: LocalizedString
  verbs: AgentVerb[]
  operations: ObjectOperation[]
}

const refOf = (o: { kind: RuntimeObject["kind"]; name: string }) => ({
  kind: o.kind,
  name: o.name,
})

// Явний перелік полів, а не відфільтрована копія: нове поле `RuntimeObject`
// (функції ядра, контексти, обмеження, членство) не виходить назовні само.
function attributeOf(
  catalog: RuntimeCatalog,
  a: RuntimeAttribute
): AgentAttributeDescription {
  const target =
    a.ref === undefined
      ? undefined
      : catalog.objects.find((o) => o.id === a.ref!.object)
  return {
    name: a.name,
    type: a.type,
    ...(a.array === undefined ? {} : { array: a.array }),
    required: a.required,
    ...(a.maxLength === undefined ? {} : { maxLength: a.maxLength }),
    insert: a.insert,
    update: a.update,
    ...(a.generated === undefined ? {} : { generated: a.generated }),
    ...(a.enumValues === undefined ? {} : { enumValues: a.enumValues }),
    ...(target === undefined ? {} : { ref: refOf(target) }),
    ...(a.pair === undefined
      ? {}
      : { allowedTypes: a.pair.targets.map((t) => t.object) }),
    ...(a.title === undefined ? {} : { title: a.title }),
    ...(a.description === undefined ? {} : { description: a.description }),
  }
}

export function describeObject(
  catalog: RuntimeCatalog,
  o: RuntimeObject
): AgentObjectDescription {
  return {
    object: refOf(o),
    kindLabel: o.kindLabel,
    ...(o.title === undefined ? {} : { title: o.title }),
    ...(o.description === undefined ? {} : { description: o.description }),
    key: o.keyName,
    ...(o.presentation === undefined
      ? {}
      : { presentation: o.presentation.attribute }),
    attributes: o.attributes.map((a) => attributeOf(catalog, a)),
    tabularSections: o.tabularSections.map((s) => ({
      name: s.name,
      ...(s.title === undefined ? {} : { title: s.title }),
      attributes: s.attributes.map((a) => attributeOf(catalog, a)),
    })),
    verbs: verbsOf(o),
    operations: operationsOf(o),
  }
}

export function summarizeObject(o: RuntimeObject): AgentObjectSummary {
  return {
    object: refOf(o),
    ...(o.title === undefined ? {} : { title: o.title }),
    ...(o.description === undefined ? {} : { description: o.description }),
    verbs: verbsOf(o),
    operations: operationsOf(o),
  }
}
