import type { CallToolResult, McpServer } from "@modelcontextprotocol/server"
import type { PromotionRecord } from "simetra/compiler"
import { z } from "zod"
import {
  formatDiagnostics,
  renderApply,
  renderDiff,
  renderPlan,
} from "../io/report"
import { TOOLS, type Tool, type ToolResult } from "../tools/catalog"
import { invoke } from "../tools/invoke"
import type { ApplyData, PlanData } from "../tools/apply-tools"
import type { DiffData } from "../tools/database-tools"
import type { DatabaseResource } from "../tools/types"

export interface McpToolOptions {
  dir: string
  readOnly: boolean
  /** Прапорець запуску `--allow-database-write`: без нього `apply` відмовляє. */
  allowDatabaseWrite?: boolean
  /** Ресурс запуску; без нього інструменти бази відмовляють із підказкою. */
  database?: DatabaseResource
  /** Ім'я змінної середовища з рядком підключення: його називає відмова. */
  databaseEnv?: string
  /** Справжній argv запуску: потрапляє в підказку відмови запису. */
  launchArgs?: readonly string[]
}

const dryRun = z.boolean().optional().meta({
  description: "Report the changes without writing them.",
})

// Необов'язкове: перегляд руйнівної зміни (`dryRun`) не потребує підтвердження.
const confirm = z.boolean().optional().meta({
  description: "Must be true to actually perform a destructive change.",
})

/**
 * Схема входу MCP = вхід каталогу плюс транспортні поля. Дозвіл, підтвердження
 * й запис вирішує `invoke`, тож тут лише перелік полів, які він отримує.
 */
export function mcpInputSchema(tool: Tool): z.ZodType {
  // `dryRun` — лише змінам теки метаданих; `confirm` — кожному руйнівному,
  // зокрема `apply`, що теки не змінює: інакше підтвердження до нього не
  // дійшло б. Вичерпно по осі файлів: нове значення вирішує тут свій перегляд
  let previews: boolean
  switch (tool.files) {
    case "read":
    case "artifact":
      previews = false
      break
    case "write":
      previews = true
      break
  }
  if (!previews && !tool.destructive) return tool.input
  if (!(tool.input instanceof z.ZodObject)) {
    throw new Error(
      `tool ${tool.name} needs an object input for dryRun/confirm`
    )
  }
  return tool.input.extend({
    ...(previews ? { dryRun } : {}),
    ...(tool.destructive ? { confirm } : {}),
  })
}

function lineFor(
  c: { path: string; deleted: boolean },
  written: boolean
): string {
  if (written) return `${c.deleted ? "deleted" : "written"} ${c.path}`
  return `${c.deleted ? "would delete" : "would write"} ${c.path}`
}

