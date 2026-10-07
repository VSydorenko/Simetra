import { stat } from "node:fs/promises"
import {
  compile,
  loadSqlParser,
  type CompiledModel,
  type Diagnostic,
} from "simetra/compiler"
import {
  ATTRIBUTE_CASES,
  DATABASE_PROVIDERS,
  logicalTypeOf,
  type AttributeCase,
  type DatabaseProvider,
  type CatalogColumn,
  type CatalogDifference,
  type CatalogUnit,
} from "simetra/model"
import {
  SUPABASE_SCHEMAS,
  compareWithDesired,
  engineScope,
  renderDesiredState,
  reverseGenerate,
  type EngineAction,
  type EngineDiagnostic,
  type EngineScope,
  type SchemaEngine,
} from "simetra/schema"
import { z } from "zod"
import { withDatabase } from "../io/database"
import { readMetadataDir } from "../io/metadata-dir"
import { schemaPathResolver } from "../io/schema-path"
import { UsageError } from "../io/usage-error"
import { defineTool, type DatabaseResource } from "./types"

const PROJECT_FILE = "project.meta.json"

/**
 * Двигун вантажиться лише викликом інструмента бази: `simetra compile` і
 * MCP-сервер без бази не тягнуть pg-delta.
 */
async function loadEngine(): Promise<SchemaEngine> {
  const { createPgDeltaEngine } = await import("../schema-engine")
  return createPgDeltaEngine()
}

/** Резолвер `invoke` гарантує ресурс для інструмента з віссю бази. */
function required(database: DatabaseResource | undefined): DatabaseResource {
  if (database === undefined)
    throw new Error("invoke passes the database to a database tool")
  return database
}

/**
 * Діагностика двигуна у формі компілятора: без файлу (стосується бази, не
 * теки), з параметрами, з яких звіт будує текст потрібною мовою. Ідентичність
 * об'єкта й код двигуна — у параметрах, щоб JSON-вивід їх ніс.
 */
function fromEngine(d: EngineDiagnostic): Diagnostic {
  return {
    code: d.code,
    severity: d.severity,
    file: "",
    pointer: "",
    message: d.message,
    params: {
      ...(d.object === undefined ? {} : { object: d.object }),
      ...(d.engineCode === undefined ? {} : { engineCode: d.engineCode }),
      ...d.params,
    },
  }
}

const hasErrors = (diagnostics: readonly { severity: string }[]) =>
  diagnostics.some((d) => d.severity === "error")

/** Тека, якої ще немає, — порожня тека: `introspect` створює проєкт. */
async function readFolder(dir: string): Promise<Map<string, string>> {
  const exists = await stat(dir).then(
    () => true,
    () => false
  )
  return exists ? readMetadataDir(dir) : new Map()
}

const schemaName = z.string().min(1).max(63)

