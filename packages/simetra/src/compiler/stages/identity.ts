import {
  KIND_REGISTRY,
  matchesAttributeCase,
  standardLogicalName,
  type AttributeCase,
  type MetadataKind,
  type Project,
  type ReferenceRole,
  type StandardColumnDef,
} from "simetra/model"
import { compareStrings, diagnostic, type Diagnostic } from "../diagnostics"
import { objectKey, type ParsedObject } from "./files"

export interface ResolvedReference {
  from: { file: string; pointer: string; objectId: string }
  to: { kind: MetadataKind; id: string }
  role: ReferenceRole
}

export interface IdentityStageResult {
  /** Відсортовано за (file, pointer). */
  references: ResolvedReference[]
  diagnostics: Diagnostic[]
}

type Element = Record<string, unknown>

/**
 * Простір імен: елементи, чиї логічні імена мусять бути унікальні. `styled` —
 * ім'я підлягає стилю проєкту; `reserved` — стандартні колонки таблиці, куди
 * елемент потрапить колонкою.
 */
interface Namespace {
  scope: string
  styled: boolean
  reserved: StandardColumnDef[]
  elements: NamedElement[]
}

interface NamedElement {
  pointer: string
  element: Element
  /** Стає колонкою таблиці, тож не може зайняти ім'я стандартної колонки. */
  column: boolean
}

/**
 * Стадія 2 (спека П2 §3, §8.2): id і physicalName присутні, id унікальні в
 * усій моделі, імена унікальні в межах власника й дотримуються стилю, а
 * посилання за іменем резолвляться в UUID. Першим вважається елемент, що
 * раніше за шляхом файлу, тож помилку отримує пізніший.
 */
export function checkIdentity(
  objects: readonly ParsedObject[],
  brokenNames: ReadonlySet<string>,
  project: Project | undefined
): IdentityStageResult {
  const diagnostics: Diagnostic[] = []
  // Без валідного проєкту стиль невідомий; про сам проєкт уже звітує стадія 1.
  const style = project?.naming.attributeCase
  const idOwners = new Map<string, string>()
  const objectsByName = new Map<string, ParsedObject>()

  const checkIdentified = (file: string, pointer: string, element: Element) => {
    const id = element.id
    if (typeof id !== "string") {
      diagnostics.push(diagnostic("identity.id-missing", file, `${pointer}/id`))
    } else {
      const firstFile = idOwners.get(id)
      if (firstFile === undefined) {
        idOwners.set(id, file)
      } else {
        diagnostics.push(
          diagnostic("identity.id-duplicate", file, `${pointer}/id`, {
            id,
            firstFile,
          })
        )
      }
    }
    if (element.physicalName === undefined) {
      diagnostics.push(
        diagnostic(
          "identity.physical-name-missing",
          file,
          `${pointer}/physicalName`
        )
      )
    }
  }

  for (const object of objects) {
    const data = object.data as Element
    checkIdentified(object.file, "", data)

    const key = objectKey(object.kind, object.name)
    const first = objectsByName.get(key)
    if (first === undefined) {
      objectsByName.set(key, object)
    } else {
      diagnostics.push(
        diagnostic("identity.name-duplicate", object.file, "/name", {
          name: object.name,
          scope: first.file,
        })
      )
    }

    for (const namespace of namespacesOf(object, style)) {
      const seen = new Set<string>()
      const reserved = new Set(
        style === undefined
          ? []
          : namespace.reserved.map((column) =>
              standardLogicalName(column, style)
            )
      )
      for (const { pointer, element, column } of namespace.elements) {
        checkIdentified(object.file, pointer, element)
        const name = String(element.name)
        const at = `${pointer}/name`
        if (seen.has(name)) {
          diagnostics.push(
            diagnostic("identity.name-duplicate", object.file, at, {
              name,
              scope: namespace.scope,
            })
          )
        }
        seen.add(name)
        if (
          namespace.styled &&
          style !== undefined &&
          !matchesAttributeCase(name, style)
        ) {
          diagnostics.push(
            diagnostic("identity.name-case", object.file, at, { name, style })
          )
        }
        if (column && reserved.has(name)) {
          diagnostics.push(
            diagnostic("identity.name-reserved", object.file, at, {
              name,
              kind: object.kind,
            })
          )
        }
      }
    }
  }

  const references: ResolvedReference[] = []
  for (const object of objects) {
    for (const found of KIND_REGISTRY[object.kind].references(object.data)) {
      const key = objectKey(found.ref.kind, found.ref.name)
      const target = objectsByName.get(key)
      if (target === undefined) {
        if (!brokenNames.has(key)) {
          diagnostics.push(
            diagnostic("reference.unresolved", object.file, found.pointer, {
              kind: found.ref.kind,
              name: found.ref.name,
            })
          )
        }
        continue
      }
      // Без id з обох боків резолвити нема в що; id-missing уже звітовано.
      if (object.id === undefined || target.id === undefined) continue
      references.push({
        from: {
          file: object.file,
          pointer: found.pointer,
          objectId: object.id,
        },
        to: { kind: target.kind, id: target.id },
        role: found.role,
      })
    }
  }
  references.sort(
    (a, b) =>
      compareStrings(a.from.file, b.from.file) ||
      compareStrings(a.from.pointer, b.from.pointer)
  )

  return { references, diagnostics }
}

/** Поле — з реєстру видів, тож схема виду гарантує масив (з типовим `[]`). */
function elementsAt(data: Element, field: string, base = ""): NamedElement[] {
  return (data[field] as Element[]).map((element, index) => ({
    pointer: `${base}/${field}/${index}`,
    element,
    column: true,
  }))
}

/**
 * Простори імен об'єкта. Які поля несуть елементи, каже реєстр видів:
 * елементи всіх колонкових полів виду однаково стають колонками, тож і
 * правила для них спільні, а спільний простір імен вони ділять із ТЧ
 * (спека П2 §8.2).
 */
function namespacesOf(
  object: ParsedObject,
  style: AttributeCase | undefined
): Namespace[] {
  const def = KIND_REGISTRY[object.kind]
  const data = object.data as Element
  const namespaces: Namespace[] = []

  const columns = def.columnFields.flatMap((field) => elementsAt(data, field))
  // Таблична частина — окрема таблиця, а не колонка основної.
  const sections = (
    def.tabularSectionColumns === undefined
      ? []
      : elementsAt(data, "tabularSections")
  ).map((section) => ({ ...section, column: false }))
  namespaces.push({
    scope: `${object.kind} ${object.name}`,
    styled: true,
    reserved: style === undefined ? [] : def.standardColumns(data),
    elements: [...columns, ...sections],
  })

  const sectionColumns =
    style === undefined ? [] : (def.tabularSectionColumns?.(data) ?? [])
  for (const section of sections) {
    namespaces.push({
      scope: `tabular section ${String(section.element.name)}`,
      styled: true,
      reserved: sectionColumns,
      elements: elementsAt(section.element, "attributes", section.pointer),
    })
  }

  // Значення перерахування — PascalCase за схемою, тож стиль до них не застосовний.
  if (def.valueElements) {
    namespaces.push({
      scope: `${object.kind} ${object.name} values`,
      styled: false,
      reserved: [],
      elements: elementsAt(data, "values"),
    })
  }
  return namespaces
}
