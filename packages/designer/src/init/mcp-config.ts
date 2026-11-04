import { readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import { parseArgs } from "citty"
import { parse } from "smol-toml"
import { mcpArgs } from "../commands/mcp-args"
import { DEFAULT_DIR } from "../io/default-dir"
import { posixRelative } from "../io/package-path"
import { UsageError } from "../io/usage-error"
import { errorCode, probe } from "./fs-probe"
import { DESIGNER_PACKAGE, packageSubpath } from "./own-path"
import type { InitPlan, InitRefusal, InitRefusalReason } from "./types"

export const AGENTS = ["claude", "codex", "cursor", "vscode"] as const
export type Agent = (typeof AGENTS)[number]

// `.mcp.json` — портативний мінімум; конфіги інших клієнтів без запиту були б
// сміттям у репо споживача (спека designer §4.2)
export const DEFAULT_AGENTS: readonly Agent[] = ["claude"]

export const MCP_SERVER_NAME = "simetra"

// Проєктний `mcp.json` Cursor не має `cwd` і не документує робочої теки
// сервера, тож шляхи абсолютизуються інтерполяцією в `args` (спека designer §4.2)
const WORKSPACE = "${workspaceFolder}"
// Та сама тека, яку `simetra mcp` бере без позиційного аргументу
const CURSOR_METADATA_DIR = `${WORKSPACE}/${DEFAULT_DIR.replace(/^\.\//, "")}`

type Launch = { command: string; args: string[] }
type Entry = Record<string, unknown>
type Verdict = "match" | "own-differs" | "foreign"
/** Звідки резолвити `args[0]` запису: корінь проєкту і його ОС. */
type Context = { root: string; platform: NodeJS.Platform }

interface Client {
  file: string
  format: "json" | "toml"
  /** Контейнер серверів у JSON; для TOML — таблиця `mcp_servers`. */
  container: string
  entry(launch: Launch): Entry
}

const CLIENTS: Record<Agent, Client> = {
  claude: {
    file: ".mcp.json",
    format: "json",
    container: "mcpServers",
    entry: (l) => ({ command: l.command, args: l.args }),
  },
  codex: {
    file: ".codex/config.toml",
    format: "toml",
    container: "mcp_servers",
    entry: (l) => ({ command: l.command, args: l.args }),
  },
  cursor: {
    file: ".cursor/mcp.json",
    format: "json",
    container: "mcpServers",
    entry: ({ command, args: [bin, ...rest] }) => ({
      type: "stdio",
      command,
      args: [`${WORKSPACE}/${bin}`, ...rest, CURSOR_METADATA_DIR],
    }),
  },
  vscode: {
    file: ".vscode/mcp.json",
    format: "json",
    container: "servers",
    entry: (l) => ({
      type: "stdio",
      command: l.command,
      args: l.args,
      cwd: WORKSPACE,
    }),
  },
}

/**
 * Команда запуску сервера: `node` + шлях до bin з маніфесту встановленого
 * пакета. `node` не залежить від ОС (`npx` на Windows вимагає обгортки) і від
 * менеджера пакетів; шлях — той самий механізм, що й у лінків скілів.
 */
export async function mcpLaunch(
  root: string,
  pkgDir: string
): Promise<{ command: "node"; args: [string, "mcp"] }> {
  const manifest = JSON.parse(
    await readFile(join(pkgDir, "package.json"), "utf8")
  ) as { bin?: unknown }
  const bin = isTable(manifest.bin) ? manifest.bin.simetra : undefined
  if (typeof bin !== "string") {
    throw new UsageError(`${DESIGNER_PACKAGE} manifest has no simetra bin`)
  }
  return {
    command: "node",
    args: [posixRelative(root, join(pkgDir, bin)), "mcp"],
  }
}

/**
 * Чи запис наш і чи він уже такий, як треба. Зайві ключі й `args[2..]`
 * (дописаний `--read-only`, тека) — воля власника, тож на збіг не впливають.
 */
export function matchesOwn(
  entry: unknown,
  expected: Entry,
  context: Context
): Verdict {
  if (!isTable(entry) || !isOwn(entry, context)) return "foreign"
  const args = entry.args as unknown[]
  const want = expected.args as string[]
  const same =
    args[0] === want[0] &&
    args[1] === "mcp" &&
    (want.length <= 2 || hasDir(args.slice(2))) &&
    requiredKeys(expected).every(([k, v]) => entry[k] === v)
  return same ? "match" : "own-differs"
}

/**
 * Запис наш, коли `node` запускає файл усередині якоїсь теки
 * `node_modules/@simetrajs/designer/` після нормалізації: старий шлях bin
 * (оновлення пакета, інший `node_modules`) теж власний, а вихід через `..` —
 * ні. Префікс Cursor `${workspaceFolder}/` — це корінь проєкту.
 */
function isOwn(entry: Entry, { root, platform }: Context): boolean {
  const first = Array.isArray(entry.args) ? entry.args[0] : undefined
  if (entry.command !== "node" || typeof first !== "string") return false
  const bin = first.startsWith(`${WORKSPACE}/`)
    ? first.slice(WORKSPACE.length + 1)
    : first
  return packageSubpath(root, bin, platform) !== undefined
}

/**
 * Чи хвіст `args` уже називає теку метаданих. Розбір — за описом самої
 * команди `mcp`: значення рядкового прапорця (`--database-url-env X`) інакше
 * сприймалося б як тека.
 */
function hasDir(rest: unknown[]): boolean {
  const strings = rest.filter((a): a is string => typeof a === "string")
  return parseArgs(strings, mcpArgs).dir !== undefined
}

function requiredKeys(expected: Entry): [string, unknown][] {
  return Object.entries(expected).filter(
    ([k]) => k !== "command" && k !== "args"
  )
}

/**
 * Виправлений власний запис: ставить `args[0..1]` і обов'язкові ключі, а
 * решту лишає — нестандартну теку й прапорці власник дописує сам.
 */
function fixEntry(entry: Entry, expected: Entry): Entry {
  const want = expected.args as string[]
  let rest = (entry.args as unknown[]).slice(2)
  if (want.length > 2 && !hasDir(rest)) {
    rest = [...want.slice(2), ...rest]
  }
  const args = [want[0], "mcp", ...rest]
  return { ...entry, ...Object.fromEntries(requiredKeys(expected)), args }
}

/**
 * План MCP-конфігів обраних агентів. Лише читає диск: будь-яка проблема стає
 * відмовою, і тоді `init` не пише нічого (спека designer §4.2).
 */
export async function planMcpConfigs(
  root: string,
  agents: readonly Agent[],
  launch: Launch,
  platform: NodeJS.Platform
): Promise<InitPlan> {
  const context = { root, platform }
  const plan: InitPlan = { actions: [], notes: [], refusals: [] }
  for (const agent of AGENTS.filter((a) => agents.includes(a))) {
    const client = CLIENTS[agent]
    const path = join(root, client.file)
    const read = await readConfig(root, client.file)
    if ("refusal" in read) {
      plan.refusals.push(read.refusal)
      continue
    }
    const expected = client.entry(launch)
    const result =
      client.format === "json"
        ? planJson(read.text, client.container, expected, context)
        : planToml(read.text ?? "", expected, context)
    if (result === "match") continue
    if (result === "foreign") {
      plan.notes.push({ kind: "foreign-mcp-entry", path })
    } else if (typeof result === "string") {
      plan.refusals.push({ path, reason: result })
    } else {
      const creates = read.text === undefined
      plan.actions.push({
        kind: "write",
        path,
        content: result.content,
        creates,
      })
    }
  }
  return plan
}

type ReadResult = { text?: string } | { refusal: InitRefusal }

// Предок-симлінк на теку — звичайна схема dotfiles, тож за ним ідемо; запис
// крізь симлінк конфігу пише у файл, на який він вказує
async function readConfig(root: string, rel: string): Promise<ReadResult> {
  const segments = rel.split("/")
  for (let i = 1; i < segments.length; i++) {
    const ancestor = join(root, ...segments.slice(0, i))
    const p = await probe(ancestor)
    if (p.kind === "missing") return {}
    if (p.kind === "dir") continue
    if (p.kind === "error") return { refusal: fsRefusal(ancestor, p.code) }
    if (p.kind === "symlink" && (await isDir(ancestor))) continue
    return { refusal: { path: ancestor, reason: "not-a-directory" } }
  }
  const path = join(root, rel)
  const p = await probe(path)
  if (p.kind === "missing") return {}
  if (p.kind === "dir") return { refusal: { path, reason: "not-a-file" } }
  if (p.kind === "error") return { refusal: fsRefusal(path, p.code) }
  try {
    return { text: await readFile(path, "utf8") }
  } catch (e) {
    const code = errorCode(e)
    if (code === "EISDIR") return { refusal: { path, reason: "not-a-file" } }
    return { refusal: fsRefusal(path, code) }
  }
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

function fsRefusal(path: string, code: string): InitRefusal {
  const reason = code === "ENOTDIR" ? "not-a-directory" : "unreadable"
  return { path, reason, code }
}

type Outcome = "match" | "foreign" | InitRefusalReason | { content: string }

// Строгий JSON без коментарів (спека designer §4.2), тож файл переписується
// цілим; порядок ключів зберігається, новий сервер — останнім
function planJson(
  text: string | undefined,
  container: string,
  expected: Entry,
  context: Context
): Outcome {
  let root: unknown = {}
  if (text !== undefined) {
    try {
      root = JSON.parse(text)
    } catch {
      return "invalid-json"
    }
  }
  if (!isTable(root)) return "not-an-object"
  const servers = root[container] === undefined ? {} : root[container]
  if (!isTable(servers)) return "servers-not-an-object"
  const current = servers[MCP_SERVER_NAME]
  let next = expected
  if (current !== undefined) {
    const verdict = matchesOwn(current, expected, context)
    if (verdict !== "own-differs") return verdict
    next = fixEntry(current as Entry, expected)
  }
  const updated = {
    ...root,
    [container]: { ...servers, [MCP_SERVER_NAME]: next },
  }
  return { content: JSON.stringify(updated, null, 2) + "\n" }
}

/**
 * Codex: розбір парсером, запис — правкою тексту. Дописування й заміна одного
 * рядка зберігають коментарі й порядок споживача; повторний розбір після
 * правки доводить, що вона однозначна.
 */
function planToml(text: string, expected: Entry, context: Context): Outcome {
  const servers = parseToml(text)
  if (servers === "invalid-toml") return servers
  if (servers !== undefined && !isTable(servers)) return "servers-not-an-object"
  const current = servers?.[MCP_SERVER_NAME]
  let content: string
  let want = expected
  if (current === undefined) {
    const eol = lineEnding(text)
    const separator = text === "" ? "" : text.endsWith(eol) ? eol : eol + eol
    content = text + separator + tomlBlock(expected, eol)
  } else {
    const verdict = matchesOwn(current, expected, context)
    if (verdict !== "own-differs") return verdict
    want = fixEntry(current as Entry, expected)
    const fixed = replaceArgsLine(text, want.args as unknown[])
    if (fixed === undefined) return "ambiguous-toml"
    content = fixed
  }
  // Правку, після якої файл не дає саме очікуваного запису, не пишемо
  const after = parseToml(content)
  const entry = isTable(after) ? after[MCP_SERVER_NAME] : undefined
  const exact =
    isTable(entry) &&
    entry.command === want.command &&
    JSON.stringify(entry.args) === JSON.stringify(want.args)
  return exact ? { content } : "ambiguous-toml"
}

function parseToml(text: string): unknown {
  try {
    return parse(text).mcp_servers
  } catch {
    return "invalid-toml"
  }
}

function tomlBlock(entry: Entry, eol: string): string {
  const args = tomlArray(entry.args as unknown[])
  const lines = [
    `[mcp_servers.${MCP_SERVER_NAME}]`,
    `command = ${tomlString(entry.command as string)}`,
    `args = ${args}`,
  ]
  return lines.join(eol) + eol
}

// Конфіг із Windows чи з `core.autocrlf` має CRLF: дописане й виправлене
// мусить мати те саме закінчення рядків, що й решта файлу
function lineEnding(text: string): "\r\n" | "\n" {
  return text.includes("\r\n") ? "\r\n" : "\n"
}

// Рядок JSON — коректний базовий рядок TOML, крім сирого DEL, який TOML
// вимагає екранувати
function tomlString(s: string): string {
  return JSON.stringify(s).replaceAll("\x7f", "\\u007f")
}

function tomlArray(items: unknown[]): string | undefined {
  if (!items.every((i) => typeof i === "string")) return undefined
  return `[${items.map(tomlString).join(", ")}]`
}

const HEADER = new RegExp(
  `^\\s*\\[\\s*(?:mcp_servers|"mcp_servers"|'mcp_servers')\\s*\\.\\s*(?:${MCP_SERVER_NAME}|"${MCP_SERVER_NAME}"|'${MCP_SERVER_NAME}')\\s*\\]\\s*(?:#.*)?$`
)
const ANY_HEADER = /^\s*\[/
const ARGS_KEY = /^\s*args\s*=/
const ARGS_LINE = /^(\s*args\s*=\s*)(\[.*)$/
const TRAILER = /^\s*(?:#.*)?$/

/**
 * Межа масиву в рядку `args`: `]` може стояти і в елементі (`"a]#x"`), і в
 * коментарі (`# see [docs]`), тож жоден регулярний вираз її не знайде. Кінець
 * — перша `]`, після якої лише коментар і до якої текст розбирається як масив
 * рядків.
 */
function splitArray(rest: string): [string, string] | undefined {
  for (let i = rest.indexOf("]"); i !== -1; i = rest.indexOf("]", i + 1)) {
    const candidate = rest.slice(0, i + 1)
    const tail = rest.slice(i + 1)
    if (TRAILER.test(tail) && isStringArray(candidate)) return [candidate, tail]
  }
  return undefined
}

function isStringArray(array: string): boolean {
  try {
    const { args } = parse(`args = ${array}`)
    return Array.isArray(args) && args.every((a) => typeof a === "string")
  } catch {
    return false
  }
}

/**
 * Замінює масив у єдиному однорядковому `args` єдиної таблиці
 * `[mcp_servers.simetra]`. Будь-яка інша форма — неоднозначна: правити її
 * текстом означало б вгадувати.
 */
function replaceArgsLine(text: string, args: unknown[]): string | undefined {
  const array = tomlArray(args)
  // `\r` у кінці рядка не дав би збігтися ні заголовку з коментарем, ні
  // рядку `args`
  const eol = lineEnding(text)
  const lines = text.split(eol)
  const headers = lines.flatMap((l, i) => (HEADER.test(l) ? [i] : []))
  if (array === undefined || headers.length !== 1) return undefined
  const start = headers[0] + 1
  let end = lines.findIndex((l, i) => i >= start && ANY_HEADER.test(l))
  if (end === -1) end = lines.length
  const argLines = []
  for (let i = start; i < end; i++)
    if (ARGS_KEY.test(lines[i])) argLines.push(i)
  const at = argLines.length === 1 ? argLines[0] : undefined
  const match = at === undefined ? null : ARGS_LINE.exec(lines[at])
  const split = match ? splitArray(match[2]) : undefined
  if (at === undefined || !match || !split) return undefined
  lines[at] = `${match[1]}${array}${split[1]}`
  return lines.join(eol)
}

function isTable(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}