export const introspectTool = defineTool({
  name: "introspect",
  description:
    "Read the live database into metadata: tables become CustomTable, enum types PgEnum, everything else verbatim .sql files; ids of known objects are kept. The connection comes from the server's environment. Scope: the schemas of the existing metadata plus `schemas`; a directory without project.meta.json needs `schemas`. Writes nothing when anything is unrepresentable or does not compile.",
  input: z.strictObject({
    schemas: z.array(schemaName).min(1).optional().meta({
      description:
        "Schemas to read; required when the directory has no project.meta.json. The first is the default schema of a new project.",
    }),
    project: z
      .strictObject({
        name: z.string().min(1).optional(),
        attributeCase: z.enum(ATTRIBUTE_CASES).optional(),
        database: z
          .strictObject({ provider: z.enum(DATABASE_PROVIDERS).optional() })
          .optional(),
      })
      .optional()
      .meta({
        description:
          "Name, attribute case and database provider (default supabase) of a new project; an existing project.meta.json is never rewritten, and a value that differs from it is an error.",
      }),
  }),
  files: "write",
  database: "read",
  destructive: false,
  async run({ dir, database }, input) {
    const existing = await readFolder(dir)
    const provider = new Set(SUPABASE_SCHEMAS)
    const foreign = (input.schemas ?? []).filter((s) => provider.has(s))
    if (foreign.length > 0)
      throw new UsageError(
        `Provider schemas are not introspected: ${foreign.join(", ")}. Nothing changed.`
      )

    let project: {
      name: string
      defaultSchema: string
      attributeCase: AttributeCase
      databaseProvider: DatabaseProvider
    }
    let scope: EngineScope
    if (existing.has(PROJECT_FILE)) {
      // Межа — та сама, що в `diff`: схеми наявної теки, плюс названі
      const compiled = await compile(existing)
      if (compiled.model === undefined)
        return { ok: false, changes: [], diagnostics: compiled.diagnostics }
      const own = compiled.model.project
      // Файл проєкту не переписується: без явного входу діють його значення,
      // а явно назване інше значення генератор звітує помилкою
      // `introspect.project-mismatch`, і нічого не пишеться
      project = {
        name: input.project?.name ?? own.name,
        defaultSchema: own.defaultSchema,
        attributeCase: input.project?.attributeCase ?? own.naming.attributeCase,
        // Провайдер — з файлу проєкту: з єдиним пресетом розбіжності бути не
        // може, а з'явиться другий — запит іншого значення стане помилкою.
        databaseProvider: own.database.provider,
      }
      const modelScope = (await engineScope(compiled.model)).scope
      scope = {
        ...modelScope,
        schemas: [
          ...new Set([...modelScope.schemas, ...(input.schemas ?? [])]),
        ].sort(),
      }
    } else {
      if (input.schemas === undefined)
        throw new UsageError(
          `${dir} has no ${PROJECT_FILE}, so there is no scope to read: pass schemas, e.g. {"schemas": ["public"]}. Nothing changed.`
        )
      project = {
        name: input.project?.name ?? "App",
        defaultSchema: input.schemas[0]!,
        attributeCase: input.project?.attributeCase ?? "camelCase",
        // Дефолт лише тут, на межі інструмента для теки без проєкту: файл, що
        // його запише генератор, несе провайдера явно.
        databaseProvider: input.project?.database?.provider ?? "supabase",
      }
      scope = {
        schemas: [...new Set(input.schemas)].sort(),
        provider: project.databaseProvider,
      }
    }

    const engine = await loadEngine()
    const read = await withDatabase(required(database), "introspect", (db) =>
      engine.extract(db.target, scope)
    )
    if (!read.ok)
      return { ok: false, changes: [], diagnostics: [read.diagnostic] }
    const extracted = read.value
    const extractDiagnostics = extracted.diagnostics.map(fromEngine)
    // Невиражене в extract (EXCLUDE, чужий власник) — уже втрата: генератор
    // не побачить того, чого немає в моделі, тож запис зупиняє і воно
    const reversed = await reverseGenerate(extracted.model, {
      project,
      existing,
      newId: () => crypto.randomUUID(),
      schemaPath: schemaPathResolver(dir),
      parse: await loadSqlParser(),
    })
    const diagnostics = [...extractDiagnostics, ...reversed.diagnostics]
    const ok = !hasErrors(diagnostics)
    return {
      ok,
      changes: ok ? reversed.changes : [],
      diagnostics,
      data: { schemas: [...scope.schemas] },
    }
  },
})

export interface DiffData {
  /** Дії плану «база → метадані» в порядку двигуна. */
  plan: EngineAction[]
  differences: CatalogDifference[]
  diagnostics: Diagnostic[]
  /** Немає ні дій, ні відмінностей, ні помилок. */
  empty: boolean
}

type Qualified = { schema: string; name: string }

/** Імена фільтра (`schema.table` чи `table`) у таблиці обох моделей. */
function resolveTables(
  filter: readonly string[],
  known: readonly Qualified[]
): { tables: Qualified[]; unknown: string[] } {
  const tables: Qualified[] = []
  const unknown: string[] = []
  for (const entry of filter) {
    const dot = entry.indexOf(".")
    const hits = known.filter((t) =>
      dot < 0
        ? t.name === entry
        : t.schema === entry.slice(0, dot) && t.name === entry.slice(dot + 1)
    )
    if (hits.length === 0) unknown.push(entry)
    tables.push(...hits)
  }
  return { tables, unknown }
}

/**
 * Чи стосується ідентичність двигуна однієї з таблиць: сама таблиця, її
 * колонки, обмеження, тригери, політики, типові значення, пов'язані з нею
 * індекси, енами й послідовності (`related`) і обгортки (`comment:(…)`,
 * `acl:(…)`) над будь-чим із цього. Індекс, енам і послідовність у Postgres
 * адресуються схемою, а не таблицею, тож зв'язок з таблицею дають моделі.
 */
function touchesTables(
  tables: readonly Qualified[],
  related: ReadonlySet<string>
): (id: string) => boolean {
  const own = new Set(tables.map((t) => `table:${t.schema}.${t.name}`))
  const prefixes = tables.map((t) => `${t.schema}.${t.name}.`)
  const sub = /^(column|constraint|trigger|rule|policy|default):(.*)$/
  const touches = (id: string): boolean => {
    if (own.has(id) || related.has(id)) return true
    const m = sub.exec(id)
    if (m !== null) return prefixes.some((p) => m[2]!.startsWith(p))
    const wrapped = /^(?:comment|acl|securityLabel):\((.*)\)/.exec(id)
    return wrapped !== null && touches(wrapped[1]!)
  }
  return touches
}

