import {
  compile,
  explainObject,
  fixFiles,
  type CompiledModel,
  type Explanation,
} from "simetra/compiler"
import { metadataKindSchema, objectNameSchema } from "simetra/model"
import { z } from "zod"
import { readMetadataDir } from "../io/metadata-dir"
import { schemaPathResolver } from "../io/schema-path"
import { defineTool } from "./types"

export const compileTool = defineTool({
  name: "compile",
  description:
    "Compile the metadata directory and return diagnostics. Reads the disk on every call; writes nothing.",
  input: z.strictObject({}),
  files: "read",
  database: "none",
  destructive: false,
  async run({ dir }) {
    const result = await compile(await readMetadataDir(dir))
    return {
      ok: result.ok,
      changes: [],
      diagnostics: result.diagnostics,
      data: { model: result.model } as { model?: CompiledModel },
    }
  },
})

export const explainTool = defineTool({
  name: "explain",
  description:
    "Explain one object: its tables, columns, keys and movement queries. Needs a metadata directory that compiles without errors.",
  input: z.strictObject({ kind: metadataKindSchema, name: objectNameSchema }),
  files: "read",
  database: "none",
  destructive: false,
  async run({ dir }, { kind, name }) {
    const result = await compile(await readMetadataDir(dir))
    if (result.model === undefined) {
      // Пояснення потребує чистої компіляції (рішення плану 2).
      return { ok: false, changes: [], diagnostics: result.diagnostics }
    }
    const explanation: Explanation | undefined = explainObject(result.model, {
      kind,
      name,
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
    "Assign missing ids and physical names, set $schema and canonical form. Writes only when the result compiles without errors.",
  input: z.strictObject({}),
  files: "write",
  database: "none",
  destructive: false,
  async run({ dir }) {
    const result = await fixFiles(await readMetadataDir(dir), {
      schemaPath: schemaPathResolver(dir),
      newId: () => crypto.randomUUID(),
    })
    return {
      ok: result.ok,
      changes: result.changes,
      diagnostics: result.diagnostics,
    }
  },
})
