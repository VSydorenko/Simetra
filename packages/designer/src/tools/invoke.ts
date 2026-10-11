import { dirname, resolve, sep } from "node:path"
import type { FileChange } from "simetra/compiler"
import type { z } from "zod"
import { writeChanges } from "../io/metadata-dir"
import { UsageError } from "../io/usage-error"
import { queueFor } from "./queue"
import {
  DEFAULT_DATABASE_URL_ENV,
  databaseWriteHint,
  noDatabaseHint,
  readOnlyHint,
} from "./hints"
import {
  PLANS_DIR,
  type DatabaseAccess,
  type FilesAccess,
  type InvokeOptions,
  type RefusalReason,
  type Tool,
  type ToolResult,
} from "./types"

/**
 * Вичерпні switch по обох осях: нове значення осі не компілюється, доки не
 * вирішено його дозвіл. `--read-only` вимикає будь-який запис; запис у базу
 * ще й потребує рішення людини при запуску (`allowDatabaseWrite`), а власне
 * тертя (підтвердження з показаним планом) — ознака `destructive`.
 */
export function permits(
  tool: Tool,
  o: { readOnly: boolean; allowDatabaseWrite: boolean }
): boolean {
  const files: FilesAccess = tool.files
  const database: DatabaseAccess = tool.database
  let filesOk: boolean
  switch (files) {
    case "read":
      filesOk = true
      break
    case "write":
      filesOk = !o.readOnly
      break
  }
  let databaseOk: boolean
  switch (database) {
    case "none":
    case "read":
      // Читання бази без дозволу: захисти — read-only сесія цілі й рядок
      // підключення лише із середовища запуску.
      databaseOk = true
      break
    case "write":
      databaseOk = !o.readOnly && o.allowDatabaseWrite
      break
  }
  return filesOk && databaseOk
}

/**
 * Артефакт пишеться лише в `plans/` кореня проєкту (спека designer §3.2);
 * будь-який інший шлях — помилка інструмента, і перевіряється вона до
 * першого запису.
 */
function checkArtifacts(root: string, artifacts: readonly FileChange[]): void {
  const plans = resolve(root, PLANS_DIR) + sep
  for (const a of artifacts)
    if (!resolve(root, a.path).startsWith(plans))
      throw new UsageError(
        `An artifact must be written under ${PLANS_DIR}/ next to the metadata directory: ${a.path}`
      )
}

function refused<D>(reason: RefusalReason, message: string): ToolResult<D> {
  return {
    ok: false,
    written: false,
    changes: [],
    diagnostics: [],
    refusal: { reason, message },
  }
}

/**
 * Єдине місце рішень про розбір входу, дозволи, підтвердження й запис:
 * адаптери (CLI, MCP) лише переказують результат. Порядок має значення —
 * відмова на кожному кроці гарантує, що далі диск не чіпають.
 */
export async function invoke<D>(
  tool: Tool<z.ZodType, D>,
  input: unknown,
  o: InvokeOptions
): Promise<ToolResult<D>> {
  const parsed = tool.input.safeParse(input)
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((i) =>
        i.path.length === 0 ? i.message : `${i.path.join(".")}: ${i.message}`
      )
      .join("; ")
    return refused("invalid-input", message)
  }
  if (!permits(tool, o))
    // Коли заважає лише прапорець запису в базу, підказка називає саме його:
    // `--read-only` вимикає запис у базу завжди, і тоді радити прапорець марно
    return permits(tool, { ...o, allowDatabaseWrite: true })
      ? refused("database-write-disabled", databaseWriteHint(o.launchArgs))
      : refused("read-only", readOnlyHint(o.launchArgs))
  if (tool.database !== "none" && o.database === undefined)
    return refused(
      "no-database",
      noDatabaseHint(o.databaseEnv ?? DEFAULT_DATABASE_URL_ENV, o.channel)
    )
  // Dry-run нічого не пише, тож підтвердження там нічого не захищає, а агентові
  // перегляд потрібен саме до `confirm`. Лише для запису файлів: інструмент
  // без `dryRun` (`apply`) його не знає, і прапорець обійшов би підтвердження
  const preview = o.dryRun && tool.files === "write"
  if (tool.destructive && !preview && !o.confirmed) {
    return refused(
      "unconfirmed",
      `${tool.name} is destructive and needs confirmation. Nothing changed.`
    )
  }
  // Корінь — від абсолютного шляху: для `dir = "."` наївний `dirname` дав
  // би саму теку метаданих, і `plans/` опинився б у ній
  const root = dirname(resolve(o.dir))
  return queueFor(o.dir)(async () => {
    try {
      // Інструмент без осі бази ресурсу не бачить, тож і не відкриє пулу.
      const outcome = await tool.run(
        {
          dir: o.dir,
          root,
          ...(tool.database === "none" ? {} : { database: o.database }),
          ...(o.baseline === undefined ? {} : { baseline: o.baseline }),
        },
        parsed.data
      )
      const write =
        outcome.ok &&
        tool.files === "write" &&
        !o.dryRun &&
        outcome.changes.length > 0
      const artifacts = outcome.artifacts ?? []
      checkArtifacts(root, artifacts)
      const writeArtifacts =
        outcome.ok &&
        tool.files === "write" &&
        !o.dryRun &&
        artifacts.length > 0
      if (write) await writeChanges(o.dir, outcome.changes)
      if (writeArtifacts) await writeChanges(root, artifacts)
      return {
        ok: outcome.ok,
        written: write || writeArtifacts,
        changes: outcome.changes.map((c) => ({
          path: c.path,
          deleted: c.content === null,
        })),
        diagnostics: outcome.diagnostics,
        ...(outcome.data === undefined ? {} : { data: outcome.data }),
        ...(outcome.artifacts === undefined
          ? {}
          : { artifacts: outcome.artifacts.map((a) => a.path) }),
        ...(outcome.refusal === undefined
          ? {}
          : { refusal: { reason: "refused", message: outcome.refusal } }),
      } satisfies ToolResult<D>
    } catch (error) {
      // Лише помилки використання; решта — баги й летять далі.
      if (error instanceof UsageError) return refused("refused", error.message)
      throw error
    }
  })
}
