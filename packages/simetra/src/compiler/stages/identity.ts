import {
  KIND_REGISTRY,
  NO_SCOPE,
  matchesAttributeCase,
  standardLogicalName,
  type AttributeCase,
  type MetadataKind,
  type Project,
  type ReferenceRole,
  type ScopeKind,
  type StandardColumnDef,
} from "simetra/model"
import { compareStrings, diagnostic, type Diagnostic } from "../diagnostics"
import { PROJECT_FILE, objectKey, type ParsedObject } from "./files"

export interface ResolvedReference {
  from: { file: string; pointer: string; objectId: string }
  /**
   * `ScopeKind` і `Element` — цілі, що не є об'єктами метаданих (вид скоупу
   * проєкту, елемент усередині об'єкта: реквізит, ТЧ, колонка, поле); їхні id живуть в одному просторі UUID.
   */
  to: { kind: MetadataKind | "ScopeKind" | "Element"; id: string }
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

  // Види скоупу ідентифікуються раніше за об'єкти: за ними розпізнаються
  // корені й резолвиться `scope` об'єктів.
  const scopeKinds = project?.scopeKinds ?? []
  const scopeKindsByName = new Map<string, ScopeKind>()
  scopeKinds.forEach((kind, index) => {
    const pointer = `/scopeKinds/${index}`
    checkIdentified(PROJECT_FILE, pointer, kind)
    const at = `${pointer}/name`
    if (scopeKindsByName.has(kind.name)) {
      diagnostics.push(
        diagnostic("identity.name-duplicate", PROJECT_FILE, at, {
          name: kind.name,
          scope: "project scope kinds",
        })
      )
    } else {
      scopeKindsByName.set(kind.name, kind)
    }
    if (style !== undefined && !matchesAttributeCase(kind.name, style)) {
      diagnostics.push(
        diagnostic("identity.name-case", PROJECT_FILE, at, {
          name: kind.name,
          style,
        })
      )
    }
  })
  // Один корінь на вид: два види на одному корені зробили б значення скоупу
  // двозначним, а скоуп-колонка цього об'єкта не мала б чийого імені.
  const rootsSeen = new Set<string>()
  scopeKinds.forEach((kind, index) => {
    const [at, key] =
      "object" in kind.root
        ? [
            `/scopeKinds/${index}/root/object`,
            `object ${objectKey(kind.root.object.kind, kind.root.object.name)}`,
          ]
        : [
            `/scopeKinds/${index}/root/external`,
            `external ${kind.root.external.schema}.${kind.root.external.table}(${kind.root.external.column})`,
          ]
    if (rootsSeen.has(key)) {
      diagnostics.push(diagnostic("scope.root-duplicate", PROJECT_FILE, at))
    }
    rootsSeen.add(key)
  })
  // Корінь не має скоуп-колонки, тож ім'я виду в ньому нічого не займає.
  const rootKeys = new Set(
    scopeKinds.flatMap((kind) =>
      "object" in kind.root
        ? [objectKey(kind.root.object.kind, kind.root.object.name)]
        : []
    )
  )

  // Без валідного проєкту види невідомі, а про сам проєкт звітує стадія 1.
  const checkDeclaration = (object: ParsedObject): ScopeKind | undefined => {
    if (project === undefined) return undefined
    const policy = KIND_REGISTRY[object.kind].scope
    if (policy === "absent") return undefined
    const { scope } = object.data as { scope?: string }
    if (scope === undefined) {
      if (policy === "required" && scopeKinds.length > 0) {
        diagnostics.push(
          diagnostic("scope.declaration-missing", object.file, "", {
            kind: object.kind,
            name: object.name,
          })
        )
      }
      return undefined
    }
    if (scope === NO_SCOPE) return undefined
    const found = scopeKindsByName.get(scope)
    if (found === undefined) {
      diagnostics.push(
        diagnostic("scope.unknown-kind", object.file, "/scope", {
          name: scope,
        })
      )
    }
    return found
  }
  const scopeOf = new Map<ParsedObject, ScopeKind>()

