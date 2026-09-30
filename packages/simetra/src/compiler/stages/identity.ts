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
import { parseExpression, type Expr, type MovementDecl } from "simetra/model"
import {
  compareStrings,
  diagnostic,
  toPointer,
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
  /** Вузол виразу всередині поля, на яке вказує pointer: пів-інтервал [start, end). */
  span?: { start: number; end: number }
  /** 1-базний рядок маркера в `.sql`: pointer на весь файл місця не вказує. */
  line?: number
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

/** Елемент усередині об'єкта, на який можна послатися у виразі за іменем. */
type NameTable = Map<string, string>

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
      `${ownerId}#${column.logicalName}`
    )
  }
  for (const element of elements) {
    if (typeof element.id === "string")
      table.set(String(element.name), element.id)
  }
  return table
}

/** Вузли виразу, що посилаються на імена, у порядку появи. */
function namedNodes(expr: Expr): Expr[] {
  switch (expr.type) {
    case "field":
    case "sum":
    case "count":
      return [expr]
    case "unary":
      return namedNodes(expr.operand)
    case "binary":
      return [...namedNodes(expr.left), ...namedNodes(expr.right)]
    default:
      return []
  }
}

/**
 * Імена у виразах конструктора рухів документа резолвляться в UUID, щоб
 * перейменування поля, ТЧ чи реєстру не ламало рухи мовчки. Цілісність
 * (типи, `row.` без ТЧ, вид регістра) — справа стадії 4; якщо ім'я чи ціль
 * не знайдені, звітується лише відсутність імені, а розбір виразу вже
 * перевірила T0 (`posting.parse`), тож зламаний вираз тут пропускається.
 */
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
      code: "reference.unresolved" | "posting.register-kind",
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
      if (KIND_REGISTRY[target.kind].registerKeys === undefined) {
        at("posting.register-kind", { kind: target.kind, name: target.name })
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
      target = candidates[0]
    }
    if (target?.id === undefined) continue
    references.push({
      from: { file: block.file, pointer: "", objectId: object.id },
      to: { kind: target.kind, id: target.id },
      role: "posting.movementsBlock",
      line: block.line,
    })
  }
}

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
        span: { start: node.start, end: node.end },
      })
    }

    const resolveExpression = (text: string | undefined, path: string[]) => {
      if (text === undefined) return
      const parsed = parseExpression(text)
      if (!parsed.ok) return
      const pointer = toPointer([...base.split("/").slice(1), ...path])
      for (const node of namedNodes(parsed.expr)) {
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
            continue
          }
          if (typeof section.id === "string") {
            references.push({
              from: from(pointer),
              to: toElement(section.id),
              role: "posting.tabularSection",
              span: { start: node.start, end: node.end },
            })
          }
          if (node.type === "sum") {
            resolveField(
              rowTable(section),
              `tabular section ${node.section}`,
              node.field,
              pointer,
              node,
              "posting.rowField"
            )
          }
        }
      }
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
