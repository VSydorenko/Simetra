import {
  compile,
  explainFunction,
  explainObject,
  fixFiles,
  type CompiledModel,
  type Explanation,
  type FunctionExplanation,
} from "simetra/compiler"
import { metadataKindSchema, objectNameSchema } from "simetra/model"
import { z } from "zod"
import { readMetadataDir } from "../io/metadata-dir"
import { schemaPathResolver } from "../io/schema-path"
import { defineTool, type RunOutcome } from "./types"

export const compileTool = defineTool({
  name: "compile",
  description:
    "Compile the metadata directory and return diagnostics. Reads the disk on every call; writes nothing.",
  input: z.strictObject({}),
  files: "read",
  database: "none",
  data: "none",
  destructive: false,
  async run({ dir, baseline }) {
    const result = await compile(
      await readMetadataDir(dir),
      baseline === undefined ? undefined : { baseline }
    )
    return {
      ok: result.ok,
      changes: [],
      diagnostics: result.diagnostics,
      data: { model: result.model } as { model?: CompiledModel },
    }
  },
})

// Один об'єкт, а не union: MCP SDK для не-об'єктної схеми оголошує порожній
// вхід. Рівно одна з двох гілок — `refine`.
const explainInput = z
  .strictObject({
    kind: metadataKindSchema.optional(),
    name: objectNameSchema.optional(),
    function: z
      .strictObject({
        schema: z.string().min(1).optional(),
        name: z.string().min(1),
      })
      .optional(),
  })
  .refine(
    (i) =>
      i.function === undefined
        ? i.kind !== undefined && i.name !== undefined
        : i.kind === undefined && i.name === undefined,
    { message: "Give either kind and name, or function." }
  )

export const explainTool = defineTool({
  name: "explain",
  description:
    "Explain an object (kind, name; metadata must compile) or a SQL function (function: schema, name): callers, EXECUTE roles per provider, declared check, whether the body applies it.",
  input: explainInput,
  files: "read",
  database: "none",
  data: "none",
  destructive: false,
  async run(
    { dir },
    { kind, name, function: fn }
  ): Promise<RunOutcome<Explanation | FunctionExplanation>> {
    const files = await readMetadataDir(dir)
    if (fn !== undefined) {
      // Режим ремонту: функція без запобіжника — саме те, що пояснюємо.
      const result = await compile(files, { repair: true })
      if (result.model === undefined) {
        return { ok: false, changes: [], diagnostics: result.diagnostics }
      }
      const schema = fn.schema ?? result.model.project.defaultSchema
      const explanation: FunctionExplanation | undefined = explainFunction(
        result,
        { schema, name: fn.name }
      )
      if (explanation === undefined) {
        return {
          ok: false,
          changes: [],
          diagnostics: result.diagnostics,
          refusal: `Function not found: ${schema}.${fn.name}`,
        }
      }
      return {
        ok: true,
        changes: [],
        diagnostics: result.diagnostics,
        data: explanation,
      }
    }
    const result = await compile(files)
    if (result.model === undefined) {
      // Пояснення потребує чистої компіляції.
      return { ok: false, changes: [], diagnostics: result.diagnostics }
    }
    const explanation: Explanation | undefined = explainObject(result.model, {
      kind: kind!,
      name: name!,
    })
    if (explanation === undefined) {
      return {
        ok: false,
        changes: [],
        diagnostics: result.diagnostics,
        refusal: `Object not found: ${kind} ${name}`,
      }
    }
    return {
      ok: true,
      changes: [],
      diagnostics: result.diagnostics,
      data: explanation,
    }
  },
})

export const fixTool = defineTool({
  name: "fix",
  description:
    "Assign missing ids and physical names, set $schema and canonical form; repair function declarations (ids, call guard, default privileges). Writes when the result compiles, or when it removes repair-class errors and adds none (ok false, written true).",
  input: z.strictObject({}),
  files: "write",
  database: "none",
  data: "none",
  destructive: false,
  async run({ dir }) {
    const result = await fixFiles(await readMetadataDir(dir), {
      schemaPath: schemaPathResolver(dir),
      newId: () => crypto.randomUUID(),
    })
    return {
      ok: result.ok,
      ...(result.written === true ? { written: true as const } : {}),
      changes: result.changes,
      diagnostics: result.diagnostics,
    }
  },
})
