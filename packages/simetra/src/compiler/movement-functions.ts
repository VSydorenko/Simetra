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
import type { SqlParser } from "./sql/parse"
import {
  functionIdentity,
  inputArgumentTypes,
  withoutLocations,
  type MovementQueryUnit,
} from "./sql/units"
import { objectKey, type ParsedObject } from "./stages/files"
import type { ResolvedReference } from "./stages/identity"
import { registerSingletonOf } from "./stages/model"

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
  project: Project,
  parse: SqlParser
): MovementQueryUnit[] {
  const ctx = new Context(objects, references, physical, project, parse)
  const units: MovementQueryUnit[] = []
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
        ctx.unit(document, registerId, "constructor", (columns, name) =>
          ctx.translate(document, registerId, indexes, columns, name)
        )
      )
    }
  }
  return units.sort((a, b) => compareStrings(a.identity, b.identity))
}

/**
 * Ім'я обгортки запиту рухів — алгоритм імен Postgres від таблиць документа й
 * регістра; спільне для обгортки й перевірки колізій стадії 4.
 */
export function movementWrapperName(
  document: PhysicalTable,
  register: PhysicalTable
): string {
  return makeObjectName(document.name, register.name, "movements")
}

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
    private readonly project: Project,
    private readonly parse: SqlParser
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
    source: MovementQueryUnit["source"],
    body: (columns: readonly PhysicalColumn[], name: string) => string
  ): MovementQueryUnit {
    const documentTable = this.table(document.id ?? "")
    const register = must(this.byId.get(registerId), `register ${registerId}`)
    const registerTable = this.table(registerId)
    const columns = this.resultColumns(register, registerTable)
    const name = movementWrapperName(documentTable, registerTable)
    const signature = columns
      .map((c) => `${quoteIdent(c.name)} ${c.type}`)
      .join(", ")
    const text = body(columns, name)
    const tag = dollarTag(text)
    const sql =
      `CREATE OR REPLACE FUNCTION ${quoteIdent(documentTable.schema)}.${quoteIdent(name)}(p_document_id uuid)\n` +
      `RETURNS TABLE (${signature})\n` +
      `LANGUAGE sql STABLE\n` +
      `AS ${tag}\n${text}\n${tag};`
    // Тіло — рядок у долар-лапках, тож розбір обгортки не залежить від
    // запиту автора; збій тут — помилка генератора, а не метаданих.
    const parsed = this.parse(sql)
    const [statement] = parsed.ok ? parsed.statements : []
    if (statement === undefined || !("CreateFunctionStmt" in statement.stmt)) {
      throw new Error(`movement wrapper ${name} does not parse`)
    }
    // Для хешу — дерево самого запиту: у дереві обгортки він рядок
    // `prosrc`, і пробіли чи коментар у блоці змінили б хеш.
    const query = this.parse(text)
    if (!query.ok) throw new Error(`movement query ${name} does not parse`)
    return {
      class: "movementQuery",
      // Ідентичність — з розібраної обгортки, як у функцій користувача.
      identity: functionIdentity(
        documentTable.schema,
        name,
        inputArgumentTypes(statement.stmt.CreateFunctionStmt)
      ),
      schema: documentTable.schema,
      name,
      ownerObjectId: document.id ?? "",
      module: this.project.name,
      sql,
      tree: withoutLocations(statement.stmt),
      queryTree: query.statements.map((s) => withoutLocations(s.stmt)),
      documentId: document.id ?? "",
      registerId,
      source,
    }
  }

  /**
   * Колонки `RETURNS TABLE`: колонки рухів у порядку таблиці мінус ті, що
   * заповнює оболонка (реєстратор, номер рядка, активність, носій скоупу), і
   * ключ-одинак, значення якого дає DEFAULT (спека §7).
   */
  private resultColumns(
    register: ParsedObject,
    table: PhysicalTable
  ): PhysicalColumn[] {
    const singleton = registerSingletonOf(register)
    const shell = new Set(
      [
        ...(singleton === undefined ? [] : [singleton]),
        ...KIND_REGISTRY[register.kind].standardColumns(register.data),
      ]
        .filter((c) => c.filledByShell === true || c.singleton === true)
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
    columns: readonly PhysicalColumn[],
    name: string
  ): string {
    const register = must(this.byId.get(registerId), `register ${registerId}`)
    const movements = (
      document.data as { posting: { movements: MovementDecl[] } }
    ).posting.movements
    const selects = indexes.map((index) =>
      this.movementSelect(
        document,
        register,
        index,
        movements[index]!,
        columns,
        name
      )
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
    columns: readonly PhysicalColumn[],
    name: string
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
          node.fieldSpan.start
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
        node.sectionSpan.start
      )
      const table = this.table(documentId, section)
      const from = `FROM ${qualified(table)} t WHERE t.${key(table, rowDefs, "parent")} = ${documentKey}`
      if (node.type === "count") return [`(SELECT count(*) ${from})`]
      const field = this.lookup(
        document.file,
        pointer,
        "posting.rowField",
        node.fieldSpan.start
      )
      const [column] = this.elementColumns(table, rowDefs, field)
      return [`(SELECT COALESCE(sum(t.${ref(column!)}), 0) ${from})`]
    })
    const expression = (text: string, ...path: (string | number)[]) =>
      translator.translate(parseExpression(text), toPointer([...base, ...path]))
        .sql

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
      const pointer = toPointer([...base, "fields", fieldName])
      const fieldId = this.lookup(
        document.file,
        pointer,
        "posting.registerField"
      )
      const targets = this.elementColumns(registerTable, [], fieldId)
      const { expr, sql } = translator.translate(parseExpression(text), pointer)
      const assigned = assign(targets, expr, sql, () =>
        this.discriminator(document, expr, pointer)
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
    // Параметр кваліфіковано іменем функції: у тілі SQL-функції колонка з
    // тим самим іменем перемогла б параметр.
    const where = [
      `  WHERE ${documentKey} = ${quoteIdent(name)}.p_document_id`,
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
   * мітка виду цілі, як її пише стадія 3 у `<поле>_type`. Одноцільове
   * значення — лише голе поле (посилання без операцій), тож ціль — його `ref`.
   */
  private discriminator(
    document: ParsedObject,
    expr: Expr,
    pointer: string
  ): string {
    if (expr.type !== "field") {
      throw new Error(`internal: polymorphic value at ${pointer}`)
    }
    const id = this.lookup(
      document.file,
      pointer,
      expr.base === "row" ? "posting.rowField" : "posting.docField",
      expr.fieldSpan.start
    )
    const hash = id.indexOf("#")
    // Стандартні посилання з однією ціллю — ключ документа й власник рядка.
    if (hash >= 0) return literal(kindLabel(document))
    const attribute = findAttribute(document, id)
    const target = this.byKey.get(
      objectKey(attribute.ref!.kind, attribute.ref!.name)
    )
    return literal(kindLabel(must(target, `target of ${id}`)))
  }
}

/**
 * Значення колонок поля регістра з колонок виразу: однакова кількість —
 * попарно; одноцільове посилання в поліморфне поле — дискримінатор цілі й id;
 * поліморфне значення з однією ціллю в одноцільове поле — id пари; `null` —
 * типізовані NULL у кожну колонку, бо тип рядка першого `SELECT` визначає тип
 * колонки `UNION ALL`. Інша арність — дефект: стадія 4 її не пропускає.
 */
function assign(
  targets: readonly PhysicalColumn[],
  expr: Expr,
  sources: readonly string[],
  discriminator: () => string
): string[] {
  if (expr.type === "null") return targets.map((t) => `NULL::${t.type}`)
  if (targets.length === sources.length) return [...sources]
  if (targets.length === 2 && sources.length === 1) {
    return [discriminator(), sources[0]!]
  }
  if (targets.length === 1 && sources.length === 2) return [sources[1]!]
  throw new Error(
    `internal: ${sources.length} value columns for ${targets.length} field columns`
  )
}

/**
 * Переклад AST у SQL. Вкладені операції беруться в дужки, щоб пріоритет SQL
 * не розійшовся з пріоритетом граматики. Рівність — `IS [NOT] DISTINCT FROM`:
 * як у 1С, порожнє дорівнює порожньому, тож два порожні поля не відкидають
 * рух мовчки, а `x = null` не потребує окремого випадку. Поле може дати пару
 * колонок (поліморфне посилання): верхній рівень повертає обидві, щоб лягти в
 * пару поля регістра, а у виразі пару стадія 4 пускає лише в порівняння з
 * `null` — там достатньо `_id`.
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
  ): { expr: Expr; sql: string[] } {
    if (!parsed.ok) throw new Error(`internal: unparsed ${pointer}`)
    const { expr } = parsed
    const resolve = this.named(pointer)
    const sql =
      expr.type === "field" ? resolve(expr) : [this.node(expr, resolve, false)]
    return { expr, sql }
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
      case "field":
        return resolve(expr).at(-1)!
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
        // Ділення в Postgres над цілими — цілочисельне й губить дріб, який
        // стадія 4 типізує нецілим; `numeric` лівого операнда тягне й результат.
        if (expr.op === "/") {
          return wrap(
            `(${this.node(expr.left, resolve, false)})::numeric / ${this.node(expr.right, resolve, true)}`
          )
        }
        const op =
          expr.op === "="
            ? "IS NOT DISTINCT FROM"
            : expr.op === "!="
              ? "IS DISTINCT FROM"
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

/** Стадія 4 гарантує мітку в цілі поліморфної пари; відсутність — дефект. */
function kindLabel(object: ParsedObject): string {
  return must(
    (object.data as { kindLabel?: string }).kindLabel,
    `kindLabel of ${object.name}`
  )
}

function qualified(table: PhysicalTable): string {
  return `${quoteIdent(table.schema)}.${quoteIdent(table.name)}`
}

function ref(column: PhysicalColumn): string {
  return quoteIdent(column.name)
}

/**
 * Тег долар-лапок тіла обгортки, якого немає в самому тілі: інакше блок,
 * рядковий літерал конструктора, ідентифікатор чи часовий пояс закрили б тіло
 * раніше й стали б ін'єкцією. Один механізм для будь-якого джерела тіла, тож
 * жодне джерело не потребує власної заборони.
 */
function dollarTag(body: string): string {
  let tag = "$simetra$"
  for (let n = 1; body.includes(tag); n += 1) tag = `$simetra_${n}$`
  return tag
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
