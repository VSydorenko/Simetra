import type { CallToolResult, McpServer } from "@modelcontextprotocol/server"
import {
  addElement,
  addElementInput,
  compile,
  createObject,
  createObjectInput,
  deleteElement,
  deleteInput,
  explainObject,
  renameElement,
  renameInput,
  type Diagnostic,
  type OperationResult,
} from "simetra/compiler"
import { metadataKindSchema, objectNameSchema } from "simetra/model"
import { z } from "zod"
import { readMetadataDir, writeChanges } from "../io/metadata-dir"
import { formatDiagnostics } from "../io/report"
import { schemaPathResolver } from "../io/schema-path"

export interface McpToolOptions {
  dir: string
  allowWrite: boolean
}

interface ToolOutput {
  ok: boolean
  changes: { path: string; deleted: boolean }[]
  diagnostics: Diagnostic[]
}

/** Один вигляд відповіді для всіх інструментів: структура плюс текст. */
function respond(
  o: McpToolOptions,
  out: ToolOutput,
  lines: string[],
  isError: boolean
): CallToolResult {
  const report = formatDiagnostics(out.diagnostics, {
    dir: o.dir,
    locale: "en",
    format: "text",
  })
  return {
    isError,
    structuredContent: { ...out },
    content: [{ type: "text", text: [...lines, report].join("\n") }],
  }
}

function failure(message: string): CallToolResult {
  return {
    isError: true,
    structuredContent: { ok: false, changes: [], diagnostics: [] },
    content: [{ type: "text", text: message }],
  }
}

/**
 * Мутація: тека читається заново на кожен виклик (стан — диск, не пам'ять
 * сервера), у T1 іде лише валідований вхід операції, а запис — лише при `ok`
 * і без `dryRun` (відмова й dry-run не пишуть нічого).
 */
async function mutate(
  o: McpToolOptions,
  dryRun: boolean | undefined,
  run: (files: Map<string, string>) => Promise<OperationResult>
): Promise<CallToolResult> {
  try {
    const result = await run(await readMetadataDir(o.dir))
    const write = result.ok && dryRun !== true
    if (write) await writeChanges(o.dir, result.changes)
    const changes = result.changes.map((c) => ({
      path: c.path,
      deleted: c.content === null,
    }))
    const verb = write ? "written" : "would write"
    const lines = result.ok
      ? [
          ...changes.map(
            (c) =>
              `${c.deleted ? verb.replace("write", "delete") : verb} ${c.path}`
          ),
          ...(dryRun === true ? ["dry run: nothing written"] : []),
        ]
      : ["nothing written: the operation was refused or the result has errors"]
    return respond(
      o,
      { ok: result.ok, changes, diagnostics: result.diagnostics },
      lines,
      !result.ok
    )
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error))
  }
}

const dryRun = z.boolean().optional().meta({
  description: "Report the changes without writing them.",
})

const completion = (o: McpToolOptions) => ({
  schemaPath: schemaPathResolver(o.dir),
  newId: () => crypto.randomUUID(),
})

export function registerTools(server: McpServer, o: McpToolOptions): void {
  server.registerTool(
    "compile",
    {
      description:
        "Compile the metadata directory and return diagnostics. Reads the disk on every call; writes nothing.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const result = await compile(await readMetadataDir(o.dir))
        return respond(
          o,
          {
            ok: result.ok,
            changes: [],
            diagnostics: result.diagnostics,
          },
          [result.ok ? "compiled without errors" : "compilation has errors"],
          false
        )
      } catch (error) {
        return failure(error instanceof Error ? error.message : String(error))
      }
    }
  )

  server.registerTool(
    "explain",
    {
      description:
        "Explain one object: its tables, columns, keys and movement queries. Needs a metadata directory that compiles without errors.",
      inputSchema: z.object({
        kind: metadataKindSchema,
        name: objectNameSchema,
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ kind, name }) => {
      try {
        const result = await compile(await readMetadataDir(o.dir))
        if (result.model === undefined) {
          return respond(
            o,
            { ok: false, changes: [], diagnostics: result.diagnostics },
            ["cannot explain: the metadata has errors"],
            true
          )
        }
        const explanation = explainObject(result.model, { kind, name })
        if (explanation === undefined) {
          return failure(`Object not found: ${kind} ${name}`)
        }
        return {
          structuredContent: { ...explanation },
          content: [
            { type: "text", text: JSON.stringify(explanation, null, 2) },
          ],
        }
      } catch (error) {
        return failure(error instanceof Error ? error.message : String(error))
      }
    }
  )

  // Інструменти мутацій не існують у read-only режимі: клієнт їх не бачить.
  if (!o.allowWrite) return

  server.registerTool(
    "create_object",
    {
      description:
        "Create a metadata object; ids and physical names are assigned. Writes only when the result compiles without errors.",
      inputSchema: createObjectInput.extend({ dryRun }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    ({ dryRun: dry, ...input }) =>
      mutate(o, dry, (files) => createObject(files, input, completion(o)))
  )

  server.registerTool(
    "add_element",
    {
      description:
        "Add a named element (attribute, tabular section, value, scope kind, ...) to a collection of an object or of the project root. Writes only when the result compiles without errors.",
      inputSchema: addElementInput.extend({ dryRun }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    ({ dryRun: dry, ...input }) =>
      mutate(o, dry, (files) => addElement(files, input, completion(o)))
  )

  server.registerTool(
    "rename",
    {
      description:
        "Rename an object or a nested element; references are rewritten, ids and physical names never change. Writes only when the result compiles without errors.",
      inputSchema: renameInput.extend({ dryRun }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    ({ dryRun: dry, ...input }) =>
      mutate(o, dry, (files) => renameElement(files, input))
  )

  server.registerTool(
    "delete",
    {
      description:
        "Delete an object or a nested element. Refused while anything references it. Requires confirm: true.",
      inputSchema: deleteInput.extend({ dryRun, confirm: z.boolean() }),
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    ({ dryRun: dry, confirm, ...input }) => {
      if (confirm !== true) {
        return failure(
          "Refused: delete requires confirm: true. Nothing changed."
        )
      }
      return mutate(o, dry, (files) => deleteElement(files, input))
    }
  )
}
