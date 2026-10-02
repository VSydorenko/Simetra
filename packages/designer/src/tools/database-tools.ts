import { stat } from "node:fs/promises"
import {
  compile,
  loadSqlParser,
  type CompiledModel,
  type Diagnostic,
} from "simetra/compiler"
import {
  ATTRIBUTE_CASES,
  type AttributeCase,
  type CatalogDifference,
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
      })
      .optional()
      .meta({
        description:
          "Name and attribute case of a new project; an existing project.meta.json is never rewritten.",
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
    }
    let scope: EngineScope
    if (existing.has(PROJECT_FILE)) {
      // Межа — та сама, що в `diff`: схеми наявної теки, плюс названі
      const compiled = await compile(existing)
      if (compiled.model === undefined)
        return { ok: false, changes: [], diagnostics: compiled.diagnostics }
      const own = compiled.model.project
      // Власні значення теки: генератор звітує розбіжність з ними помилкою,
      // тож перекрити їх може лише явний вхід
      project = {
        name: input.project?.name ?? own.name,
        defaultSchema: own.defaultSchema,
        attributeCase: input.project?.attributeCase ?? own.naming.attributeCase,
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
      }
      scope = {
        schemas: [...new Set(input.schemas)].sort(),
        provider: "supabase",
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
 * колонки, обмеження, тригери, політики, типові значення, її індекси й
 * обгортки (`comment:(…)`, `acl:(…)`) над будь-чим із цього. Індекс у
 * Postgres адресується схемою, а не таблицею, тож його таблицю дають моделі.
 */
function touchesTables(
  tables: readonly Qualified[],
  indexes: ReadonlySet<string>
): (id: string) => boolean {
  const own = new Set(tables.map((t) => `table:${t.schema}.${t.name}`))
  const prefixes = tables.map((t) => `${t.schema}.${t.name}.`)
  const sub = /^(column|constraint|trigger|rule|policy|default):(.*)$/
  const touches = (id: string): boolean => {
    if (own.has(id) || indexes.has(id)) return true
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

/**
 * Звуження звірки до названих таблиць (§10.3 спеки П2: звірка документа з
 * його ТЧ і регістрами, а не всієї бази). Діагностики не звужуються:
 * помилка поза фільтром однаково робить звірку неповною.
 */
export function narrow(
  data: Omit<DiffData, "empty">,
  tables: readonly Qualified[],
  models: readonly CompiledTables[]
): Omit<DiffData, "empty"> {
  const keys = new Set(tables.map((t) => `${t.schema}.${t.name}`))
  const indexes = new Set(
    models.flatMap((m) =>
      m
        .filter((t) => keys.has(`${t.schema}.${t.name}`))
        .flatMap((t) => t.indexes.map((i) => `index:${t.schema}.${i.name}`))
    )
  )
  const touches = touchesTables(tables, indexes)
  const tablePaths = [...keys].map((k) => `tables.${k}`)
  return {
    plan: data.plan.filter((a) => targetsOf(a).some(touches)),
    differences: data.differences.filter(
      (d) =>
        tablePaths.some((p) => d.path === p || d.path.startsWith(`${p}.`)) ||
        (d.path.startsWith("units.") && touches(d.path.slice("units.".length)))
    ),
    diagnostics: data.diagnostics,
  }
}

type CompiledTables = {
  schema: string
  name: string
  indexes: { name: string }[]
}[]

export const diffTool = defineTool({
  name: "diff",
  description:
    "Compare the live database with the metadata through a throwaway shadow database: the plan from the database to the metadata, catalog differences and diagnostics. The connection comes from the server's environment; the target is only read. `tables` narrows the plan and differences to the named tables.",
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
      const models = [
        comparison.target.model.tables,
        comparison.desired.model.tables,
      ]
      const { tables, unknown } = resolveTables(input.tables, models.flat())
      if (unknown.length > 0)
        throw new UsageError(
          `Unknown tables in the filter: ${unknown.join(", ")}. They are neither in the database nor in the metadata. Nothing compared.`
        )
      data = narrow(data, tables, models)
    }
    const ok = !hasErrors(diagnostics)
    return {
      ok,
      changes: [],
      diagnostics,
      data: {
        ...data,
        empty: ok && data.plan.length === 0 && data.differences.length === 0,
      } satisfies DiffData,
    }
  },
})
