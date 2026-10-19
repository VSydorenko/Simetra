import { cp, mkdir, mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const REFERENCE = resolve(
  __dirname,
  "../../../../../examples/reference/metadata"
)
const SIMETRA = resolve(__dirname, "../../../../simetra")

/**
 * Тимчасовий проєкт: копія еталонних метаданих у `dir` і симлінк
 * `node_modules/simetra` → пакет у репо. Симлінк потрібен, щоб `$schema`
 * резолвився через встановлений пакет так само, як у справжньому проєкті.
 */
export async function tmpProject(): Promise<{
  root: string
  dir: string
  dispose(): Promise<void>
}> {
  const root = await mkdtemp(join(tmpdir(), "simetra-designer-"))
  const dir = join(root, "metadata")
  await cp(REFERENCE, dir, { recursive: true })
  await mkdir(join(root, "node_modules"))
  await symlink(SIMETRA, join(root, "node_modules", "simetra"), "dir")
  return { root, dir, dispose: () => rm(root, { recursive: true }) }
}
