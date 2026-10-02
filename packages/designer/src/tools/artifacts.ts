import {
  canonicalSnapshot,
  emitEntityTypes,
  type CompiledModel,
  type FileChange,
} from "simetra/compiler"
import { renderDesiredState } from "simetra/schema"

/**
 * Артефакти компіляції як зміни файлів: рішення, куди й чи писати, ухвалює
 * адаптер (`compile --out`), тут лише вміст.
 */
export function compileArtifacts(model: CompiledModel): FileChange[] {
  return [
    {
      path: "snapshot.json",
      content: `${JSON.stringify(canonicalSnapshot(model), null, 2)}\n`,
    },
    { path: "desired-state.sql", content: renderDesiredState(model).sql },
    { path: "entities.d.ts", content: emitEntityTypes(model) },
  ]
}
