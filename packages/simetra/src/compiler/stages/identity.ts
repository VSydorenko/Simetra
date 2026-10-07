import {
  KIND_REGISTRY,
  NO_SCOPE,
  expectsKindLabel,
  matchesAttributeCase,
  parseExpression,
  walkExpr,
  standardLogicalName,
  type AttributeCase,
  type Expr,
  type MetadataKind,
  type MovementDecl,
  type Project,
  type ReferenceRole,
  type ScopeKind,
  type Span,
  type StandardColumnDef,
} from "simetra/model"
import {
  compareStrings,
  diagnostic,
  toPointer,
  valueAt,
  type Diagnostic,
} from "../diagnostics"
import { PROJECT_FILE, objectKey, type ParsedObject } from "./files"

export interface ResolvedReference {
  from: { file: string; pointer: string; objectId: string }
  /**
   * `ScopeKind` і `Element` — цілі, що не є об'єктами метаданих (вид скоупу
   * проєкту, елемент усередині об'єкта: реквізит, ТЧ, колонка, поле); їхні id живуть в одному просторі UUID.
   */
  to: { kind: MetadataKind | "ScopeKind" | "Element"; id: string }
  role: ReferenceRole
  /**
   * Токен імені у виразі поля, на яке вказує pointer: пів-інтервал
   * [start, end) рівно навколо імені, тож каскад заміняє лише його.
   */
  span?: { start: number; end: number }
  /** 1-базний рядок маркера в `.sql`: pointer на весь файл місця не вказує. */
  line?: number
}

/**
 * Ролі, де рядок файлу — логічне ім'я колонки прийнятої таблиці чи цілі її FK.
 * Одна множина для знімка (ім'я → id елемента) і для стадії 3 (id → фізичне
 * ім'я): розійдись вони, хеш і фізична модель читали б різні позиції.
 * Перейменування реквізиту цілі FK тоді не зсуває фрагмент прийнятої таблиці.
 */
export const COLUMN_NAME_ROLES: ReadonlySet<ReferenceRole> =
  new Set<ReferenceRole>(["customTable.column", "customTable.foreignKeyTarget"])

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
  /**
   * Мітки (`physicalName`) унікальні в межах простору: так у предвизначених
   * елементів, бо мітку несе один рядок на скоуп. Колонкам унікальність
   * фізичних імен перевіряє стадія 4 у межах таблиці.
   */
  uniqueLabels?: true
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
  // Мітка виду — літерал даних у колонці виду поліморфних пар і в контракті
  // прав, тож унікальна на весь проєкт, а не в межах схеми PG.
  const labelOwners = new Map<string, string>()

  const checkKindLabel = (object: ParsedObject, data: Element) => {
    const label = data.kindLabel
    const expected = expectsKindLabel(object.kind, data)
    if (label === undefined) {
      if (expected) {
        diagnostics.push(
          diagnostic("identity.kind-label-missing", object.file, "/kindLabel")
        )
      }
      return
    }
    if (!expected) {
      diagnostics.push(
        diagnostic("identity.kind-label-not-allowed", object.file, "/kindLabel")
      )
      return
    }
    if (typeof label !== "string") return
    const firstFile = labelOwners.get(label)
    if (firstFile === undefined) {
      labelOwners.set(label, object.file)
    } else {
      diagnostics.push(
        diagnostic("identity.kind-label-duplicate", object.file, "/kindLabel", {
          label,
          firstFile,
        })
      )
    }
  }

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
    checkKindLabel(object, data)
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
      const labels = new Set<string>()
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
        const label = element.physicalName
        if (namespace.uniqueLabels && typeof label === "string") {
          if (labels.has(label)) {
            diagnostics.push(
              diagnostic(
                "identity.name-duplicate",
                object.file,
                `${pointer}/physicalName`,
                { name: label, scope: `${namespace.scope} labels` }
              )
            )
          }
          labels.add(label)
        }
        if (
          namespace.styled &&
          style !== undefined &&
          !matchesAttributeCase(name, style)
        ) {
          diagnostics.push(
            diagnostic("identity.name-case", object.file, at, { name, style })
          )
        }
        if (collides && column && name === scopeKind.name) {
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
  ): ParsedObject | undefined => {
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
    return target
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
      const target = resolveObjectRef(object.file, object.id, found, found.role)
      if (target !== undefined) {
        resolveEnumDefault(
          object,
          found.pointer,
          found.role,
          target,
          references
        )
      }
    }
    const scopeKind = scopeOf.get(object)
    if (scopeKind?.id !== undefined && object.id !== undefined) {
      references.push({
        from: { file: object.file, pointer: "/scope", objectId: object.id },
        to: { kind: "ScopeKind", id: scopeKind.id },
        role: "object.scope",
      })
    }
    resolveElementReferences(
      object,
      objectsByName,
      style,
      references,
      diagnostics
    )
    checkBalanceControl(object, references, diagnostics)
    if (style !== undefined) {
      resolveMovements(object, objectsByName, style, references, diagnostics)
    }
    resolveMovementBlocks(object, objects, brokenNames, references, diagnostics)
  }
  references.sort(
    (a, b) =>
      compareStrings(a.from.file, b.from.file) ||
      compareStrings(a.from.pointer, b.from.pointer) ||
      (a.line ?? 0) - (b.line ?? 0)
  )

  return { references, diagnostics }
}

