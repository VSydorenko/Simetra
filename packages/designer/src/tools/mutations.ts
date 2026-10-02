import {
  addElement,
  addElementInput,
  createObject,
  createObjectInput,
  deleteElement,
  deleteInput,
  renameElement,
  renameInput,
  type CompletionOptions,
  type OperationResult,
} from "simetra/compiler"
import { readMetadataDir } from "../io/metadata-dir"
import { schemaPathResolver } from "../io/schema-path"
import type { RunOutcome } from "./types"
import { defineTool } from "./types"

const completion = (dir: string): CompletionOptions => ({
  schemaPath: schemaPathResolver(dir),
  newId: () => crypto.randomUUID(),
})

/**
 * Тека читається заново на кожен виклик (стан — диск, не пам'ять процесу), а
 * в T1 іде лише валідований вхід операції. Запис і dry-run вирішує `invoke`.
 */
async function apply(
  dir: string,
  operation: (files: Map<string, string>) => Promise<OperationResult>
): Promise<RunOutcome<undefined>> {
  const result = await operation(await readMetadataDir(dir))
  return {
    ok: result.ok,
    changes: result.changes,
    diagnostics: result.diagnostics,
  }
}

export const createTool = defineTool({
  name: "create",
  description:
    "Create a metadata object; ids and physical names are assigned. Writes only when the result compiles without errors.",
  input: createObjectInput,
  effect: "files",
  destructive: false,
  run: ({ dir }, input) =>
    apply(dir, (files) => createObject(files, input, completion(dir))),
})

export const addTool = defineTool({
  name: "add",
  description:
    "Add a named element (attribute, tabular section, value, scope kind, ...) to a collection of an object or of the project root. Writes only when the result compiles without errors.",
  input: addElementInput,
  effect: "files",
  destructive: false,
  run: ({ dir }, input) =>
    apply(dir, (files) => addElement(files, input, completion(dir))),
})

export const renameTool = defineTool({
  name: "rename",
  description:
    "Rename an object or a nested element; references are rewritten, ids and physical names never change. Writes only when the result compiles without errors.",
  input: renameInput,
  effect: "files",
  destructive: false,
  run: ({ dir }, input) => apply(dir, (files) => renameElement(files, input)),
})

export const deleteTool = defineTool({
  name: "delete",
  description:
    "Delete an object or a nested element. Refused while anything references it.",
  input: deleteInput,
  effect: "files",
  destructive: true,
  run: ({ dir }, input) => apply(dir, (files) => deleteElement(files, input)),
})
