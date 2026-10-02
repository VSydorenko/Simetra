import { defineCommand } from "citty"
import {
  canonicalSnapshot,
  compile,
  emitEntityTypes,
  type Diagnostic,
  type FileChange,
  type Locale,
} from "simetra/compiler"
import { renderDesiredState } from "simetra/schema"
import { readMetadataDir, writeChanges } from "../io/metadata-dir"
import { formatDiagnostics } from "../io/report"

export interface CompileOptions {
  dirs: string[]
  out?: string
  locale: Locale
  format: "text" | "json"
}

export interface RunResult {
  exitCode: 0 | 1 | 2
  stdout: string
  stderr: string
}

/**
 * Не викликає `process.exit`: код виходу ставить `main.ts`, тож тести
 * проганяють команду в процесі. Логіки стадій тут немає — лише диск і друк.
 */
export async function runCompile(o: CompileOptions): Promise<RunResult> {
  const usageError = (message: string): RunResult => ({
    exitCode: 2,
    stdout: "",
    stderr: `error: ${message}\n`,
  })
  if (o.locale !== "en" && o.locale !== "uk") {
    return usageError(`Invalid --locale "${o.locale}". Expected en or uk.`)
  }
  if (o.format !== "text" && o.format !== "json") {
    return usageError(`Invalid --format "${o.format}". Expected text or json.`)
  }
  // Усі теки метаданих названі однаково (`metadata`), тож спільного `--out`
  // для кількох не вигадати без колізій.
  if (o.out !== undefined && o.dirs.length > 1) {
    return usageError("--out accepts exactly one metadata directory.")
  }
  const blocks: string[] = []
  const allJson: unknown[] = []
  let hasErrors = false

  // Кінцевий слеш дав би в тексті `dir//file`.
  for (const dir of o.dirs.map((d) => d.replace(/(?<=.)[\\/]+$/, ""))) {
    try {
      const files = await readMetadataDir(dir)
      const result = await compile(files)
      const diagnostics: Diagnostic[] = result.diagnostics
      hasErrors ||= diagnostics.some((d) => d.severity === "error")

      const report = formatDiagnostics(diagnostics, { ...o, dir })
      if (o.format === "json") allJson.push(...JSON.parse(report))
      else blocks.push(report)

      // Артефакти — лише з `--out` і лише з моделі без помилок.
      if (o.out !== undefined && result.model !== undefined) {
        const { model } = result
        const changes: FileChange[] = [
          {
            path: "snapshot.json",
            content: `${JSON.stringify(canonicalSnapshot(model), null, 2)}\n`,
          },
          { path: "desired-state.sql", content: renderDesiredState(model).sql },
          { path: "entities.d.ts", content: emitEntityTypes(model) },
        ]
        await writeChanges(o.out, changes)
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return { exitCode: 2, stdout: "", stderr: `error: ${reason}\n` }
    }
  }

  const stdout =
    o.format === "json"
      ? `${JSON.stringify(allJson, null, 2)}\n`
      : `${blocks.join("\n")}\n`
  return { exitCode: hasErrors ? 1 : 0, stdout, stderr: "" }
}

export default defineCommand({
  meta: {
    name: "compile",
    description:
      "Compile metadata directories and report diagnostics (default: ./metadata)",
  },
  args: {
    dirs: {
      type: "positional",
      description: "Metadata directories",
      required: false,
    },
    out: {
      type: "string",
      description: "Write snapshot.json, desired-state.sql, entities.d.ts here",
    },
    locale: {
      type: "enum",
      options: ["en", "uk"],
      default: "en",
      description: "Diagnostic language",
    },
    format: {
      type: "enum",
      options: ["text", "json"],
      default: "text",
      description: "Output format",
    },
  },
  async run({ args }) {
    // citty віддає в `args.dirs` лише перший позиційний; усі — у `args._`.
    const dirs = args._.length > 0 ? args._ : ["./metadata"]
    const result = await runCompile({
      dirs,
      out: args.out,
      locale: args.locale,
      format: args.format,
    })
    process.stdout.write(result.stdout)
    process.stderr.write(result.stderr)
    process.exitCode = result.exitCode
  },
})