/** Роль типового значення за роллю одиночного `Ref`, що його несе. */
const ENUM_DEFAULT_ROLES: Partial<Record<ReferenceRole, ReferenceRole>> = {
  "attribute.ref": "attribute.enumDefault",
  "constant.ref": "constant.enumDefault",
}

/**
 * `defaultValue` одиночного `Ref` на перерахування — логічне ім'я значення
 * (спека §5), тобто посилання за іменем: воно йде в індекс, щоб каскад
 * перейменування значення його бачив, а стадія 4 не звіряла ім'я вдруге.
 * Невідоме значення тут не звітується: відсутність запису діагностує стадія 4
 * (`reference.default-unknown-value`) поряд з іншими правилами типового значення.
 */
function resolveEnumDefault(
  object: ParsedObject,
  refPointer: string,
  refRole: ReferenceRole,
  target: ParsedObject,
  references: ResolvedReference[]
) {
  const role = ENUM_DEFAULT_ROLES[refRole]
  if (role === undefined || !KIND_REGISTRY[target.kind].valueElements) return
  if (object.id === undefined) return
  const pointer = `${refPointer.replace(/\/ref$/, "")}/defaultValue`
  const value = valueAt(object.data, pointer)
  if (typeof value !== "string") return
  const { values } = target.data as { values: Element[] }
  const found = values.find((v) => v.name === value)
  if (typeof found?.id !== "string") return
  references.push({
    from: { file: object.file, pointer, objectId: object.id },
    to: { kind: "Element", id: found.id },
    role,
  })
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

  // Іменовані елементи без колонок (предвизначені елементи довідника): ім'я —
  // PascalCase за схемою, як у значення перерахування, тож стиль до нього не
  // застосовний; `id` глобальний, мітка `physicalName` обов'язкова й
  // унікальна в межах довідника — вона ключ засіву й пошуку (спека П2 §5).
  for (const field of def.namedElementFields ?? []) {
    namespaces.push({
      scope: `${object.kind} ${object.name} predefined items`,
      styled: false,
      reserved: [],
      elements: elementsAt(data, field).map((named) => ({
        ...named,
        column: false,
      })),
      uniqueLabels: true,
    })
  }

  // Значення перерахування — PascalCase за схемою, тож стиль до них не застосовний.
  if (def.valueElements) {
    namespaces.push({
      scope: `${object.kind} ${object.name} values`,
      styled: false,
      reserved: [],
      elements: elementsAt(data, "values"),
      // Мітка — значення в `CHECK (… IN (…))` і в даних: дві однакові
      // зробили б значення нерозрізненними.
      uniqueLabels: true,
    })
  }
  return namespaces
}

/**
 * Колонки, які опис об'єкта називає логічним іменем (ключі, індекси й FK
 * прийнятої таблиці, `scopeColumn`), резолвляться тут в id елемента: стадії
 * 3–4 читають індекс, а не ім'я вдруге, а перейменування колонки чи реквізиту
 * цілі бачить каскад. Колонку чужого об'єкта шукаємо лише в таблиці: ціль без
 * таблиці звітує стадія 4 (`reference.not-referenceable`), а невідома ціль —
 * `reference.unresolved`.
 */
