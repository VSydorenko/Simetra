import type { z } from "zod"
import { writeChanges } from "../io/metadata-dir"
import { UsageError } from "../io/usage-error"
import { queueFor } from "./queue"
import { DEFAULT_DATABASE_URL_ENV, noDatabaseHint, readOnlyHint } from "./hints"
import type {
  DatabaseAccess,
  FilesAccess,
  InvokeOptions,
  RefusalReason,
  Tool,
  ToolResult,
} from "./types"

/**
 * Вичерпні switch по обох осях: нове значення осі не компілюється, доки не
 * вирішено його дозвіл. `--read-only` вимикає будь-який запис; власне тертя
 * запису в базу (підтвердження з показаним планом) — ознака `destructive`.
 */
export function permits(tool: Tool, o: { readOnly: boolean }): boolean {
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
      databaseOk = !o.readOnly
      break
  }
  return filesOk && databaseOk
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
  if (!permits(tool, o)) return refused("read-only", readOnlyHint(o.launchArgs))
  if (tool.database !== "none" && o.database === undefined)
    return refused(
      "no-database",
      noDatabaseHint(o.databaseEnv ?? DEFAULT_DATABASE_URL_ENV, o.channel)
    )
  // Dry-run нічого не пише, тож підтвердження там нічого не захищає, а агентові
  // перегляд потрібен саме до `confirm`.
  if (tool.destructive && !o.dryRun && !o.confirmed) {
    return refused(
      "unconfirmed",
      `${tool.name} is destructive and needs confirmation. Nothing changed.`
    )
  }
  return queueFor(o.dir)(async () => {
    try {
      // Інструмент без осі бази ресурсу не бачить, тож і не відкриє пулу.
      const outcome = await tool.run(
        {
          dir: o.dir,
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
      if (write) await writeChanges(o.dir, outcome.changes)
      return {
        ok: outcome.ok,
        written: write,
        changes: outcome.changes.map((c) => ({
          path: c.path,
          deleted: c.content === null,
        })),
        diagnostics: outcome.diagnostics,
        ...(outcome.data === undefined ? {} : { data: outcome.data }),
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
