import {
  KIND_REGISTRY,
  makeObjectName,
  parseExpression,
  quoteIdent,
  standardLogicalName,
  type Attribute,
  type AttributeCase,
  type Expr,
  type MovementDecl,
  type PhysicalColumn,
  type PhysicalSnapshot,
  type PhysicalTable,
  type Project,
  type ReferenceRole,
  type StandardColumnDef,
} from "simetra/model"
import { compareStrings, toPointer } from "./diagnostics"
import { objectKey, type ParsedObject } from "./stages/files"
import type { ResolvedReference } from "./stages/identity"

/**
 * SQL-одиниця скомпільованої моделі. У C2 — лише обгортки запитів рухів;
 * дослівні `.sql`-одиниці й топологічний порядок додають наступні плани.
 */
export interface SqlUnit {
  kind: "movementQuery"
  schema: string
  name: string
  documentId: string
  registerId: string
  source: "query" | "constructor"
  sql: string
}

/** Колонки, які заповнює оболонка проведення, а не запит рухів (спека §7). */
const SHELL_FILLED = new Set(["lineNumber", "active"])

/**
 * Обгортки запитів рухів (спека П2 §7): блок запиту — як є, рухи
 * конструктора — перекладені в такий самий запит. Викликається лише на моделі
 * без помилок, тож кожне ім'я вже резолвлене; фізичні імена беруться зі
 * знімка й індексу посилань, а не з логічних імен.
 */
export function buildMovementFunctions(
  objects: readonly ParsedObject[],
  references: readonly ResolvedReference[],
  physical: PhysicalSnapshot,
  project: Project
): SqlUnit[] {
  const ctx = new Context(objects, references, physical, project)
  const units: SqlUnit[] = []
  for (const document of objects) {
    for (const block of document.movementBlocks ?? []) {
      const registerId = ctx.blockTarget(block.file, block.line)
      units.push(ctx.unit(document, registerId, "query", () => block.sql))
    }
    const movements =
      (document.data as { posting?: { movements: MovementDecl[] } }).posting
        ?.movements ?? []
    const byRegister = new Map<string, number[]>()
    movements.forEach((_, index) => {
      const registerId = ctx.lookup(
        document.file,
        toPointer(["posting", "movements", index, "register"]),
        "posting.register"
      )
      const list = byRegister.get(registerId) ?? []
      list.push(index)
      byRegister.set(registerId, list)
    })
    for (const [registerId, indexes] of byRegister) {
      units.push(
        ctx.unit(document, registerId, "constructor", (columns) =>
          ctx.translate(document, registerId, indexes, columns)
        )
      )
    }
  }
  return units.sort(
    (a, b) =>
      compareStrings(a.schema, b.schema) || compareStrings(a.name, b.name)
  )
}

type Element = Record<string, unknown>

class Context {
  private readonly byId: Map<string, ParsedObject>
  private readonly byKey: Map<string, ParsedObject>
  /** (file, pointer, role[, start]) → id цілі, як його записала стадія 2. */
  private readonly resolved = new Map<string, string>()
  private readonly style: AttributeCase

  constructor(
    objects: readonly ParsedObject[],
    references: readonly ResolvedReference[],
    private readonly physical: PhysicalSnapshot,
    private readonly project: Project
  ) {
    this.byId = new Map(objects.map((o) => [o.id ?? "", o]))
    this.byKey = new Map(objects.map((o) => [objectKey(o.kind, o.name), o]))
    this.style = project.naming.attributeCase
    for (const { from, role, to, span, line } of references) {
      const at = span?.start ?? line
      this.resolved.set(lookupKey(from.file, from.pointer, role, at), to.id)
    }
  }

  lookup(
    file: string,
    pointer: string,
    role: ReferenceRole,
    at?: number
  ): string {
    return must(
      this.resolved.get(lookupKey(file, pointer, role, at)),
      `${role} at ${file}${pointer}`
    )
  }

