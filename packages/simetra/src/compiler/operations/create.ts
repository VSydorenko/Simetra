import { KIND_REGISTRY } from "simetra/model"
import { diagnostic } from "../diagnostics"
import { completeAndCompile, type CompletionOptions } from "./fix"
import type { CreateObjectInput } from "./inputs"
import { toPlatformFormsAfter } from "./platform-forms"
import { compileInput, refused, refuseSuppliedId } from "./refuse"
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
  const supplied = refuseSuppliedId(files, input.data, "data")
  if (supplied !== undefined) return supplied
  // Режим `repair` (спека декларацій функцій §5.1): тека після зворотної
  // генерації з помилками лише класу ремонту доходить до 0 помилок саме
  // мутаціями, тож вхід з ними приймається, а хвіст не дає додати нову.
  const clean = await compileInput(files, { repair: true })
  if (!clean.ok) return clean.result

  const def = KIND_REGISTRY[input.kind]
  const path = `${def.dir}/${input.name}/${input.name}.meta.json`
  const existing = clean.model.objects.find(
    (object) => object.kind === input.kind && object.name === input.name
  )
  if (existing !== undefined || files.has(path)) {
    return refused(files, [
      diagnostic("operation.object-exists", existing?.file ?? path, "", {
        kind: input.kind,
        name: input.name,
      }),
    ])
  }

  // `kind` і `name` входу головніші за однойменні поля `data`: саме вони
  // задають шлях файлу.
  const raw = { ...input.data, kind: input.kind, name: input.name }
  const changed = new Map(files)
  changed.set(path, JSON.stringify(raw))
  // Новий об'єкт може зробити задекларовану функцію формою платформи
  // (обробник підписки): декларація зникає в тій самій зміні (Р12).
  const after = await toPlatformFormsAfter(files, changed)
  return completeAndCompile(
    files,
    after.files,
    o,
    new Set([path]),
    clean.accepted,
    after.diagnostics
  )
}
