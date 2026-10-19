import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
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
  readOnly: false,
  allowDatabaseWrite: false,
  dryRun: false,
  confirmed: false,
  channel: "cli",
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

export const TAG_FILE = "custom-tables/Tag/Tag.meta.json"

/** Прийнята таблиця `Tag` (без скоупу) у проєкті еталона: кандидат у довідник. */
export async function addAdoptedTag(dir: string): Promise<void> {
  const column = (n: number, name: string, rest: Record<string, unknown>) => ({
    id: `00000000-0000-4000-8000-00000000a0${n.toString().padStart(2, "0")}`,
    name,
    physicalName: name,
    ...rest,
  })
  const table = {
    id: "00000000-0000-4000-8000-00000000a000",
    kind: "CustomTable",
    name: "Tag",
    physicalName: "tags",
    kindLabel: "tag",
    scope: "none",
    columns: [
      column(1, "id", { type: "UUID", notNull: true }),
      column(2, "name", { type: "Text", notNull: true }),
    ],
    primaryKey: { name: "tags_pkey", columns: ["id"] },
    rowLevelSecurity: "enabled",
  }
  await mkdir(dirname(join(dir, TAG_FILE)), { recursive: true })
  await writeFile(join(dir, TAG_FILE), JSON.stringify(table, null, 2))
}

/** Повний мапінг `Tag` у довідник `Tag`: кожна колонка названа. */
export const tagMapping = {
  target: { name: "Tag" },
  into: { kind: "Catalog", name: "Tag", data: { codeLength: 0 } },
  columns: {
    id: { to: "standard", name: "ref" },
    name: { to: "standard", name: "description" },
  },
}