  blockTarget(file: string, line: number): string {
    return this.lookup(file, "", "posting.movementsBlock", line)
  }

  /** Обгортка-функція: ім'я, сигнатура й тіло, яке дає `body` за колонками. */
  unit(
    document: ParsedObject,
    registerId: string,
    source: SqlUnit["source"],
    body: (columns: readonly PhysicalColumn[]) => string
  ): SqlUnit {
    const documentTable = this.table(document.id ?? "")
    const register = must(this.byId.get(registerId), `register ${registerId}`)
    const registerTable = this.table(registerId)
    const columns = this.resultColumns(register, registerTable)
    const name = makeObjectName(
      documentTable.name,
      registerTable.name,
      "movements"
    )
    const signature = columns
      .map((c) => `${quoteIdent(c.name)} ${c.type}`)
      .join(", ")
    const sql =
      `CREATE OR REPLACE FUNCTION ${quoteIdent(documentTable.schema)}.${quoteIdent(name)}(p_document_id uuid)\n` +
      `RETURNS TABLE (${signature})\n` +
      `LANGUAGE sql STABLE\n` +
      `AS $simetra$\n${body(columns)}\n$simetra$;`
    return {
      kind: "movementQuery",
      schema: documentTable.schema,
      name,
      documentId: document.id ?? "",
      registerId,
      source,
      sql,
    }
  }

  /**
   * Колонки `RETURNS TABLE`: колонки рухів у порядку таблиці мінус ті, що
   * заповнює оболонка, — реєстратор, номер рядка, активність і носій скоупу.
   */
  private resultColumns(
    register: ParsedObject,
    table: PhysicalTable
  ): PhysicalColumn[] {
    const shell = new Set(
      KIND_REGISTRY[register.kind]
        .standardColumns(register.data)
        .filter((c) => c.ref === "recorders" || SHELL_FILLED.has(c.logicalName))
        .map((c) => standardLogicalName(c, this.style))
    )
    return table.columns.filter(
      (c) =>
        c.origin.scopeKindId === undefined &&
        (c.origin.standard === undefined || !shell.has(c.origin.standard))
    )
  }

  /** Основна таблиця об'єкта або таблиця його ТЧ. */
  private table(objectId: string, tabularSectionId?: string): PhysicalTable {
    return must(
      this.physical.tables.find(
        (t) =>
          t.origin.objectId === objectId &&
          t.origin.tabularSectionId === tabularSectionId &&
          t.origin.part === undefined
      ),
      `table of ${objectId}${tabularSectionId === undefined ? "" : `/${tabularSectionId}`}`
    )
  }

  /** Колонки стандартного реквізиту таблиці за канонічним ім'ям. */
  private standardColumns(
    table: PhysicalTable,
    defs: readonly StandardColumnDef[],
    logicalName: string
  ): PhysicalColumn[] {
    const def = must(
      defs.find((d) => d.logicalName === logicalName),
      `standard ${logicalName}`
    )
    const styled = standardLogicalName(def, this.style)
    return table.columns.filter((c) => c.origin.standard === styled)
  }

  /**
   * Колонки елемента за id з індексу посилань: реквізит — за UUID, стандартний
   * реквізит — за синтетичним `<власник>#<канонічне ім'я>`. Поліморфне
   * посилання дає пару колонок.
   */
  private elementColumns(
    table: PhysicalTable,
    defs: readonly StandardColumnDef[],
    elementId: string
  ): PhysicalColumn[] {
    const hash = elementId.indexOf("#")
    const columns =
      hash < 0
        ? table.columns.filter((c) => c.origin.elementId === elementId)
        : this.standardColumns(table, defs, elementId.slice(hash + 1))
    if (columns.length === 0) throw new Error(`internal: column ${elementId}`)
    return columns
  }