function resolveElementReferences(
  object: ParsedObject,
  objectsByName: ReadonlyMap<string, ParsedObject>,
  style: AttributeCase | undefined,
  references: ResolvedReference[],
  diagnostics: Diagnostic[]
) {
  const found = KIND_REGISTRY[object.kind].elementReferences?.(object.data)
  if (found === undefined) return
  const tables = new Map<
    ParsedObject,
    Map<string, string | undefined> | undefined
  >()
  const tableOf = (target: ParsedObject) => {
    if (!tables.has(target)) tables.set(target, columnTable(target, style))
    return tables.get(target)
  }
  for (const { pointer, name, owner, role } of found) {
    const target =
      owner === undefined
        ? object
        : objectsByName.get(objectKey(owner.kind, owner.name))
    if (
      target === undefined ||
      KIND_REGISTRY[target.kind].materializes !== "table"
    ) {
      continue
    }
    const table = tableOf(target)
    if (table === undefined) continue
    if (!table.has(name)) {
      diagnostics.push(
        diagnostic("customTable.column-unknown", object.file, pointer, {
          column: name,
          table: target.name,
        })
      )
      continue
    }
    const id = table.get(name)
    if (id === undefined || object.id === undefined) continue
    references.push({
      from: { file: object.file, pointer, objectId: object.id },
      to: { kind: "Element", id },
      role,
    })
  }
}

/**
 * Колонки таблиці об'єкта за логічним іменем → id елемента: стандартні
 * колонки виду (синтетичний id, як у виразах конструктора) і елементи
 * колонкових полів. Поліморфна пара однієї колонки не має, тож її назвати не
 * можна. Елемент без id лишається в таблиці (`undefined`): відсутній id уже
 * звітовано, і ім'я не має ставати ще й невідомою колонкою. Без стилю проєкту
 * логічні імена стандартних колонок невідомі — таблиці немає, а про проєкт
 * звітує стадія 1.
 */
