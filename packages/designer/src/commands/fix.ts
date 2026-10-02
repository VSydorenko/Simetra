import { defineCommand } from "citty"
import { fixFiles, type Locale } from "simetra/compiler"
import { readMetadataDir, writeChanges } from "../io/metadata-dir"
import { formatDiagnostics } from "../io/report"
import { schemaPathResolver } from "../io/schema-path"
import type { RunResult } from "./compile"

export interface FixOptions {
  dir: string
  dryRun: boolean
  format: "text" | "json"
  locale?: Locale
}

/**
 * Не викликає `process.exit`; логіки доповнення тут немає — лише диск і друк.
 * Пише лише результат, що компілюється без помилок, і лише без `--dry-run`.
 */
export async function runFix(o: FixOptions): Promise<RunResult> {
  const usageError = (message: string): RunResult => ({
    exitCode: 2,
    stdout: "",
    stderr: `error: ${message}\n`,
  })
  if (o.locale !== undefined && o.locale !== "en" && o.locale !== "uk") {
    return usageError(`Invalid --locale "${o.locale}". Expected en or uk.`)
  }
  if (o.format !== "text" && o.format !== "json") {
    return usageError(`Invalid --format "${o.format}". Expected text or json.`)
  }
  // Кінцевий слеш дав би в тексті `dir//file`.
  const dir = o.dir.replace(/(?<=.)[\\/]+$/, "")
  try {
    const result = await fixFiles(await readMetadataDir(dir), {
      schemaPath: schemaPathResolver(dir),
      newId: () => crypto.randomUUID(),
    })
    const write = result.ok && !o.dryRun
    if (write) await writeChanges(dir, result.changes)

    const changed = result.changes.map((c) => c.path)
    const report = formatDiagnostics(result.diagnostics, {
      dir,
      locale: o.locale ?? "en",
      format: o.format,
    })
    const stdout =
      o.format === "json"
        ? `${JSON.stringify(
            {
              ok: result.ok,
              written: write,
              changed,
              diagnostics: JSON.parse(report) as unknown,
            },
            null,
            2
          )}\n`
        : `${[
            ...changed.map(
              (path) => `${write ? "fixed" : "would fix"} ${dir}/${path}`
            ),
            ...(result.ok ? [] : ["nothing written: the result has errors"]),
            report,
          ].join("\n")}\n`
    return { exitCode: result.ok ? 0 : 1, stdout, stderr: "" }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return usageError(reason)
  }
}

export default defineCommand({
  meta: {
    name: "fix",
    description:
      "Assign missing ids and physical names, set $schema and canonical form",
  },
  args: {
    dir: {
      type: "positional",
      description: "Metadata directory (default: ./metadata)",
      required: false,
    },
    "dry-run": {
      type: "boolean",
      default: false,
      description: "Report the changes without writing them",
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
    const result = await runFix({
      dir: args.dir ?? "./metadata",
      dryRun: args["dry-run"],
      locale: args.locale,
      format: args.format,
    })
    process.stdout.write(result.stdout)
    process.stderr.write(result.stderr)
    process.exitCode = result.exitCode
  },
})