  /**
   * Рухи конструктора одного регістра — `SELECT` на рух через `UNION ALL`.
   * Порядок рядків після `UNION ALL` SQL не гарантує, а оболонка нумерує
   * рухи за ним, тож кожен `SELECT` несе індекс руху й номер рядка, а
   * зовнішній запит за ними сортує.
   */
  translate(
    document: ParsedObject,
    registerId: string,
    indexes: readonly number[],
    columns: readonly PhysicalColumn[]
  ): string {
    const register = must(this.byId.get(registerId), `register ${registerId}`)
    const movements = (
      document.data as { posting: { movements: MovementDecl[] } }
    ).posting.movements
    const selects = indexes.map((index) =>
      this.movementSelect(document, register, index, movements[index]!, columns)
    )
    const outer = columns.map((c) => `m.${quoteIdent(c.name)}`).join(", ")
    return (
      `SELECT ${outer}\nFROM (\n` +
      selects.join("\n  UNION ALL\n") +
      `\n) m\nORDER BY m.__movement, m.__line`
    )
  }

  private movementSelect(
    document: ParsedObject,
    register: ParsedObject,
    index: number,
    movement: MovementDecl,
    columns: readonly PhysicalColumn[]
  ): string {
    const documentId = document.id ?? ""
    const def = KIND_REGISTRY[document.kind]
    const headerDefs = def.standardColumns(document.data)
    const rowDefs = def.tabularSectionColumns?.(document.data) ?? []
    const documentTable = this.table(documentId)
    const base = ["posting", "movements", index]
    const sectionId =
      movement.source === "document"
        ? undefined
        : this.lookup(
            document.file,
            toPointer([...base, "source", "tabularSection"]),
            "posting.tabularSection"
          )
    const rowTable =
      sectionId === undefined ? undefined : this.table(documentId, sectionId)
    const key = (
      table: PhysicalTable,
      defs: readonly StandardColumnDef[],
      name: string
    ) => ref(this.standardColumns(table, defs, name)[0]!)
    const documentKey = `d.${key(documentTable, headerDefs, "ref")}`

    const translator = new ExpressionTranslator((pointer) => (node) => {
      if (node.type === "field") {
        const inRow = node.base === "row"
        const id = this.lookup(
          document.file,
          pointer,
          inRow ? "posting.rowField" : "posting.docField",
          node.start
        )
        const table = inRow ? rowTable! : documentTable
        const alias = inRow ? "r" : "d"
        return this.elementColumns(table, inRow ? rowDefs : headerDefs, id).map(
          (c) => `${alias}.${ref(c)}`
        )
      }
      // Агрегат по ТЧ документа: корельований підзапит за власником рядка.
      const section = this.lookup(
        document.file,
        pointer,
        "posting.tabularSection",
        node.start
      )
      const table = this.table(documentId, section)
      const from = `FROM ${qualified(table)} t WHERE t.${key(table, rowDefs, "parent")} = ${documentKey}`
      if (node.type === "count") return [`(SELECT count(*) ${from})`]
      const field = this.lookup(
        document.file,
        pointer,
        "posting.rowField",
        node.start
      )
      const [column] = this.elementColumns(table, rowDefs, field)
      return [`(SELECT COALESCE(sum(t.${ref(column!)}), 0) ${from})`]
    })
    const expression = (text: string, ...path: (string | number)[]) =>
      translator.translate(parseExpression(text), toPointer([...base, ...path]))

    // Значення кожної колонки результату: ключ — ім'я колонки.
    const values = new Map<string, string>()
    const registerDefs = KIND_REGISTRY[register.kind].standardColumns(
      register.data
    )
    const registerTable = this.table(register.id ?? "")
    const standardColumn = (name: string) =>
      registerDefs.some((d) => d.logicalName === name)
        ? this.standardColumns(registerTable, registerDefs, name)[0]
        : undefined

    const period = standardColumn("period")
    if (period !== undefined) {
      const moment =
        movement.period !== undefined
          ? expression(movement.period, "period").join(", ")
          : `d.${key(documentTable, headerDefs, "date")}`
      const unit = truncation(register)
      values.set(
        period.name,
        unit === undefined
          ? moment
          : `date_trunc('${unit}', ${moment}, ${literal(this.project.timezone)})`
      )
    }
    const movementType = standardColumn("movementType")
    if (movementType !== undefined && movement.movementType !== undefined) {
      values.set(
        movementType.name,
        movement.movementType === "Receipt" ||
          movement.movementType === "Expense"
          ? literal(movement.movementType)
          : expression(movement.movementType, "movementType").join(", ")
      )
    }
    for (const [fieldName, text] of Object.entries(movement.fields)) {
      const fieldId = this.lookup(
        document.file,
        toPointer([...base, "fields", fieldName]),
        "posting.registerField"
      )
      const targets = this.elementColumns(registerTable, [], fieldId)
      const parsed = parseExpression(text)
      const sources = expression(text, "fields", fieldName)
      const assigned = assign(
        targets,
        sources,
        parsed.ok && parsed.expr.type === "null",
        () => this.discriminator(document, parsed, fieldName, index)
      )
      targets.forEach((target, i) => values.set(target.name, assigned[i]!))
    }

    const list = [
      ...columns.map(
        (c) =>
          `${values.get(c.name) ?? `NULL::${c.type}`} AS ${quoteIdent(c.name)}`
      ),
      `${index} AS __movement`,
      rowTable === undefined
        ? "0 AS __line"
        : `r.${key(rowTable, rowDefs, "lineNumber")} AS __line`,
    ]
    const from =
      rowTable === undefined
        ? `  FROM ${qualified(documentTable)} d`
        : `  FROM ${qualified(rowTable)} r\n` +
          `  JOIN ${qualified(documentTable)} d ON ${documentKey} = r.${key(rowTable, rowDefs, "parent")}`
    const where = [
      `  WHERE ${documentKey} = p_document_id`,
      ...(movement.condition === undefined
        ? []
        : [
            `    AND (${expression(movement.condition, "condition").join(", ")})`,
          ]),
    ]
    return [`  SELECT ${list.join(", ")}`, from, ...where].join("\n")
  }