  for (const object of objects) {
    const data = object.data as Element
    checkIdentified(object.file, "", data)
    const scopeKind = checkDeclaration(object)
    if (scopeKind !== undefined) scopeOf.set(object, scopeKind)
    // `declared` — фізичну форму файл описує сам і скоуп-колонку називає
    // `scopeColumn`, тож збігу з наміром платформи там немає.
    const collides =
      scopeKind !== undefined &&
      !KIND_REGISTRY[object.kind].declared &&
      !rootKeys.has(objectKey(object.kind, object.name))

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

    // Скоуп-колонка займає логічне ім'я виду; стандартні реквізити об'єкта
    // пишуться в стилі проєкту, тож звіряємо саме з ними. Один раз на об'єкт.
    let standardCollision = false
    for (const namespace of namespacesOf(object, style)) {
      const seen = new Set<string>()
      const reserved = new Set(
        style === undefined
          ? []
          : namespace.reserved.map((column) =>
              standardLogicalName(column, style)
            )
      )
      if (collides && !standardCollision && reserved.has(scopeKind.name)) {
        standardCollision = true
        diagnostics.push(
          diagnostic("scope.attribute-name-collision", object.file, "/scope", {
            name: scopeKind.name,
            kind: object.kind,
          })
        )
      }
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
        if (collides && name === scopeKind.name) {
          diagnostics.push(
            diagnostic("scope.attribute-name-collision", object.file, at, {
              name,
              kind: object.kind,
            })
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
  const resolveObjectRef = (
    file: string,
    fromId: string | undefined,
    found: { pointer: string; ref: { kind: string; name: string } },
    role: ReferenceRole
  ) => {
    const key = objectKey(found.ref.kind, found.ref.name)
    const target = objectsByName.get(key)
    if (target === undefined) {
      if (!brokenNames.has(key)) {
        diagnostics.push(
          diagnostic("reference.unresolved", file, found.pointer, {
            kind: found.ref.kind,
            name: found.ref.name,
          })
        )
      }
      return
    }
    // Без id з обох боків резолвити нема в що; id-missing уже звітовано.
    if (fromId === undefined || target.id === undefined) return
    references.push({
      from: { file, pointer: found.pointer, objectId: fromId },
      to: { kind: target.kind, id: target.id },
      role,
    })
  }
  scopeKinds.forEach((kind, index) => {
    if (!("object" in kind.root)) return
    resolveObjectRef(
      PROJECT_FILE,
      kind.id,
      {
        pointer: `/scopeKinds/${index}/root/object`,
        ref: kind.root.object,
      },
      "scopeKind.root"
    )
  })
  for (const object of objects) {
    for (const found of KIND_REGISTRY[object.kind].references(object.data)) {
      resolveObjectRef(object.file, object.id, found, found.role)
    }
    const scopeKind = scopeOf.get(object)
    if (scopeKind?.id !== undefined && object.id !== undefined) {
      references.push({
        from: { file: object.file, pointer: "/scope", objectId: object.id },
        to: { kind: "ScopeKind", id: scopeKind.id },
        role: "object.scope",
      })
    }
    checkScopeColumn(object, references, diagnostics)
    checkBalanceControl(object, references, diagnostics)
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

/**
 * `scopeColumn` прийнятої таблиці називає її власну колонку за логічним
 * іменем; існування колонки — справа цієї стадії, бо імена резолвляться тут.
 */
function checkScopeColumn(
  object: ParsedObject,
  references: ResolvedReference[],
  diagnostics: Diagnostic[]
) {
  const { scopeColumn, columns } = object.data as {
    scopeColumn?: string
    columns?: Element[]
  }
  if (scopeColumn === undefined) return
  const column = (columns ?? []).find((c) => c.name === scopeColumn)
  if (column === undefined) {
    diagnostics.push(
      diagnostic("customTable.column-unknown", object.file, "/scopeColumn", {
        column: scopeColumn,
        table: object.name,
      })
    )
    return
  }
  if (typeof column.id !== "string" || object.id === undefined) return
  references.push({
    from: { file: object.file, pointer: "/scopeColumn", objectId: object.id },
    to: { kind: "Element", id: column.id },
    role: "customTable.scopeColumn",
  })
}

/**
 * `balanceControl` регістра називає його ресурси за логічним іменем; як і
 * `scopeColumn`, ім'я резолвиться тут і потрапляє в індекс посилань, щоб
 * перейменування ресурсу не зламало налаштування мовчки.
 */
function checkBalanceControl(
  object: ParsedObject,
  references: ResolvedReference[],
  diagnostics: Diagnostic[]
) {
  const { balanceControl, resources } = object.data as {
    balanceControl?: { resources: string[] }
    resources?: Element[]
  }
  if (balanceControl === undefined) return
  balanceControl.resources.forEach((name, index) => {
    const pointer = `/balanceControl/resources/${index}`
    const resource = (resources ?? []).find((r) => r.name === name)
    if (resource === undefined) {
      diagnostics.push(
        diagnostic("register.balance-control-resource", object.file, pointer, {
          name,
        })
      )
      return
    }
    if (typeof resource.id !== "string" || object.id === undefined) return
    references.push({
      from: { file: object.file, pointer, objectId: object.id },
      to: { kind: "Element", id: resource.id },
      role: "register.balanceControl",
    })
  })
}
