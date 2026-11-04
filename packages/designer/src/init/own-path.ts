import { posix, win32 } from "node:path"

export const DESIGNER_PACKAGE = "@simetrajs/designer"

const PACKAGE_DIR = `/node_modules/${DESIGNER_PACKAGE}/`

/**
 * Сегменти шляху всередині встановленого пакета designer: `target`
 * резолвиться від `base` і нормалізується, тоді береться хвіст після
 * останнього `node_modules/@simetrajs/designer/`. `undefined` — шлях поза
 * пакетом. Власність судиться за нормалізованим шляхом, а не за підрядком:
 * `node_modules/@simetrajs/designer/skills/../../other` містить сегмент
 * пакета, але веде за його межі. На Windows регістр не розрізняється, а
 * роздільник буває будь-який, тож шлях зводиться до нижнього регістру й `/`.
 */
export function packageSubpath(
  base: string,
  target: string,
  platform: NodeJS.Platform
): string[] | undefined {
  const path =
    platform === "win32"
      ? win32.resolve(base, target).replaceAll("\\", "/").toLowerCase()
      : posix.resolve(base, target.replaceAll("\\", "/"))
  const at = path.lastIndexOf(PACKAGE_DIR)
  if (at === -1) return undefined
  const rest = path
    .slice(at + PACKAGE_DIR.length)
    .split("/")
    .filter(Boolean)
  return rest.length > 0 ? rest : undefined
}