  /**
   * Дискримінатор пари для одноцільового посилання в поліморфному полі:
   * фізичне ім'я цілі, як його пише стадія 3 у `<поле>_type`. Одноцільове
   * значення — лише голе поле (посилання без операцій), тож ціль — його `ref`.
   */
  private discriminator(
    document: ParsedObject,
    parsed: ReturnType<typeof parseExpression>,
    fieldName: string,
    index: number
  ): string {
    const expr = parsed.ok ? parsed.expr : undefined
    if (expr?.type !== "field") {
      throw new Error(`internal: polymorphic value of ${fieldName}`)
    }
    const pointer = toPointer([
      "posting",
      "movements",
      index,
      "fields",
      fieldName,
    ])
    const id = this.lookup(
      document.file,
      pointer,
      expr.base === "row" ? "posting.rowField" : "posting.docField",
      expr.start
    )
    const hash = id.indexOf("#")
    // Стандартні посилання з однією ціллю — ключ документа й власник рядка.
    if (hash >= 0) return literal(physicalName(document))
    const attribute = findAttribute(document, id)
    const target = this.byKey.get(
      objectKey(attribute.ref!.kind, attribute.ref!.name)
    )
    return literal(physicalName(must(target, `target of ${id}`)))
  }
}

/**
 * Значення колонок поля регістра з колонок виразу: однакова кількість —
 * попарно; одноцільове посилання в поліморфне поле — дискримінатор цілі й id;
 * поліморфне значення в одноцільове — лише id пари; `null` — типізовані NULL,
 * бо тип рядка першого `SELECT` визначає тип колонки `UNION ALL`.
 */
