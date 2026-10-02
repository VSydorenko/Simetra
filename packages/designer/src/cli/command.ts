import { stat } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { defineCommand, type ArgsDef, type CommandDef } from "citty"
import type { CompiledModel, Explanation, Locale } from "simetra/compiler"
import { writeChanges } from "../io/metadata-dir"
import { formatDiagnostics } from "../io/report"
import { UsageError } from "../io/usage-error"
import { compileArtifacts } from "../tools/artifacts"
import { TOOLS, type Tool, type ToolResult } from "../tools/catalog"
import { invoke } from "../tools/invoke"
import { cliInput, takesJsonInput, type CliArgs } from "./input"
import { renderExplanation } from "./render"

export type { CliArgs } from "./input"

export interface RunResult {
  exitCode: 0 | 1 | 2
  stdout: string
  stderr: string
}

const readStdin = async (): Promise<string> => {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString("utf8")
}

const fail = (message: string): RunResult => ({
  exitCode: 2,
  stdout: "",
  stderr: `error: ${message}\n`,
})

function isLocale(v: string): v is Locale {
  return v === "en" || v === "uk"
}

function isFormat(v: string): v is "text" | "json" {
  return v === "text" || v === "json"
}

/** Кінцевий результат одного виклику в тексті/JSON для терміналу. */
function renderOne(
  tool: Tool,
  r: ToolResult,
  o: { dir: string; locale: Locale; format: "text" | "json" }
): { stdout: string; json?: unknown[] } {
  const report = formatDiagnostics(r.diagnostics, o)
  if (tool.name === "compile") {
    return o.format === "json"
      ? { stdout: "", json: JSON.parse(report) as unknown[] }
      : { stdout: report }
  }
  if (tool.name === "explain" && r.ok && r.data !== undefined) {
    const explanation = r.data as Explanation
    return {
      stdout:
        o.format === "json"
          ? JSON.stringify(explanation, null, 2)
          : renderExplanation(explanation).trimEnd(),
    }
  }
  if (tool.effect === "read") return { stdout: report }
  const changed = r.changes.map((c) => c.path)
  if (o.format === "json") {
    return {
      stdout: JSON.stringify(
        {
          ok: r.ok,
          written: r.written,
          changed,
          diagnostics: JSON.parse(report) as unknown,
        },
        null,
        2
      ),
    }
  }
  const verb = (deleted: boolean): string =>
    r.written
      ? deleted
        ? "deleted"
        : "written"
      : deleted
        ? "would delete"
        : "would write"
  return {
    stdout: [
      ...r.changes.map((c) => `${verb(c.deleted)} ${o.dir}/${c.path}`),
      ...(r.ok ? [] : ["nothing written: the result has errors"]),
      report,
    ].join("\n"),
  }
}

/**
 * Не викликає `process.exit`: код виходу ставить `main.ts`, тож тести
 * проганяють команду в процесі. Рішення про дозвіл, підтвердження й запис
 * приймає `invoke`; тут лише argv → вхід і результат → код та текст. Єдиний
 * запис поза `invoke` — вигляд `compile --out`, що існує лише в CLI.
 */