function toResponse(
  tool: Tool,
  result: ToolResult,
  o: McpToolOptions,
  dry: boolean
): CallToolResult {
  const { ok, written, changes, diagnostics, refusal } = result
  if (refusal !== undefined) {
    return {
      isError: true,
      structuredContent: { ok, written, changes, diagnostics },
      content: [{ type: "text", text: refusal.message }],
    }
  }
  // `explain` віддає саме пояснення; решта — єдину обгортку результату.
  if (tool.name === "explain" && ok && result.data !== undefined) {
    return {
      structuredContent: { ...(result.data as Record<string, unknown>) },
      content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }],
    }
  }
  const report = formatDiagnostics(diagnostics, {
    dir: o.dir,
    locale: "en",
    format: "text",
  })
  // Дані бази — повністю в `structuredContent`, текст — зведення. Відмінності
  // звірки — не помилка виклику: `isError` лише за помилками діагностики
  if (tool.name === "diff" && result.data !== undefined) {
    const data = result.data as DiffData
    return {
      isError: !ok,
      structuredContent: { ok, written, changes, ...data },
      content: [{ type: "text", text: renderDiff(data, report) }],
    }
  }
  // `planHash` — вхід `apply`: без нього в `structuredContent` агент не
  // підтвердить показаний план. Текст — той самий, що в CLI: дрейф першим
  if (tool.name === "plan") {
    const data = result.data as PlanData | undefined
    return {
      isError: !ok,
      structuredContent: {
        ok,
        written,
        artifacts: result.artifacts ?? [],
        diagnostics,
        ...data,
      },
      content: [
        { type: "text", text: renderPlan(data, report, { ok, written }) },
      ],
    }
  }
  // Шлях звіту репетиції — в `artifacts`, як у `plan`: агент читає файл
  // звідти, а не з тексту
  if (tool.name === "apply") {
    const data = result.data as ApplyData | undefined
    return {
      isError: !ok,
      structuredContent: {
        ok,
        written,
        artifacts: result.artifacts ?? [],
        diagnostics,
        ...data,
      },
      content: [{ type: "text", text: renderApply(data, diagnostics, report) }],
    }
  }
  // Запис промоції — вхід плану бази: повністю в `structuredContent`, а в
  // тексті JSON-блоком, бо агент без нього не побачить, що саме перейменовано.
  const record =
    tool.name === "promote"
      ? (result.data as PromotionRecord | undefined)
      : undefined
  // Збій роботи з базою — не помилка метаданих: зведення не має слати
  // викликача правити теку, коли виправляти треба базу чи підключення
  const databaseFailed = diagnostics.some((d) => d.code === "database.failed")
  // Чужий власник у базі — теж справа бази, а не теки
  const databaseUnreadable = diagnostics.some(
    (d) => d.code === "engine.owner-not-member"
  )
  const lines = ok
    ? [
        ...changes.map((c) => lineFor(c, written)),
        ...(dry && tool.files === "write" ? ["dry run: nothing written"] : []),
        ...(tool.files === "read" ? [`${tool.name}: no errors`] : []),
      ]
    : databaseFailed
      ? [
          `${tool.files === "write" ? "nothing written" : tool.name}: the database work failed`,
        ]
      : databaseUnreadable
        ? [`${tool.name}: the database has objects the engine cannot read`]
        : tool.files === "write"
          ? [
              "nothing written: the operation was refused or the result has errors",
            ]
          : [`${tool.name}: the metadata has errors`]
  return {
    isError: !ok,
    structuredContent: {
      ok,
      written,
      changes,
      diagnostics,
      ...(tool.name === "introspect" && result.data !== undefined
        ? (result.data as Record<string, unknown>)
        : {}),
      ...(record === undefined ? {} : { record }),
    },
    content: [
      {
        type: "text",
        text: [
          ...lines,
          report,
          ...(record === undefined
            ? []
            : ["promotion record:", JSON.stringify(record, null, 2)]),
        ].join("\n"),
      },
    ],
  }
}

/** Реєструє весь каталог: транспорт лише переказує `confirm`/`dryRun` у `invoke`. */
export function registerCatalog(server: McpServer, o: McpToolOptions): void {
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        // Опис не залежить від режиму, щоб `tools/list` не залежав від прапорця.
        description: tool.description,
        inputSchema: mcpInputSchema(tool),
        annotations: {
          readOnlyHint: tool.files === "read" && tool.database !== "write",
          destructiveHint: tool.destructive,
        },
      },
      async (args: unknown) => {
        const {
          dryRun: dry,
          confirm: confirmed,
          ...input
        } = (args ?? {}) as Record<string, unknown>
        const result = await invoke(tool, input, {
          dir: o.dir,
          readOnly: o.readOnly,
          allowDatabaseWrite: o.allowDatabaseWrite === true,
          dryRun: dry === true,
          confirmed: confirmed === true,
          channel: "mcp",
          database: o.database,
          ...(o.databaseEnv === undefined
            ? {}
            : { databaseEnv: o.databaseEnv }),
          launchArgs: o.launchArgs,
        })
        return toResponse(tool, result, o, dry === true)
      }
    )
  }
}