function columnTable(
  object: ParsedObject,
  style: AttributeCase | undefined
): Map<string, string | undefined> | undefined {
  const def = KIND_REGISTRY[object.kind]
  const data = object.data as Element
  const standard = def
    .standardColumns(data)
    .filter((column) => column.polymorphic === undefined)
  if (style === undefined && standard.length > 0) return undefined
  const table = new Map<string, string | undefined>(
    style === undefined ? [] : nameTable(object.id ?? "", [], standard, style)
  )
  for (const field of def.columnFields) {
    for (const element of (data[field] as Element[] | undefined) ?? []) {
      table.set(
        String(element.name),
        typeof element.id === "string" ? element.id : undefined
      )
    }
  }
  return table
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
  const seen = new Set<string>()
  balanceControl.resources.forEach((name, index) => {
    const pointer = `/balanceControl/resources/${index}`
    // Повтор не пише друге посилання: індекс має одну дугу на ресурс, а
    // скаржимося на повтор, не на першу появу.
    if (seen.has(name)) {
      diagnostics.push(
        diagnostic("register.balance-control-duplicate", object.file, pointer, {
          name,
        })
      )
      return
    }
    seen.add(name)
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

/** Елемент усередині об'єкта, на який можна послатися у виразі за іменем. */
type NameTable = Map<string, string>

/**
 * Синтетичний id стандартного реквізиту: власник + канонічне ім'я, тож зміна
 * стилю проєкту id не міняє. Стандартний реквізит не має власного UUID, а
 * індекс посилань мусить називати його так само, як елемент.
 */
export function standardElementId(
  ownerId: string,
  column: StandardColumnDef
): string {
  return `${ownerId}#${column.logicalName}`
}

/**
 * Імена, доступні у виразі: власні елементи (за їх UUID) і стандартні
 * реквізити (за логічним іменем у стилі проєкту; синтетичний id — канонічне
 * ім'я, щоб зміна стилю не міняла id).
 */
function nameTable(
  ownerId: string,
  elements: readonly Element[],
  standard: readonly StandardColumnDef[],
  style: AttributeCase
): NameTable {
  const table: NameTable = new Map()
  for (const column of standard) {
    table.set(
      standardLogicalName(column, style),
      standardElementId(ownerId, column)
    )
  }
  for (const element of elements) {
    if (typeof element.id === "string")
      table.set(String(element.name), element.id)
  }
  return table
}

/**
 * Регістр приймає рухи документа, лише коли рухи ключує реєстратор: оболонка
 * проведення переписує їх за реєстратором (спека §7), а незалежний регістр
 * пишуть за ключем запису, і реєстратора в нього немає.
 */
export function registerTargetError(
  target: ParsedObject
): "posting.register-kind" | "posting.register-independent" | undefined {
  const keys = KIND_REGISTRY[target.kind].registerKeys?.(target.data)
  if (keys === undefined) return "posting.register-kind"
  return keys.movementsPrimaryKey === "recorder"
    ? undefined
    : "posting.register-independent"
}

/**
 * Маркер блоку — `<Name>` або `<Kind>.<Name>`. Кваліфікована форма однозначна;
 * проста допустима, лише коли таке ім'я носить рівно один вид регістра.
 * Ціль не залежить від сусідніх оголошень документа: перейменування чи
 * додавання регістра в `registerMovements` не має тихо перемкнути блок.
 * Маркер мусить бути в індексі посилань, щоб каскад перейменування його
 * переписав.
 */
function resolveMovementBlocks(
  object: ParsedObject,
  objects: readonly ParsedObject[],
  brokenNames: ReadonlySet<string>,
  references: ResolvedReference[],
  diagnostics: Diagnostic[]
) {
  if (object.id === undefined) return
  for (const block of object.movementBlocks ?? []) {
    const at = (
      code:
        | "reference.unresolved"
        | "posting.register-kind"
        | "posting.register-independent",
      params: Record<string, string | number>
    ) =>
      diagnostics.push(
        diagnostic(code, block.file, "", { ...params, line: block.line })
      )
    const dot = block.register.indexOf(".")
    const kind = dot < 0 ? undefined : block.register.slice(0, dot)
    const name = dot < 0 ? block.register : block.register.slice(dot + 1)

    let target: ParsedObject | undefined
    if (kind !== undefined) {
      target = objects.find((o) => o.kind === kind && o.name === name)
      if (target === undefined) {
        if (!brokenNames.has(objectKey(kind, name))) {
          at("reference.unresolved", { kind, name })
        }
        continue
      }
    } else {
      const candidates = objects.filter(
        (o) =>
          o.name === name && KIND_REGISTRY[o.kind].registerKeys !== undefined
      )
      if (candidates.length === 0) {
        const broken = [...brokenNames].some((key) => key.endsWith(`/${name}`))
        if (!broken) at("reference.unresolved", { kind: "Register", name })
        continue
      }
      if (candidates.length > 1) {
        diagnostics.push(
          diagnostic("reference.ambiguous", block.file, "", {
            name,
            candidates: candidates.map((o) => `${o.kind}.${o.name}`).join(", "),
            line: block.line,
          })
        )
        continue
      }
      target = candidates[0]!
    }
    const error = registerTargetError(target)
    if (error !== undefined) {
      at(error, { kind: target.kind, name: target.name })
      continue
    }
    if (target.id === undefined) continue
    references.push({
      from: { file: block.file, pointer: "", objectId: object.id },
      to: { kind: target.kind, id: target.id },
      role: "posting.movementsBlock",
      line: block.line,
    })
  }
}

/**
 * Імена у виразах конструктора рухів документа резолвляться в UUID, щоб
 * перейменування поля, ТЧ чи реєстру не ламало рухи мовчки. Цілісність
 * (типи, `row.` без ТЧ, вид регістра) — справа стадії 4; якщо ім'я чи ціль
 * не знайдені, звітується лише відсутність імені, а розбір виразу вже
 * перевірила T0 (`posting.parse`), тож зламаний вираз тут пропускається.
 */
function resolveMovements(
  object: ParsedObject,
  objectsByName: ReadonlyMap<string, ParsedObject>,
  style: AttributeCase,
  references: ResolvedReference[],
  diagnostics: Diagnostic[]
) {
  const data = object.data as {
    posting?: { movements: MovementDecl[] }
    tabularSections?: Element[]
  }
  const movements = data.posting?.movements
  if (movements === undefined || object.id === undefined) return
  const ownerId = object.id
  const def = KIND_REGISTRY[object.kind]
  const sections = data.tabularSections ?? []
  const header = nameTable(
    ownerId,
    def.columnFields.flatMap(
      (field) => (data as Record<string, Element[]>)[field] ?? []
    ),
    def.standardColumns(data),
    style
  )
  const rowTables = new Map<string, NameTable>()
  const sectionNamed = (name: string) => sections.find((s) => s.name === name)
  const rowTable = (section: Element): NameTable | undefined => {
    if (typeof section.id !== "string") return undefined
    let table = rowTables.get(section.id)
    if (table === undefined) {
      table = nameTable(
        section.id,
        (section.attributes as Element[]) ?? [],
        def.tabularSectionColumns?.(data) ?? [],
        style
      )
      rowTables.set(section.id, table)
    }
    return table
  }
  const from = (pointer: string) => ({
    file: object.file,
    pointer,
    objectId: ownerId,
  })
  const toElement = (id: string) => ({ kind: "Element" as const, id })

  const resolveSection = (
    name: string,
    pointer: string
  ): Element | undefined => {
    const section = sectionNamed(name)
    if (section === undefined) {
      diagnostics.push(
        diagnostic("posting.tabular-section-unknown", object.file, pointer, {
          name,
        })
      )
    }
    return section
  }

  movements.forEach((movement, index) => {
    const base = `/posting/movements/${index}`
    const source =
      movement.source === "document"
        ? undefined
        : resolveSection(
            movement.source.tabularSection,
            `${base}/source/tabularSection`
          )
    if (source !== undefined && typeof source.id === "string") {
      references.push({
        from: from(`${base}/source/tabularSection`),
        to: toElement(source.id),
        role: "posting.tabularSection",
      })
    }

    const resolveField = (
      table: NameTable | undefined,
      scope: string,
      name: string,
      pointer: string,
      node: Expr,
      token: Span,
      role: "posting.docField" | "posting.rowField"
    ) => {
      // Без таблиці (документ-джерело з `row.`, ТЧ без id) звітувати нічого:
      // причину називає інша стадія.
      if (table === undefined) return
      const id = table.get(name)
      if (id === undefined) {
        diagnostics.push(
          diagnostic("posting.field-unknown", object.file, pointer, {
            name,
            scope,
            offset: node.start,
          })
        )
        return
      }
      references.push({
        from: from(pointer),
        to: toElement(id),
        role,
        span: { start: token.start, end: token.end },
      })
    }

    const resolveExpression = (text: string | undefined, path: string[]) => {
      if (text === undefined) return
      const parsed = parseExpression(text)
      if (!parsed.ok) return
      const pointer = toPointer([...base.split("/").slice(1), ...path])
      walkExpr(parsed.expr, (node) => {
        if (node.type === "field") {
          const inRow = node.base === "row"
          resolveField(
            inRow
              ? source === undefined
                ? undefined
                : rowTable(source)
              : header,
            inRow
              ? `tabular section ${String(source?.name)}`
              : `${object.kind} ${object.name}`,
            node.name,
            pointer,
            node,
            node.fieldSpan,
            inRow ? "posting.rowField" : "posting.docField"
          )
        } else if (node.type === "sum" || node.type === "count") {
          const section = sectionNamed(node.section)
          if (section === undefined) {
            diagnostics.push(
              diagnostic(
                "posting.tabular-section-unknown",
                object.file,
                pointer,
                {
                  name: node.section,
                  offset: node.start,
                }
              )
            )
            return
          }
          if (typeof section.id === "string") {
            references.push({
              from: from(pointer),
              to: toElement(section.id),
              role: "posting.tabularSection",
              span: {
                start: node.sectionSpan.start,
                end: node.sectionSpan.end,
              },
            })
          }
          if (node.type === "sum") {
            resolveField(
              rowTable(section),
              `tabular section ${node.section}`,
              node.field,
              pointer,
              node,
              node.fieldSpan,
              "posting.rowField"
            )
          }
        }
      })
    }

    resolveExpression(movement.condition, ["condition"])
    if (
      movement.movementType !== "Receipt" &&
      movement.movementType !== "Expense"
    ) {
      resolveExpression(movement.movementType, ["movementType"])
    }
    resolveExpression(movement.period, ["period"])

    // Ключі `fields` — імена полів регістра; їх перейменування каскад має
    // переписувати в ключі, а не у значенні.
    const register = objectsByName.get(
      objectKey(movement.register.kind, movement.register.name)
    )
    const registerFields =
      register === undefined
        ? undefined
        : nameTable(
            register.id ?? "",
            KIND_REGISTRY[register.kind].columnFields.flatMap(
              (field) =>
                (register.data as Record<string, Element[]>)[field] ?? []
            ),
            [],
            style
          )
    for (const [key, text] of Object.entries(movement.fields)) {
      const fieldPointer = `${base}/fields/${toPointer([key]).slice(1)}`
      if (registerFields !== undefined) {
        const id = registerFields.get(key)
        if (id === undefined) {
          diagnostics.push(
            diagnostic(
              "posting.register-field-unknown",
              object.file,
              fieldPointer,
              {
                name: key,
              }
            )
          )
        } else {
          references.push({
            from: from(fieldPointer),
            to: toElement(id),
            role: "posting.registerField",
          })
        }
      }
      resolveExpression(text, ["fields", key])
    }
  })
}