function assign(
  targets: readonly PhysicalColumn[],
  sources: readonly string[],
  isNull: boolean,
  discriminator: () => string
): string[] {
  if (isNull) return targets.map((t) => `NULL::${t.type}`)
  if (targets.length === sources.length) return [...sources]
  if (targets.length === 2 && sources.length === 1) {
    return [discriminator(), sources[0]!]
  }
  return [sources[sources.length - 1]!]
}

/**
 * Переклад AST у SQL. Вкладені операції беруться в дужки, щоб пріоритет SQL
 * не розійшовся з пріоритетом граматики. Поле може дати пару колонок
 * (поліморфне посилання): у виразі це рядковий конструктор `(a, b)`, а
 * верхній рівень повертає колонки окремо, щоб лягти в пару поля регістра.
 */
class ExpressionTranslator {
  constructor(
    private readonly named: (
      pointer: string
    ) => (node: Extract<Expr, { type: "field" | "sum" | "count" }>) => string[]
  ) {}

  translate(
    parsed: ReturnType<typeof parseExpression>,
    pointer: string
  ): string[] {
    if (!parsed.ok) throw new Error(`internal: unparsed ${pointer}`)
    const resolve = this.named(pointer)
    if (parsed.expr.type === "field") return resolve(parsed.expr)
    return [this.node(parsed.expr, resolve, false)]
  }

  private node(
    expr: Expr,
    resolve: (
      node: Extract<Expr, { type: "field" | "sum" | "count" }>
    ) => string[],
    nested: boolean
  ): string {
    const wrap = (sql: string) => (nested ? `(${sql})` : sql)
    switch (expr.type) {
      case "field": {
        const columns = resolve(expr)
        return columns.length === 1 ? columns[0]! : `(${columns.join(", ")})`
      }
      case "sum":
      case "count":
        return resolve(expr)[0]!
      case "number":
        return expr.value
      case "string":
        return literal(expr.value)
      case "boolean":
        return expr.value ? "true" : "false"
      case "null":
        return "NULL"
      case "unary":
        return wrap(
          expr.op === "not"
            ? `NOT ${this.node(expr.operand, resolve, true)}`
            : `-${this.node(expr.operand, resolve, true)}`
        )
      case "binary": {
        const op =
          expr.op === "!="
            ? "<>"
            : expr.op === "and" || expr.op === "or"
              ? expr.op.toUpperCase()
              : expr.op
        return wrap(
          `${this.node(expr.left, resolve, true)} ${op} ${this.node(expr.right, resolve, true)}`
        )
      }
    }
  }
}

/**
 * Одиниця обрізання періоду: періодичний регістр відомостей зберігає момент,
 * обрізаний до своєї періодичності (спека §7), решта — момент як є.
 */
function truncation(register: ParsedObject): string | undefined {
  const { periodicity } = register.data as { periodicity?: string }
  return periodicity === undefined || periodicity === "NonPeriodic"
    ? undefined
    : periodicity.toLowerCase()
}

function findAttribute(document: ParsedObject, id: string): Attribute {
  const data = document.data as {
    attributes?: Attribute[]
    tabularSections?: { attributes: Attribute[] }[]
  }
  const all = [
    ...(data.attributes ?? []),
    ...(data.tabularSections ?? []).flatMap((s) => s.attributes),
  ]
  return must(
    all.find((a) => a.id === id),
    `attribute ${id}`
  )
}

function physicalName(object: ParsedObject): string {
  return (object.data as Element & { physicalName: string }).physicalName
}

function qualified(table: PhysicalTable): string {
  return `${quoteIdent(table.schema)}.${quoteIdent(table.name)}`
}

function ref(column: PhysicalColumn): string {
  return quoteIdent(column.name)
}

/** SQL-рядок: одинарні лапки подвоюються. */
function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function lookupKey(
  file: string,
  pointer: string,
  role: string,
  at: number | undefined
): string {
  return `${file}\0${pointer}\0${role}\0${at ?? ""}`
}

/** Модель без помилок гарантує наявність; відсутність — дефект компілятора. */
function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`internal: missing ${what}`)
  return value
}
