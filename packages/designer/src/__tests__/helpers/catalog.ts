import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { afterEach } from "vitest"
import { toolByName } from "../../tools/catalog"
import { invoke } from "../../tools/invoke"
import type { InvokeOptions } from "../../tools/types"
import { tmpProject } from "./tmp-project"

const disposers: (() => Promise<void>)[] = []

/** Реєструє прибирання тимчасових проєктів; викликати на верхньому рівні файлу тестів. */
export function useTmpProjects(): void {
  afterEach(async () => {
    await Promise.all(disposers.splice(0).map((d) => d()))
  })
}

export async function project(): Promise<string> {
  const p = await tmpProject()
  disposers.push(p.dispose)
  return p.dir
}

export const opts = (dir: string): InvokeOptions => ({
  dir,
  allowWrite: true,
  dryRun: false,
  confirmed: false,
})

export const run = (
  name: string,
  dir: string,
  input: unknown,
  o: InvokeOptions = opts(dir)
) => invoke(toolByName(name)!, input, o)

export async function snapshotOf(dir: string): Promise<Record<string, string>> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true })
  const result: Record<string, string> = {}
  for (const e of entries) {
    if (!e.isFile()) continue
    const full = join(e.parentPath, e.name)
    result[full] = await readFile(full, "utf8")
  }
  return result
}
