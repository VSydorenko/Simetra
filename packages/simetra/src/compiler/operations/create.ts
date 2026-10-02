import { KIND_REGISTRY } from "simetra/model"
import { diagnostic } from "../diagnostics"
import { completeAndCompile, type CompletionOptions } from "./fix"
import type { CreateObjectInput } from "./inputs"
import { compileInput, refused } from "./refuse"
import type { OperationResult } from "./types"

/**
 * Створює об'єкт (спека П2 §8.6): файл `<тека виду>/<Name>/<Name>.meta.json`
 * з `kind`, `name` і полями `data`; id, `physicalName`, `$schema` і канонічну
 * форму дає те саме доповнення, що `fix`, — лише в новому файлі.
 */
export async function createObject(
  files: ReadonlyMap<string, string>,
  input: CreateObjectInput,
  o: CompletionOptions
): Promise<OperationResult> {
  const clean = await compileInput(files)
  if (!clean.ok) return clean.result

  const def = KIND_REGISTRY[input.kind]
  const path = `${def.dir}/${input.name}/${input.name}.meta.json`
  const existing = clean.model.objects.find(
    (object) => object.kind === input.kind && object.name === input.name
  )
  if (existing !== undefined || files.has(path)) {
    return refused([
      diagnostic("operation.object-exists", existing?.file ?? path, "", {
        kind: input.kind,
        name: input.name,
      }),
    ])
  }

  // `kind` і `name` входу головніші за однойменні поля `data`: саме вони
  // задають шлях файлу.
  const raw = { ...input.data, kind: input.kind, name: input.name }
  const after = new Map(files)
  after.set(path, JSON.stringify(raw))
  return completeAndCompile(files, after, o, new Set([path]))
}
