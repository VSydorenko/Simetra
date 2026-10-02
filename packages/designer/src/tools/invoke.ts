import type { z } from "zod"
import { writeChanges } from "../io/metadata-dir"
import { queueFor } from "./queue"
import type {
  Effect,
  InvokeOptions,
  RefusalReason,
  Tool,
  ToolResult,
} from "./types"
import { writeAccessHint } from "./write-access"

/** Вичерпний switch: новий `Effect` не компілюється, доки не вирішено дозвіл. */
export function permits(tool: Tool, o: { allowWrite: boolean }): boolean {
  const effect: Effect = tool.effect
  switch (effect) {
    case "read":
      return true
    case "files":
      return o.allowWrite
  }
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
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ")
    return refused("invalid-input", message)
  }
  if (!permits(tool, o)) return refused("write-disabled", writeAccessHint())
  if (tool.destructive && !o.confirmed) {
    return refused(
      "unconfirmed",
      `${tool.name} is destructive and needs confirmation. Nothing changed.`
    )
  }
  return queueFor(o.dir)(async () => {
    const outcome = await tool.run({ dir: o.dir }, parsed.data)
    const write = outcome.ok && tool.effect === "files" && !o.dryRun
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
    }
  })
}
