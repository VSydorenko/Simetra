import { z } from "zod"
import { KIND_REGISTRY, projectSchema } from "simetra/model"

const PROJECT_SCHEMA_FILE = "project.schema.json"

/**
 * JSON Schema файлів метаданих для редакторів. Ключ — ім'я файлу в
 * `packages/simetra/schemas/`. Правила `superRefine` (rules.ts) у схему не
 * потрапляють: їх перевіряє стадія 1, а `unrepresentable: "throw"` гарантує,
 * що жодна частина форми не випала мовчки.
 */
export function buildJsonSchemas(): Record<string, object> {
  const emit = (schema: z.ZodType, file: string): object => ({
    ...z.toJSONSchema(schema, {
      target: "draft-2020-12",
      io: "input",
      unrepresentable: "throw",
    }),
    $id: file,
  })

  const result: Record<string, object> = {}
  for (const def of Object.values(KIND_REGISTRY)) {
    const file = `${def.dir}.schema.json`
    result[file] = emit(def.schema, file)
  }
  result[PROJECT_SCHEMA_FILE] = emit(projectSchema, PROJECT_SCHEMA_FILE)
  return result
}