export async function runTool(
  tool: Tool,
  argv: CliArgs,
  stdin: () => Promise<string> = readStdin
): Promise<RunResult> {
  try {
    const locale = argv.locale ?? "en"
    const format = argv.format ?? "text"
    if (!isLocale(locale)) {
      throw new UsageError(`Invalid --locale "${locale}". Expected en or uk.`)
    }
    if (!isFormat(format)) {
      throw new UsageError(
        `Invalid --format "${format}". Expected text or json.`
      )
    }
    const { input, dirs } = await cliInput(tool, argv, stdin)
    const out = tool.name === "compile" ? argv.out : undefined
    if (out !== undefined) {
      // Усі теки метаданих названі однаково (`metadata`), тож спільного `--out`
      // для кількох не вигадати без колізій.
      if (dirs.length > 1) {
        throw new UsageError("--out accepts exactly one metadata directory.")
      }
      // Створювати вкладений шлях мовчки — ховати помилку в написанні.
      const parent = dirname(resolve(out))
      const isDir = await stat(parent).then(
        (s) => s.isDirectory(),
        () => false
      )
      if (!isDir) {
        throw new UsageError(`--out parent directory not found: ${parent}`)
      }
    }

    const blocks: string[] = []
    const allJson: unknown[] = []
    let failed = false
    for (const dir of dirs) {
      const result = await invoke(tool, input, {
        dir,
        allowWrite: true,
        dryRun: argv["dry-run"] === true,
        confirmed: argv.yes === true,
      })
      if (result.refusal !== undefined) return fail(result.refusal.message)
      failed ||= !result.ok
      const rendered = renderOne(tool, result, { dir, locale, format })
      if (rendered.json !== undefined) allJson.push(...rendered.json)
      else blocks.push(rendered.stdout)

      // Артефакти — лише з `--out` і лише з моделі без помилок.
      const model = (result.data as { model?: CompiledModel } | undefined)
        ?.model
      if (out !== undefined && model !== undefined) {
        await writeChanges(out, compileArtifacts(model))
      }
    }
    const stdout =
      tool.name === "compile" && format === "json"
        ? `${JSON.stringify(allJson, null, 2)}\n`
        : `${blocks.join("\n")}\n`
    return { exitCode: failed ? 1 : 0, stdout, stderr: "" }
  } catch (error) {
    if (error instanceof UsageError) return fail(error.message)
    throw error
  }
}

function argsFor(tool: Tool): ArgsDef {
  const args: ArgsDef = {}
  if (tool.name === "compile") {
    args.dirs = {
      type: "positional",
      description: "Metadata directories (default: ./metadata)",
      required: false,
    }
    args.out = {
      type: "string",
      description: "Write snapshot.json, desired-state.sql, entities.d.ts here",
    }
  } else if (tool.name === "explain") {
    args.target = {
      type: "positional",
      description: "<Kind>.<Name>, e.g. Document.ServiceAccrual",
      required: true,
    }
    args.dir = {
      type: "positional",
      description: "Metadata directory (default: ./metadata)",
      required: false,
    }
  } else if (takesJsonInput(tool)) {
    args.json = {
      type: "positional",
      description: "Tool input as JSON, or - to read it from stdin",
      required: false,
    }
    args.dir = {
      type: "positional",
      description: "Metadata directory (default: ./metadata)",
      required: false,
    }
    args.input = {
      type: "string",
      description: "Tool input as JSON (instead of the positional form)",
    }
  } else {
    args.dir = {
      type: "positional",
      description: "Metadata directory (default: ./metadata)",
      required: false,
    }
  }
  if (tool.effect === "files") {
    args["dry-run"] = {
      type: "boolean",
      default: false,
      description: "Report the changes without writing them",
    }
  }
  if (tool.destructive) {
    args.yes = {
      type: "boolean",
      default: false,
      description: "Confirm a destructive change",
    }
  }
  args.locale = {
    type: "enum",
    options: ["en", "uk"],
    default: "en",
    description: "Diagnostic language",
  }
  args.format = {
    type: "enum",
    options: ["text", "json"],
    default: "text",
    description: "Output format",
  }
  return args
}

/** Підкоманда з запису каталогу: опис, прапорці й дозволи беруться з нього. */
export function toolCommand(tool: Tool): CommandDef<ArgsDef> {
  return defineCommand({
    meta: { name: tool.name, description: tool.description },
    args: argsFor(tool),
    async run({ args }) {
      // citty віддає в `args._` усі позиційні, а не лише названі.
      const result = await runTool(tool, args as unknown as CliArgs)
      process.stdout.write(result.stdout)
      process.stderr.write(result.stderr)
      process.exitCode = result.exitCode
    },
  })
}

export function catalogSubCommands(): Record<string, CommandDef<ArgsDef>> {
  return Object.fromEntries(TOOLS.map((t) => [t.name, toolCommand(t)]))
}