/**
 * Ціль дії — те, що вона створює чи знищує. Лише в дій без них (GRANT,
 * `ENABLE RLS`, `REPLICA IDENTITY`) ціль видно в `consumes`; інакше
 * `consumes` — залежності, і FK чужої таблиці потрапив би у фільтр таблиці,
 * на яку посилається.
 */
function targetsOf(a: EngineAction): string[] {
  const own = [...a.produces, ...a.destroys]
  return own.length > 0 ? own : a.consumes
}

/** Частини `a.b.c` з лапками Postgres; `undefined` — не ім'я. */
function nameParts(text: string): string[] | undefined {
  const parts: string[] = []
  const part = /\s*(?:"((?:[^"]|"")+)"|([A-Za-z_][\w$]*))\s*(\.|$)/y
  while (part.lastIndex < text.length) {
    const m = part.exec(text)
    if (m === null) return undefined
    parts.push(
      m[1] === undefined ? m[2]!.toLowerCase() : m[1].replace(/""/g, '"')
    )
    if (m[3] === "") break
  }
  return parts.length > 0 ? parts : undefined
}

/**
 * Енами й послідовності названих таблиць. Вони адресуються схемою, а не
 * таблицею, тож зв'язок дають колонки (тип, identity, `nextval` у типовому
 * значенні) і `OWNED BY` одиниць — з обох моделей: енам нової колонки є
 * лише в бажаній, видаленої — лише в цільовій.
 */
function dependentIds(
  keys: ReadonlySet<string>,
  models: readonly NarrowModel[]
): Set<string> {
  const enums = new Set(
    models.flatMap((m) => m.enumTypes.map((e) => `${e.schema}.${e.name}`))
  )
  const ids = new Set<string>()
  const sequence = (schema: string, parts: string[] | undefined) => {
    if (parts === undefined || parts.length > 2) return
    const qualified = parts.length === 2 ? parts : [schema, parts[0]!]
    const key = qualified.join(".")
    ids.add(`sequence:${key}`).add(`sequenceOwnedBy:${key}`)
  }
  for (const table of models.flatMap((m) => m.tables)) {
    if (!keys.has(`${table.schema}.${table.name}`)) continue
    for (const column of table.columns) {
      const type = logicalTypeOf(column.type.replace(/(\[\])+$/, ""), enums)
      if (type.form === "enum") ids.add(`type:${type.schema}.${type.name}`)
      if (column.identity !== undefined)
        sequence(table.schema, [column.identity.sequence])
      const next = /nextval\('((?:[^']|'')+)'::regclass\)/.exec(
        column.default ?? ""
      )
      if (next !== null)
        sequence(table.schema, nameParts(next[1]!.replace(/''/g, "'")))
    }
  }
  for (const unit of models.flatMap((m) => m.units)) {
    if (unit.class !== "sequenceOwnedBy") continue
    const owner = /OWNED\s+BY\s+(.+?)\s*;?\s*$/i.exec(unit.sql)
    const parts = owner === null ? undefined : nameParts(owner[1]!)
    // `schema.table.column` або `table.column` у схемі послідовності
    const table =
      parts === undefined
        ? undefined
        : parts.length === 3
          ? `${parts[0]}.${parts[1]}`
          : parts.length === 2
            ? `${unit.schema}.${parts[0]}`
            : undefined
    if (table !== undefined && keys.has(table))
      sequence(
        unit.schema,
        nameParts(unit.identity.slice(unit.identity.indexOf(":") + 1))
      )
  }
  return ids
}

/**
 * Чи належить ідентичність двигуна якійсь таблиці моделей, її індексу чи
 * енаму: лише тоді фільтр може судити, що вона поза названими таблицями.
 * Функція, в'юха, роль чи грант-одиниця таблиці не мають — їх не відкидаємо.
 */
function attributable(models: readonly NarrowModel[]): (id: string) => boolean {
  const indexes = new Set(
    models.flatMap((m) =>
      m.tables.flatMap((t) =>
        t.indexes.map((i) => `index:${t.schema}.${i.name}`)
      )
    )
  )
  const enums = new Set(
    models.flatMap((m) => m.enumTypes.map((e) => `type:${e.schema}.${e.name}`))
  )
  const tableKinds = /^(?:table|column|constraint|trigger|rule|policy|default):/
  const check = (id: string): boolean => {
    const wrapped = /^(?:comment|acl|securityLabel):\((.*)\)/.exec(id)
    if (wrapped !== null) return check(wrapped[1]!)
    return tableKinds.test(id) || indexes.has(id) || enums.has(id)
  }
  return check
}

