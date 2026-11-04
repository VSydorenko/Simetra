import { resolve } from "node:path"
import { defineCommand, type ArgsDef } from "citty"
import type { RunResult } from "../cli/command"
import { posixRelative } from "../io/package-path"
import { UsageError } from "../io/usage-error"
import { AGENTS, type Agent, DEFAULT_AGENTS } from "../init/mcp-config"
import { applyInit, InitApplyError, planInit } from "../init/plan"
import type { InitAction, InitNote, InitPlan } from "../init/types"

export const initArgs = {
  agents: {
    type: "string",
    description: `Comma-separated agents to write MCP configs for: ${AGENTS.join(", ")} (default: ${DEFAULT_AGENTS.join(",")})`,
  },
  "dry-run": {
    type: "boolean",
    description: "Print the changes without writing them",
  },
  check: {
    type: "boolean",
    description:
      "Exit with code 1 if init would change anything; write nothing",
  },
} satisfies ArgsDef

// citty додає camelCase-аліас кожному прапорцю з дефісом, а неоголошені
// прапорці пропускає мовчки — `--agent codex` дав би `{ agent: true }`, і
// `--check` у CI був би зеленим без перевірки Codex
const KNOWN_KEYS = new Set(["_", "agents", "dry-run", "dryRun", "check"])

// Рядки, яких вимагає спека після `init` (спека designer §4.2, §4.4); у
// виводі `--check` вони — шум для CI
const TRAILER = [
  "The MCP server lets agents write the metadata directory; add --read-only to its args to refuse the tools that write.",
  "To check metadata before each commit, add this line to .husky/pre-commit: npx simetra compile --all --staged",
]

type Mode = "init" | "dry-run" | "check"

export default defineCommand({
  meta: {
    name: "init",
    description:
      "Link the package skills and write the MCP server configs of agents into the project",
  },
  args: initArgs,
  async run({ args }) {
    const result = await runInit(args, process.cwd())
    process.stdout.write(result.stdout)
    process.stderr.write(result.stderr)
    process.exitCode = result.exitCode
  },
})

/**
 * Не викликає `process.exit`: тести проганяють команду в процесі. Аргументи
 * перевіряються до пошуку пакета, щоб помилка використання називала саме
 * поганий аргумент, а не відсутній пакет.
 */
export async function runInit(
  args: Record<string, unknown>,
  cwd: string,
  platform: NodeJS.Platform = process.platform
): Promise<RunResult> {
  const root = resolve(cwd)
  const rel = (path: string) => posixRelative(root, path)
  try {
    const { agents, mode } = parseInitArgs(args)
    const plan = await planInit(root, agents, platform)
    if (plan.refusals.length > 0) return refused(plan, rel)
    const lines = plan.actions.map(renderAction(rel))
    const notes = plan.notes.map(renderNote(rel))
    if (mode === "check") {
      const drift = lines.length > 0
      const tail = drift
        ? "The project is out of date; run simetra init to fix it."
        : "The project is up to date."
      return ok(drift ? 1 : 0, [...lines, ...notes, tail])
    }
    if (mode === "init") await applyInit(plan, platform)
    const summary = lines.length === 0 ? ["Nothing to change."] : lines
    return ok(0, [...summary, ...notes, ...TRAILER])
  } catch (e) {
    if (e instanceof InitApplyError) return fail(`${rel(e.path)}: ${e.code}`)
    if (e instanceof UsageError) return fail(e.message)
    throw e
  }
}

function parseInitArgs(args: Record<string, unknown>): {
  agents: readonly Agent[]
  mode: Mode
} {
  for (const key of Object.keys(args)) {
    if (!KNOWN_KEYS.has(key)) throw new UsageError(`unknown option --${key}`)
  }
  const positional = Array.isArray(args._) ? args._ : []
  if (positional.length > 0) {
    throw new UsageError(
      `unexpected argument "${String(positional[0])}": init takes no positional arguments`
    )
  }
  const check = args.check === true
  const dryRun = args["dry-run"] === true
  if (check && dryRun) {
    throw new UsageError("--check and --dry-run cannot be combined")
  }
  return {
    agents: args.agents === undefined ? DEFAULT_AGENTS : agentList(args.agents),
    mode: check ? "check" : dryRun ? "dry-run" : "init",
  }
}

function agentList(value: unknown): Agent[] {
  const expected = `expected a comma-separated list of ${AGENTS.join(", ")}`
  const items = typeof value === "string" ? value.split(",") : [""]
  const agents: Agent[] = []
  for (const raw of items.map((i) => i.trim())) {
    if (raw === "")
      throw new UsageError(`--agents has an empty item; ${expected}`)
    if (!isAgent(raw)) {
      throw new UsageError(`unknown agent "${raw}" in --agents; ${expected}`)
    }
    agents.push(raw)
  }
  return agents
}

const isAgent = (v: string): v is Agent =>
  (AGENTS as readonly string[]).includes(v)

const renderAction =
  (rel: (p: string) => string) =>
  (a: InitAction): string => {
    switch (a.kind) {
      case "link":
        return `${a.replaces ? "relink" : "link"} ${rel(a.path)} -> ${a.target}`
      case "unlink":
        return `remove ${rel(a.path)}`
      case "write":
        return `write ${rel(a.path)}`
    }
  }

const NOTES: Record<InitNote["kind"], string> = {
  "foreign-skill": "not a link to the package skill; left as is",
  "aliased-skill-dir":
    "links to the other skills directory; skills are linked there",
  "foreign-mcp-entry":
    'the "simetra" server entry does not run this package; left as is',
}

const renderNote =
  (rel: (p: string) => string) =>
  (n: InitNote): string =>
    `note: ${rel(n.path)}: ${NOTES[n.kind]}`

function refused(plan: InitPlan, rel: (p: string) => string): RunResult {
  const lines = plan.refusals.map(
    (r) =>
      `error: ${rel(r.path)}: ${r.reason}${r.code === undefined ? "" : ` (${r.code})`}`
  )
  return {
    exitCode: 2,
    stdout: "",
    stderr: [...lines, "Nothing changed."].join("\n") + "\n",
  }
}

const ok = (exitCode: 0 | 1, lines: string[]): RunResult => ({
  exitCode,
  stdout: lines.join("\n") + "\n",
  stderr: "",
})

const fail = (message: string): RunResult => ({
  exitCode: 2,
  stdout: "",
  stderr: `error: ${message}\n`,
})
