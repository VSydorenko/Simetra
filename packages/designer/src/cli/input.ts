import { METADATA_KINDS } from "simetra/model"
import { DEFAULT_DIR, trimSlash } from "../io/default-dir"
import { UsageError } from "../io/usage-error"
import type { Tool } from "../tools/catalog"

/** Аргументи командного рядка після citty: `_` — усі позиційні. */
export interface CliArgs {
  _: string[]
  input?: string
  out?: string
  format?: string
  locale?: string
  "dry-run"?: boolean
  yes?: boolean
  all?: boolean
  staged?: boolean
  schemas?: string
  tables?: string
  "project-name"?: string
  "attribute-case"?: string
  "database-provider"?: string
  "database-url-env"?: string
  "shadow-url-env"?: string
}

/**
 * Читальні інструменти й `fix` мають зручні позиційні форми — це лише вигляд
 * над тим самим входом каталогу. Усі інші беруть вхід каталогу як JSON.
 */
const ERGONOMIC = new Set<string>([
  "compile",
  "explain",
  "fix",
  "introspect",
  "diff",
])

/** `a,b` → `["a", "b"]`; порожні елементи — помилка написання, не фільтр. */
function list(flag: string, value: string): string[] {
  const items = value.split(",").map((s) => s.trim())
  if (items.some((s) => s === "")) {
    throw new UsageError(
      `--${flag} expects a comma-separated list, got "${value}".`
    )
  }
  return items
}

export function takesJsonInput(tool: Tool): boolean {
  return !ERGONOMIC.has(tool.name)
}

/**
 * Переводить argv у вхід каталогу й список тек. Тут лише форма введення:
 * перевірку входу робить схема каталогу в `invoke`.
 */
export async function cliInput(
  tool: Tool,
  args: Pick<
    CliArgs,
    | "_"
    | "input"
    | "schemas"
    | "tables"
    | "project-name"
    | "attribute-case"
    | "database-provider"
  >,
  stdin: () => Promise<string>
): Promise<{ input: unknown; dirs: string[] }> {
  const positional = args._
  if (tool.name === "compile") {
    const dirs = positional.length > 0 ? positional : [DEFAULT_DIR]
    return { input: {}, dirs: dirs.map(trimSlash) }
  }
  if (tool.name === "explain") {
    const target = positional[0] ?? ""
    const dot = target.indexOf(".")
    if (dot <= 0 || dot === target.length - 1) {
      throw new UsageError(
        `Invalid target "${target}". Expected <Kind>.<Name>, e.g. Document.ServiceAccrual (kinds: ${METADATA_KINDS.join(", ")}).`
      )
    }
    return {
      input: { kind: target.slice(0, dot), name: target.slice(dot + 1) },
      dirs: [trimSlash(positional[1] ?? DEFAULT_DIR)],
    }
  }
  if (tool.name === "fix") {
    return { input: {}, dirs: [trimSlash(positional[0] ?? DEFAULT_DIR)] }
  }
  if (tool.name === "introspect") {
    const name = args["project-name"]
    const attributeCase = args["attribute-case"]
    const provider = args["database-provider"]
    const project = {
      ...(name === undefined ? {} : { name }),
      ...(attributeCase === undefined ? {} : { attributeCase }),
      ...(provider === undefined ? {} : { database: { provider } }),
    }
    return {
      input: {
        ...(args.schemas === undefined
          ? {}
          : { schemas: list("schemas", args.schemas) }),
        ...(Object.keys(project).length === 0 ? {} : { project }),
      },
      dirs: [trimSlash(positional[0] ?? DEFAULT_DIR)],
    }
  }
  if (tool.name === "diff") {
    return {
      input:
        args.tables === undefined
          ? {}
          : { tables: list("tables", args.tables) },
      dirs: [trimSlash(positional[0] ?? DEFAULT_DIR)],
    }
  }
  const fromFlag = args.input !== undefined
  const raw = fromFlag ? args.input : positional[0]
  if (raw === undefined) {
    throw new UsageError(
      `${tool.name} needs its input as JSON: <json|-> [dir] or --input <json> [dir].`
    )
  }
  const text = raw === "-" ? await stdin() : raw
  let input: unknown
  try {
    input = JSON.parse(text)
  } catch (error) {
    throw new UsageError(
      `Input is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  const rest = fromFlag ? positional : positional.slice(1)
  return { input, dirs: [trimSlash(rest[0] ?? DEFAULT_DIR)] }
}
