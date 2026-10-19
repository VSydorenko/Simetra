import { dirname, join, posix, relative, resolve, sep } from "node:path"
import type { SchemaPathResolver } from "simetra/compiler"
import { installedPackageDir } from "./package-path"

/**
 * Резолвер `$schema` для теки метаданих: відносний POSIX-шлях від теки файлу
 * до `node_modules/simetra/schemas/…` проєкту. Саме встановлений пакет, а не
 * той, з якого запущено інструмент: `$schema` вказує на схеми тієї версії,
 * з якою проєкт збирається (спека П2 §8.5). Пакет шукається ліниво — лише
 * коли компілятор справді записує `$schema`, тож читальні виклики працюють і
 * в теці без встановленого пакета.
 */
export function schemaPathResolver(metadataDir: string): SchemaPathResolver {
  const root = resolve(metadataDir)
  let schemas: string | undefined
  return (file, schemaFile) => {
    schemas ??= join(installedPackageDir(root, "simetra"), "schemas")
    return relative(dirname(join(root, file)), join(schemas, schemaFile))
      .split(sep)
      .join(posix.sep)
  }
}