/**
 * Звуження звірки до названих таблиць (§10.3 спеки П2: звірка документа з
 * його ТЧ і регістрами, а не всієї бази) разом з їхніми енамами й
 * послідовностями. Діагностика двигуна (без файлу) відкидається лише тоді,
 * коли її об'єкт належить іншій таблиці; без атрибуції вона лишається, бо
 * помилка, яку не віднести до таблиці, може стосуватися й названих.
 */
export function narrow(
  data: Omit<DiffData, "empty">,
  tables: readonly Qualified[],
  models: readonly NarrowModel[]
): Omit<DiffData, "empty"> {
  const keys = new Set(tables.map((t) => `${t.schema}.${t.name}`))
  const indexes = new Set(
    models.flatMap((m) =>
      m.tables
        .filter((t) => keys.has(`${t.schema}.${t.name}`))
        .flatMap((t) => t.indexes.map((i) => `index:${t.schema}.${i.name}`))
    )
  )
  const dependent = dependentIds(keys, models)
  const owned = attributable(models)
  const touches = touchesTables(tables, new Set([...indexes, ...dependent]))
  const tablePaths = [...keys].map((k) => `tables.${k}`)
  const enumPaths = new Set(
    [...dependent]
      .filter((id) => id.startsWith("type:"))
      .map((id) => `enumTypes.${id.slice("type:".length)}`)
  )
  return {
    plan: data.plan.filter((a) => targetsOf(a).some(touches)),
    differences: data.differences.filter(
      (d) =>
        tablePaths.some((p) => d.path === p || d.path.startsWith(`${p}.`)) ||
        enumPaths.has(d.path) ||
        (d.path.startsWith("units.") && touches(d.path.slice("units.".length)))
    ),
    diagnostics: data.diagnostics.filter((d) => {
      const object = d.params?.object
      return (
        d.file !== "" ||
        typeof object !== "string" ||
        !owned(object) ||
        touches(object)
      )
    }),
  }
}

type NarrowModel = {
  tables: {
    schema: string
    name: string
    columns: Pick<CatalogColumn, "type" | "default" | "identity">[]
    indexes: { name: string }[]
  }[]
  enumTypes: Qualified[]
  units: Pick<CatalogUnit, "class" | "identity" | "schema" | "sql">[]
}

export const diffTool = defineTool({
  name: "diff",
  description:
    "Compare the live database with the metadata through a throwaway shadow database: the plan from the database to the metadata, catalog differences and diagnostics. The connection comes from the server's environment; the target is only read. `tables` narrows the plan, differences and table-attributed diagnostics to the named tables.",
  input: z.strictObject({
    tables: z
      .array(z.string().min(1))
      .min(1)
      .optional()
      .meta({ description: "Tables to compare: `schema.table` or `table`." }),
  }),
  files: "read",
  database: "read",
  destructive: false,
  async run({ dir, database }, input) {
    const compiled = await compile(await readMetadataDir(dir))
    const model: CompiledModel | undefined = compiled.model
    if (model === undefined)
      return { ok: false, changes: [], diagnostics: compiled.diagnostics }
    const { scope, diagnostics: scopeDiagnostics } = await engineScope(model)
    const engine = await loadEngine()
    const compared = await withDatabase(required(database), "diff", (db) =>
      compareWithDesired(
        engine,
        {
          target: db.target,
          ...(db.shadowBase ? { shadowBase: db.shadowBase } : {}),
        },
        renderDesiredState(model).sql,
        scope,
        scopeDiagnostics
      )
    )
    if (!compared.ok)
      return {
        ok: false,
        changes: [],
        diagnostics: [...compiled.diagnostics, compared.diagnostic],
      }
    const comparison = compared.value
    const diagnostics = [
      ...compiled.diagnostics,
      ...comparison.diagnostics.map(fromEngine),
    ]
    if (comparison.status === "shadow-failed")
      return { ok: false, changes: [], diagnostics }

    let data: Omit<DiffData, "empty"> = {
      plan: comparison.plan.actions,
      differences: comparison.differences,
      diagnostics,
    }
    if (input.tables !== undefined) {
      const models = [comparison.target.model, comparison.desired.model]
      const { tables, unknown } = resolveTables(
        input.tables,
        models.flatMap((m) => m.tables)
      )
      if (unknown.length > 0)
        throw new UsageError(
          `Unknown tables in the filter: ${unknown.join(", ")}. They are neither in the database nor in the metadata. Nothing compared.`
        )
      data = narrow(data, tables, models)
    }
    // Код виходу й зведення судять за звуженими діагностиками
    const ok = !hasErrors(data.diagnostics)
    return {
      ok,
      changes: [],
      diagnostics: data.diagnostics,
      data: {
        ...data,
        empty: ok && data.plan.length === 0 && data.differences.length === 0,
      } satisfies DiffData,
    }
  },
})
