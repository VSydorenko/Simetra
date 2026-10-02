import { defineCommand } from "citty"
import {
  compile,
  explainObject,
  type Explanation,
  type Locale,
} from "simetra/compiler"
import { METADATA_KINDS, type MetadataKind } from "simetra/model"
import { readMetadataDir } from "../io/metadata-dir"
import { formatDiagnostics } from "../io/report"
import type { RunResult } from "./compile"

export interface ExplainOptions {
  /** `<Kind>.<Name>`. */
  target: string
  dir: string
  format: "text" | "json"
  locale?: Locale
}

function renderText(e: Explanation): string {
  const lines = [`${e.object.kind} ${e.object.name} (${e.object.file})`]
  if (e.object.scopeKind !== undefined) {
    lines.push(`scope: ${e.object.scopeKind}`)
  }
  for (const t of e.tables) {
    lines.push("", `table ${t.schema}.${t.name}${t.part ? ` [${t.part}]` : ""}`)
    for (const c of t.columns) {
      const tags = [
        c.notNull ? "not null" : undefined,
        c.logical === undefined ? undefined : `logical: ${c.logical}`,
        c.standard === undefined ? undefined : `standard: ${c.standard}`,
        c.scope === true ? "scope" : undefined,
      ].filter((x) => x !== undefined)
      lines.push(
        `  ${c.name} ${c.type}${tags.length > 0 ? ` (${tags.join(", ")})` : ""}`
      )
    }
    if (t.primaryKey !== undefined) {
      lines.push(`  primary key (${t.primaryKey.join(", ")})`)
    }
    for (const u of t.uniques) lines.push(`  unique (${u.join(", ")})`)
    for (const f of t.foreignKeys) {
      lines.push(`  foreign key (${f.columns.join(", ")}) -> ${f.references}`)
    }
  }
  for (const q of e.movementQueries) {
    lines.push("", `movement query ${q.identity}`, q.sql)
  }
  if (e.contracts.length > 0) {
    lines.push("", "contracts:", JSON.stringify(e.contracts, null, 2))
  }
  if (e.referencedBy.length > 0) {
    lines.push("", "referenced by:")
    for (const r of e.referencedBy) {
      lines.push(`  ${r.file}#${r.pointer} (${r.role})`)
    }
  }
  return `${lines.join("\n")}\n`
}

/** Не викликає `process.exit`; логіки пояснення тут немає — лише диск і друк. */
export async function runExplain(o: ExplainOptions): Promise<RunResult> {
  const usageError = (message: string): RunResult => ({
    exitCode: 2,
    stdout: "",
    stderr: `error: ${message}\n`,
  })
  if (o.format !== "text" && o.format !== "json") {
    return usageError(`Invalid --format "${o.format}". Expected text or json.`)
  }
  const dot = o.target.indexOf(".")
  const kind = dot > 0 ? o.target.slice(0, dot) : ""
  const name = dot > 0 ? o.target.slice(dot + 1) : ""
  if (name === "" || !(METADATA_KINDS as readonly string[]).includes(kind)) {
    return usageError(
      `Invalid target "${o.target}". Expected <Kind>.<Name>, e.g. Document.ServiceAccrual.`
    )
  }
  const dir = o.dir.replace(/(?<=.)[\\/]+$/, "")
  try {
    const result = await compile(await readMetadataDir(dir))
    if (result.model === undefined) {
      // Пояснення потребує чистої компіляції (рішення плану 2).
      const report = formatDiagnostics(result.diagnostics, {
        dir,
        locale: o.locale ?? "en",
        format: o.format,
      })
      return { exitCode: 1, stdout: `${report}\n`, stderr: "" }
    }
    const explanation = explainObject(result.model, {
      kind: kind as MetadataKind,
      name,
    })
    if (explanation === undefined) {
      return usageError(`Object not found: ${o.target}`)
    }
    const stdout =
      o.format === "json"
        ? `${JSON.stringify(explanation, null, 2)}\n`
        : renderText(explanation)
    return { exitCode: 0, stdout, stderr: "" }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return usageError(reason)
  }
}

export default defineCommand({
  meta: {
    name: "explain",
    description:
      "Show the compiled picture of one object: tables, queries, contracts, references",
  },
  args: {
    target: {
      type: "positional",
      description: "<Kind>.<Name>, e.g. Document.ServiceAccrual",
      required: true,
    },
    dir: {
      type: "positional",
      description: "Metadata directory (default: ./metadata)",
      required: false,
    },
    format: {
      type: "enum",
      options: ["text", "json"],
      default: "text",
      description: "Output format",
    },
  },
  async run({ args }) {
    const result = await runExplain({
      target: args.target,
      dir: args.dir ?? "./metadata",
      format: args.format,
    })
    process.stdout.write(result.stdout)
    process.stderr.write(result.stderr)
    process.exitCode = result.exitCode
  },
})
