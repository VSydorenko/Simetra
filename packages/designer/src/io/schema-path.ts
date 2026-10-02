import { dirname, join, posix, relative, sep } from "node:path"
import { fileURLToPath } from "node:url"
import type { SchemaPathResolver } from "simetra/compiler"

/**
 * Тека JSON Schema встановленого пакета `simetra`: `$schema` вказує на
 * справжній файл тієї ж версії, що й компілятор (спека П2 §8.5).
 */
function schemasDir(): string {
  return dirname(
    fileURLToPath(import.meta.resolve("simetra/schemas/project.schema.json"))
  )
}

/**
 * Резолвер `$schema` для теки метаданих: відносний POSIX-шлях від теки файлу
 * до файлу схеми, тож значення не залежить від ОС і переживає перенос репо.
 */
export function schemaPathResolver(metadataDir: string): SchemaPathResolver {
  const schemas = schemasDir()
  return (file, schemaFile) =>
    relative(dirname(join(metadataDir, file)), join(schemas, schemaFile))
      .split(sep)
      .join(posix.sep)
}
