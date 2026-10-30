import {
  addElement,
  addElementInput,
  createObject,
  createObjectInput,
  deleteElement,
  deleteInput,
  promoteInput,
  promoteObject,
  promotionFileName,
  renameElement,
  renameInput,
  type CompletionOptions,
  type OperationResult,
  type PromotionRecord,
  type PromoteResult,
  serializeCanonical,
} from "simetra/compiler"
import { readMetadataDir } from "../io/metadata-dir"
import { schemaPathResolver } from "../io/schema-path"
import type { RunOutcome } from "./types"
import { defineTool, PLANS_DIR } from "./types"

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

/**
 * Те саме для `promote`: запис промоції їде в `data` і артефактом у
 * `plans/<objectId>.promotion.json` — план бази читає його звідти (спека
 * промоції §7.1), бо мапінг у `metadata/` не лишається.
 */
async function applyPromotion(
  dir: string,
  operation: (files: Map<string, string>) => Promise<PromoteResult>
): Promise<RunOutcome<PromotionRecord>> {
  const result = await operation(await readMetadataDir(dir))
  const { record } = result
  return {
    ok: result.ok,
    changes: result.changes,
    diagnostics: result.diagnostics,
    ...(record === undefined
      ? {}
      : {
          data: record,
          artifacts: [
            {
              path: `${PLANS_DIR}/${promotionFileName(record.objectId)}`,
              content: serializeCanonical(record),
            },
          ],
        }),
  }
}

export const createTool = defineTool({
  name: "create",
  description:
    "Create a metadata object; ids and physical names are assigned. Writes only when the result compiles without errors.",
  input: createObjectInput,
  files: "write",
  database: "none",
  destructive: false,
  run: ({ dir }, input) =>
    apply(dir, (files) => createObject(files, input, completion(dir))),
})

export const addTool = defineTool({
  name: "add",
  description:
    "Add a named element (attribute, tabular section, value, scope kind, ...) to a collection of an object or of the project root. Writes only when the result compiles without errors.",
  input: addElementInput,
  files: "write",
  database: "none",
  destructive: false,
  run: ({ dir }, input) =>
    apply(dir, (files) => addElement(files, input, completion(dir))),
})

export const renameTool = defineTool({
  name: "rename",
  description:
    "Rename an object or a nested element; references are rewritten, ids and physical names never change. Writes only when the result compiles without errors.",
  input: renameInput,
  files: "write",
  database: "none",
  destructive: false,
  run: ({ dir }, input) => apply(dir, (files) => renameElement(files, input)),
})

export const deleteTool = defineTool({
  name: "delete",
  description:
    "Delete an object or a nested element. Refused while anything references it.",
  input: deleteInput,
  files: "write",
  database: "none",
  destructive: true,
  run: ({ dir }, input) => apply(dir, (files) => deleteElement(files, input)),
})

// Вхід сюди приходить уже розібраним `promoteInput` (це робить `invoke`):
// `promoteObject` сам не вилучає призначених полів, а покладається на схему.
export const promoteTool = defineTool<typeof promoteInput, PromotionRecord>({
  name: "promote",
  description:
    "Promote an adopted CustomTable (with its tabular-section tables) into a Catalog, a Document without movements or an independent InformationRegister from a complete one-off mapping; ids carry over, names become canonical, dependent function bodies are rewritten. Writes only when the result compiles; returns the promotion record for the database plan.",
  input: promoteInput,
  files: "write",
  database: "none",
  destructive: false,
  run: ({ dir }, input) =>
    applyPromotion(dir, (files) =>
      promoteObject(files, input, completion(dir))
    ),
})
