import type { CallToolResult, McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"
import { formatDiagnostics } from "../io/report"
import {
  structureOf,
  TOOLS,
  type PresentationView,
  type Tool,
  type ToolResult,
} from "../tools/catalog"
import { invoke } from "../tools/invoke"
import type { DataResource, DatabaseResource } from "../tools/types"

export interface McpToolOptions {
  dir: string
  readOnly: boolean
  /** Прапорець запуску `--allow-database-write`: без нього `apply` відмовляє. */
  allowDatabaseWrite?: boolean
  /** Ресурс запуску; без нього інструменти бази відмовляють із підказкою. */
  database?: DatabaseResource
  /** Ім'я змінної середовища з рядком підключення: його називає відмова. */
  databaseEnv?: string
  /** Прапорець запуску `--allow-data-write`: без нього `data-command` відмовляє. */
  allowDataWrite?: boolean
  /** Прапорець запуску `--allow-rights-write`: запис довідників прав даними. */
  allowRightsWrite?: boolean
  /** Ресурс даних запуску; без нього інструменти даних відмовляють `no-data`. */
  data?: DataResource
  /** Ім'я змінної даних, зафіксоване при запуску: його називає відмова. */
  dataEnv?: string
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
  // Вхід `cliOnly` на MCP не доходить (`registerCatalog` його пропускає), а
  // вхід-union не розширюється `extend`
  if (tool.cliOnly) return tool.input
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
  const {
    ok,
    written,
    wouldWrite,
    changes,
    diagnostics,
    refusal,
    data,
    artifacts,
  } = result
  if (refusal !== undefined) {
    // Код відмови — і в `structuredContent`: агент читає причину, а не текст
    return {
      isError: true,
      structuredContent: {
        ok,
        written,
        changes,
        diagnostics,
        refusal: {
          reason: refusal.reason,
          ...(refusal.detail === undefined ? {} : { detail: refusal.detail }),
        },
      },
      content: [{ type: "text", text: refusal.message }],
    }
  }
  const report = formatDiagnostics(diagnostics, {
    dir: o.dir,
    locale: "en",
    format: "text",
  })
  const view: PresentationView = {
    channel: "mcp",
    ok,
    written,
    diagnostics,
    report,
  }
  // Усі відмінності між інструментами — у `tool.present`, не в гілках за іменем
  const present = tool.present
  // `explain` віддає саме пояснення; решта — єдину обгортку результату.
  if (present?.bare === true && ok && data !== undefined) {
    return {
      structuredContent: { ...structureOf(tool, data) },
      content: [{ type: "text", text: present.text?.(data, view) ?? "" }],
    }
  }
  // Дані показуються, коли вони є: помилка компіляції чи збій бази не мають
  // даних і йдуть загальним видом з діагностикою. Інструмент осі `artifact`
  // повертає і відмову з артефактами (`planHash` — вхід `apply`, його агент
  // бере зі `structuredContent`)
  const shown = present !== undefined && data !== undefined
  const text = present?.text?.(data, view)
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
              // Результат, прийнятий режимом `repair` (спека декларацій
              // функцій §5.1), записано чи (перегляд) було б записано
              written
                ? "written: the result keeps only repair-class errors the directory already had"
                : wouldWrite === true
                  ? "would write: the result keeps only repair-class errors the directory already had"
                  : "nothing written: the operation was refused or the result has errors",
            ]
          : [`${tool.name}: the metadata has errors`]
  return {
    isError: !ok,
    structuredContent: {
      ok,
      written,
      ...(wouldWrite === true ? { wouldWrite } : {}),
      changes,
      ...(tool.files === "artifact" ? { artifacts: artifacts ?? [] } : {}),
      diagnostics,
      ...(shown ? structureOf(tool, data) : {}),
    },
    content: [
      {
        type: "text",
        text:
          text ??
          [
            ...lines,
            report,
            ...(shown && present.appendix !== undefined
              ? [present.appendix(data, view)]
              : []),
          ].join("\n"),
      },
    ],
  }
}

/** Реєструє весь каталог: транспорт лише переказує `confirm`/`dryRun` у `invoke`. */
export function registerCatalog(server: McpServer, o: McpToolOptions): void {
  for (const tool of TOOLS) {
    // Інструмент лише для командного рядка в MCP не реєструється
    if (tool.cliOnly) continue
    server.registerTool(
      tool.name,
      {
        // Опис не залежить від режиму, щоб `tools/list` не залежав від прапорця.
        description: tool.description,
        inputSchema: mcpInputSchema(tool),
        annotations: {
          readOnlyHint:
            tool.files === "read" &&
            tool.database !== "write" &&
            tool.data !== "write",
          // `delete` даних незворотний: клієнт за анотацією може питати
          // людину, хоча `confirm` інструмент не вимагає
          destructiveHint: tool.destructive || tool.data === "write",
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
          allowDataWrite: o.allowDataWrite === true,
          allowRightsWrite: o.allowRightsWrite === true,
          dryRun: dry === true,
          confirmed: confirmed === true,
          channel: "mcp",
          database: o.database,
          ...(o.databaseEnv === undefined
            ? {}
            : { databaseEnv: o.databaseEnv }),
          ...(o.data === undefined ? {} : { data: o.data }),
          ...(o.dataEnv === undefined ? {} : { dataEnv: o.dataEnv }),
          launchArgs: o.launchArgs,
        })
        return toResponse(tool, result, o, dry === true)
      }
    )
  }
}
