import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { parse } from "smol-toml"
import { afterEach, describe, expect, it, vi } from "vitest"
import { DEFAULT_DIR } from "../io/default-dir"
import { installedPackageDir } from "../io/package-path"
import {
  AGENTS,
  type Agent,
  matchesOwn,
  mcpLaunch,
  planMcpConfigs,
} from "../init/mcp-config"
import { DESIGNER_PACKAGE } from "../init/own-path"
import type { InitAction, InitPlan } from "../init/types"
import { projectTree, put } from "./helpers/init-project"

const PKG = `node_modules/${DESIGNER_PACKAGE}`
const BIN = `${PKG}/dist/main.js`
const OLD_BIN = `${PKG}/old/main.js`
const WS = "${workspaceFolder}"
const LAUNCH = { command: "node", args: [BIN, "mcp"] }
const CURSOR_DIR = `${WS}/${DEFAULT_DIR.replace(/^\.\//, "")}`
const CONTEXT = { root: "/p", platform: "linux" } as const
// Шлях містить сегмент пакета, але після нормалізації веде за його межі
const ESCAPED_BIN = `./${PKG}/../other/bin.js`

const FILES: Record<Agent, string> = {
  claude: ".mcp.json",
  codex: ".codex/config.toml",
  cursor: ".cursor/mcp.json",
  vscode: ".vscode/mcp.json",
}

/** Очікуваний запис кожного JSON-клієнта — незалежна від коду копія таблиці. */
const EXPECTED = {
  claude: {
    container: "mcpServers",
    entry: { command: "node", args: [BIN, "mcp"] },
  },
  cursor: {
    container: "mcpServers",
    entry: {
      type: "stdio",
      command: "node",
      args: [`${WS}/${BIN}`, "mcp", CURSOR_DIR],
    },
  },
  vscode: {
    container: "servers",
    entry: { type: "stdio", command: "node", args: [BIN, "mcp"], cwd: WS },
  },
} as const

const temps: string[] = []
afterEach(async () => {
  await Promise.all(temps.splice(0).map((t) => rm(t, { recursive: true })))
})

/** Тимчасовий проєкт зі встановленим пакетом, чий маніфест має `bin.simetra`. */
async function project(
  hoisted = false
): Promise<{ root: string; pkgDir: string }> {
  const tmp = await mkdtemp(join(tmpdir(), "simetra-init-mcp-"))
  temps.push(tmp)
  const root = hoisted ? join(tmp, "app") : tmp
  await mkdir(join(tmp, PKG), { recursive: true })
  await mkdir(root, { recursive: true })
  await writeFile(
    join(tmp, PKG, "package.json"),
    JSON.stringify({ bin: { simetra: "./dist/main.js" } })
  )
  return { root, pkgDir: installedPackageDir(root, DESIGNER_PACKAGE) }
}

const json = (v: unknown) => JSON.stringify(v, null, 2)

/** План лише читає диск: дерево проєкту до й після однакове. */
async function plan(
  root: string,
  agents: readonly Agent[] = AGENTS
): Promise<InitPlan> {
  const before = await projectTree(root)
  const result = await planMcpConfigs(root, agents, LAUNCH, "linux")
  expect(await projectTree(root)).toEqual(before)
  return result
}

const EMPTY: InitPlan = { actions: [], notes: [], refusals: [] }

function onlyWrite(p: InitPlan): Extract<InitAction, { kind: "write" }> {
  expect(p.notes).toEqual([])
  expect(p.refusals).toEqual([])
  expect(p.actions).toHaveLength(1)
  const [action] = p.actions
  if (action?.kind !== "write") throw new Error("expected a write action")
  return action
}

/** Пише `content` на диск і доводить, що повторний план порожній. */
async function applyAndReplan(
  root: string,
  action: Extract<InitAction, { kind: "write" }>,
  agents: readonly Agent[]
): Promise<void> {
  await mkdir(dirname(action.path), { recursive: true })
  await writeFile(action.path, action.content)
  expect(await plan(root, agents)).toEqual(EMPTY)
}

function entryOf(content: string, agent: keyof typeof EXPECTED): unknown {
  const parsed = JSON.parse(content) as Record<string, Record<string, unknown>>
  return parsed[EXPECTED[agent].container]?.simetra
}

describe("mcpLaunch", () => {
  it("derives the launcher from the installed manifest", async () => {
    const { root, pkgDir } = await project()
    expect(await mcpLaunch(root, pkgDir)).toEqual({
      command: "node",
      args: [BIN, "mcp"],
    })
    const hoisted = await project(true)
    expect(await mcpLaunch(hoisted.root, hoisted.pkgDir)).toEqual({
      command: "node",
      args: [`../${BIN}`, "mcp"],
    })
  })
})

describe("planMcpConfigs: JSON clients", () => {
  it.each(AGENTS)("round trip is empty for %s", async (agent) => {
    const { root } = await project()
    const action = onlyWrite(await plan(root, [agent]))
    expect(action).toMatchObject({
      path: join(root, FILES[agent]),
      creates: true,
    })
    if (agent !== "codex") {
      expect(entryOf(action.content, agent)).toEqual(EXPECTED[agent].entry)
    } else {
      const parsed = JSON.parse(JSON.stringify(parse(action.content)))
      expect(parsed).toEqual({ mcp_servers: { simetra: LAUNCH } })
    }
    await applyAndReplan(root, action, [agent])
  })

  it("keeps foreign servers and keys", async () => {
    const { root } = await project()
    await put(
      root,
      ".mcp.json",
      json({ mcpServers: { other: { command: "x" } }, extra: 1 })
    )
    const { content } = onlyWrite(await plan(root, ["claude"]))
    expect(JSON.parse(content)).toEqual({
      mcpServers: { other: { command: "x" }, simetra: EXPECTED.claude.entry },
      extra: 1,
    })
  })

  it("keeps extra args and keys of an own entry", async () => {
    const { root } = await project()
    const entry = {
      command: "node",
      args: [BIN, "mcp", "--read-only"],
      env: { X: "1" },
    }
    await put(root, ".mcp.json", json({ mcpServers: { simetra: entry } }))
    expect(await plan(root, ["claude"])).toEqual(EMPTY)
  })

  it("restores required keys of an own entry", async () => {
    const { root } = await project()
    await put(
      root,
      ".vscode/mcp.json",
      json({
        servers: {
          simetra: {
            type: "stdio",
            command: "node",
            args: [BIN, "mcp", "--read-only"],
            env: { X: "1" },
          },
        },
      })
    )
    const vscode = onlyWrite(await plan(root, ["vscode"]))
    expect(entryOf(vscode.content, "vscode")).toEqual({
      type: "stdio",
      command: "node",
      args: [BIN, "mcp", "--read-only"],
      env: { X: "1" },
      cwd: WS,
    })
    await applyAndReplan(root, vscode, ["vscode"])

    await put(
      root,
      ".cursor/mcp.json",
      json({
        mcpServers: {
          simetra: {
            type: "stdio",
            command: "node",
            args: [`${WS}/${BIN}`, "mcp", "--read-only"],
          },
        },
      })
    )
    const cursor = onlyWrite(await plan(root, ["cursor"]))
    expect(entryOf(cursor.content, "cursor")).toMatchObject({
      args: [`${WS}/${BIN}`, "mcp", `${WS}/metadata`, "--read-only"],
    })
    await applyAndReplan(root, cursor, ["cursor"])
  })

  it("restores mcp as the second arg", async () => {
    const { root } = await project()
    await put(
      root,
      ".mcp.json",
      json({
        mcpServers: {
          simetra: { command: "node", args: [BIN, "bogus", "--read-only"] },
        },
      })
    )
    const action = onlyWrite(await plan(root, ["claude"]))
    expect(entryOf(action.content, "claude")).toEqual({
      command: "node",
      args: [BIN, "mcp", "--read-only"],
    })
    await applyAndReplan(root, action, ["claude"])
  })

  it("cursor dir comes from DEFAULT_DIR", async () => {
    const { root } = await project()
    const action = onlyWrite(await plan(root, ["cursor"]))
    const entry = entryOf(action.content, "cursor") as { args: string[] }
    expect(entry.args[2]).toBe(CURSOR_DIR)

    const custom = {
      type: "stdio",
      command: "node",
      args: [`${WS}/${BIN}`, "mcp", `${WS}/meta/app`],
    }
    await put(
      root,
      ".cursor/mcp.json",
      json({ mcpServers: { simetra: custom } })
    )
    expect(await plan(root, ["cursor"])).toEqual(EMPTY)
  })

  // Значення константи збігається з літералом, тож доказ, що тека саме з неї,
  // — підмінена константа
  it("cursor dir follows a changed DEFAULT_DIR", async () => {
    vi.resetModules()
    vi.doMock("../io/default-dir", () => ({ DEFAULT_DIR: "./meta-x" }))
    try {
      const fresh = await import("../init/mcp-config")
      const { root } = await project()
      const p = await fresh.planMcpConfigs(root, ["cursor"], LAUNCH, "linux")
      const entry = entryOf(onlyWrite(p).content, "cursor") as {
        args: string[]
      }
      expect(entry.args[2]).toBe(`${WS}/meta-x`)
    } finally {
      vi.doUnmock("../io/default-dir")
      vi.resetModules()
    }
  })

  it.each([
    ["claude match", EXPECTED.claude.entry, EXPECTED.claude.entry, "match"],
    [
      "extra args and env",
      { command: "node", args: [BIN, "mcp", "--read-only"], env: { A: "1" } },
      EXPECTED.claude.entry,
      "match",
    ],
    [
      "other args[0]",
      { command: "node", args: [OLD_BIN, "mcp"] },
      EXPECTED.claude.entry,
      "own-differs",
    ],
    [
      "args[1] not mcp",
      { command: "node", args: [BIN, "serve"] },
      EXPECTED.claude.entry,
      "own-differs",
    ],
    [
      "vscode without type",
      { command: "node", args: [BIN, "mcp"], cwd: WS },
      EXPECTED.vscode.entry,
      "own-differs",
    ],
    [
      "cursor without dir",
      {
        type: "stdio",
        command: "node",
        args: [`${WS}/${BIN}`, "mcp", "--read-only"],
      },
      EXPECTED.cursor.entry,
      "own-differs",
    ],
    [
      "npx",
      { command: "npx", args: ["simetra", "mcp"] },
      EXPECTED.claude.entry,
      "foreign",
    ],
    [
      "outside the package",
      { command: "node", args: ["tools/x.js", "mcp"] },
      EXPECTED.claude.entry,
      "foreign",
    ],
    ["not an object", "simetra", EXPECTED.claude.entry, "foreign"],
    [
      "bin in another node_modules",
      { command: "node", args: [`/elsewhere/${BIN}`, "mcp"] },
      EXPECTED.claude.entry,
      "own-differs",
    ],
    [
      ".. escape from the package",
      { command: "node", args: [ESCAPED_BIN, "mcp"] },
      EXPECTED.claude.entry,
      "foreign",
    ],
    [
      "cursor .. escape from the package",
      {
        type: "stdio",
        command: "node",
        args: [`${WS}/${ESCAPED_BIN}`, "mcp", CURSOR_DIR],
      },
      EXPECTED.cursor.entry,
      "foreign",
    ],
  ])("matchesOwn: %s", (_name, entry, expected, verdict) => {
    expect(matchesOwn(entry, expected, CONTEXT)).toBe(verdict)
  })

  it.each(["claude", "cursor", "vscode"] as const)(
    "updates the bin path of an own entry for %s",
    async (agent) => {
      const { root } = await project()
      const { container, entry } = EXPECTED[agent]
      const oldArg = agent === "cursor" ? `${WS}/${OLD_BIN}` : OLD_BIN
      const tail =
        agent === "cursor" ? [CURSOR_DIR, "--read-only"] : ["--read-only"]
      const stale = { ...entry, args: [oldArg, "mcp", ...tail] }
      await put(root, FILES[agent], json({ [container]: { simetra: stale } }))
      const action = onlyWrite(await plan(root, [agent]))
      expect(entryOf(action.content, agent)).toEqual({
        ...entry,
        args: [entry.args[0], "mcp", ...tail],
      })
      await applyAndReplan(root, action, [agent])
    }
  )

  // Значення рядкового прапорця — не тека: хвіст розбирається описом команди
  // `mcp`, а не за відсутністю дефіса
  it("cursor tells an option value from the dir", async () => {
    const { root } = await project()
    const option = ["--database-url-env", "CUSTOM_ENV"]
    const entry = (tail: string[]) => ({
      type: "stdio",
      command: "node",
      args: [`${WS}/${BIN}`, "mcp", ...tail],
    })
    const file = (tail: string[]) =>
      json({ mcpServers: { simetra: entry(tail) } })
    await put(root, FILES.cursor, file(option))
    const action = onlyWrite(await plan(root, ["cursor"]))
    expect(entryOf(action.content, "cursor")).toEqual(
      entry([CURSOR_DIR, ...option])
    )
    await put(root, FILES.cursor, file([...option, `${WS}/meta`]))
    expect(await plan(root, ["cursor"])).toEqual(EMPTY)
  })

  it.each(["claude", "cursor"] as const)(
    "leaves an entry escaping the package alone for %s",
    async (agent) => {
      const { root } = await project()
      const { container, entry } = EXPECTED[agent]
      const bin = agent === "cursor" ? `${WS}/${ESCAPED_BIN}` : ESCAPED_BIN
      const escaped = { ...entry, args: [bin, ...entry.args.slice(1)] }
      await put(root, FILES[agent], json({ [container]: { simetra: escaped } }))
      expect(await plan(root, [agent])).toEqual({
        actions: [],
        notes: [{ kind: "foreign-mcp-entry", path: join(root, FILES[agent]) }],
        refusals: [],
      })
    }
  )

  it("leaves a foreign simetra entry alone", async () => {
    const { root } = await project()
    await put(
      root,
      ".mcp.json",
      json({
        mcpServers: { simetra: { command: "npx", args: ["simetra", "mcp"] } },
      })
    )
    expect(await plan(root, ["claude"])).toEqual({
      actions: [],
      notes: [{ kind: "foreign-mcp-entry", path: join(root, ".mcp.json") }],
      refusals: [],
    })
  })

  it("refuses JSON with comments", async () => {
    const { root } = await project()
    await put(root, ".vscode/mcp.json", '// note\n{ "servers": {} }\n')
    const p = await plan(root, ["vscode"])
    expect(p.actions).toEqual([])
    expect(p.refusals).toEqual([
      { path: join(root, ".vscode/mcp.json"), reason: "invalid-json" },
    ])
  })

  it.each([
    ["[]", "not-an-object"],
    ["null", "not-an-object"],
    ['{"mcpServers":[]}', "servers-not-an-object"],
    ['{"mcpServers":null}', "servers-not-an-object"],
  ])("refuses a non-object root or container: %s", async (content, reason) => {
    const { root } = await project()
    await put(root, ".mcp.json", content)
    const p = await plan(root, ["claude"])
    expect(p.actions).toEqual([])
    expect(p.refusals).toEqual([{ path: join(root, ".mcp.json"), reason }])
  })

  it("refuses a config path that is a directory", async () => {
    const { root } = await project()
    await mkdir(join(root, ".mcp.json"))
    await put(root, ".vscode", "not a dir")
    const p = await plan(root, ["claude", "vscode"])
    expect(p.actions).toEqual([])
    expect(p.refusals).toEqual([
      { path: join(root, ".mcp.json"), reason: "not-a-file" },
      { path: join(root, ".vscode"), reason: "not-a-directory" },
    ])
  })

  it("follows an ancestor symlink to a directory", async () => {
    const { root } = await project()
    await mkdir(join(root, "real-vscode"))
    await symlink("real-vscode", join(root, ".vscode"), "dir")
    const action = onlyWrite(await plan(root, ["vscode"]))
    expect(action).toMatchObject({
      path: join(root, ".vscode/mcp.json"),
      creates: true,
    })
  })

  it("writes only the selected agents", async () => {
    const { root } = await project()
    const p = await plan(root, ["claude"])
    expect(p.actions.map((a) => a.path)).toEqual([join(root, ".mcp.json")])
  })
})

describe("planMcpConfigs: codex TOML", () => {
  const CODEX = ".codex/config.toml"
  const BLOCK = `[mcp_servers.simetra]\ncommand = "node"\nargs = ["${BIN}", "mcp"]\n`

  it.each([
    ['model = "x"', "\n\n"],
    ['# keep me\nmodel = "x"\n', "\n"],
  ])("appends to an existing codex config: %j", async (existing, separator) => {
    const { root } = await project()
    await put(root, CODEX, existing)
    const action = onlyWrite(await plan(root, ["codex"]))
    expect(action.creates).toBe(false)
    expect(action.content).toBe(existing + separator + BLOCK)
    await applyAndReplan(root, action, ["codex"])
  })

  it("appends to a CRLF codex config with CRLF", async () => {
    const { root } = await project()
    const existing = '# keep me\r\nmodel = "x"\r\n'
    await put(root, CODEX, existing)
    const action = onlyWrite(await plan(root, ["codex"]))
    expect(action.content).toBe(
      existing + "\r\n" + BLOCK.replaceAll("\n", "\r\n")
    )
    await applyAndReplan(root, action, ["codex"])
  })

  it("serialises the bin path as a valid TOML string", async () => {
    const { root } = await project()
    const odd = {
      command: "node",
      args: ['node_modules/@simetrajs/designer/a "b"\\c\x7f.js', "mcp"],
    }
    const p = await planMcpConfigs(root, ["codex"], odd, "linux")
    const action = onlyWrite(p)
    const parsed = parse(action.content) as {
      mcp_servers: { simetra: { args: string[] } }
    }
    expect(parsed.mcp_servers.simetra.args).toEqual(odd.args)
  })

  it.each([
    [
      "quoted header",
      `[mcp_servers."simetra"]\ncommand = "node"\nargs = ["${BIN}", "mcp"]\n`,
    ],
    [
      "inline table",
      `mcp_servers = { simetra = { command = "node", args = ["${BIN}", "mcp"] } }\n`,
    ],
    [
      "dotted keys",
      `mcp_servers.simetra.command = "node"\nmcp_servers.simetra.args = ["${BIN}", "mcp"]\n`,
    ],
  ])("finds the codex entry in any form: %s", async (_name, content) => {
    const { root } = await project()
    await put(root, CODEX, content)
    expect(await plan(root, ["codex"])).toEqual(EMPTY)
    await put(root, CODEX, content.replace('"node"', '"npx"'))
    expect(await plan(root, ["codex"])).toEqual({
      actions: [],
      notes: [{ kind: "foreign-mcp-entry", path: join(root, CODEX) }],
      refusals: [],
    })
  })

  it("refuses invalid toml", async () => {
    const { root } = await project()
    await put(root, CODEX, "[mcp_servers")
    expect(await plan(root, ["codex"])).toEqual({
      actions: [],
      notes: [],
      refusals: [{ path: join(root, CODEX), reason: "invalid-toml" }],
    })
  })

  it("keeps extra args of an own codex entry", async () => {
    const { root } = await project()
    await put(
      root,
      CODEX,
      `[mcp_servers.simetra]\ncommand = "node"\nargs = ["${BIN}", "mcp", "--read-only"]\n`
    )
    expect(await plan(root, ["codex"])).toEqual(EMPTY)
  })

  it("fixes the bin of an own codex entry", async () => {
    const { root } = await project()
    const head =
      '# my servers\n[mcp_servers.other]\ncommand = "x"\n\n# simetra\n[ mcp_servers . simetra ]\ncommand = "node"\n'
    const tail = '\n[profile]\nname = "p"\n'
    const line = (bin: string) =>
      `args = ["${bin}", "mcp", "--read-only"]  # mine`
    await put(root, CODEX, head + line(OLD_BIN) + tail)
    const action = onlyWrite(await plan(root, ["codex"]))
    expect(action.content).toBe(head + line(BIN) + tail)
    await applyAndReplan(root, action, ["codex"])
  })

  // `]` стоїть і в коментарі, і в елементі: межу масиву визначає розбір, а
  // не перша чи остання дужка в рядку
  it.each([
    ["comment ending with ]", "", " # see [docs]"],
    ["element with ]#", ', "a]#x"', " # mine"],
    ["element with ] #x", ', "a] #x"', ""],
  ])("fixes the codex args line: %s", async (_name, extra, comment) => {
    const { root } = await project()
    const head = '[mcp_servers.simetra]\ncommand = "node"\nargs = '
    const line = (bin: string) => `${head}["${bin}", "mcp"${extra}]${comment}\n`
    await put(root, CODEX, line(OLD_BIN))
    const action = onlyWrite(await plan(root, ["codex"]))
    expect(action.content).toBe(line(BIN))
    await applyAndReplan(root, action, ["codex"])
  })

  it.each([
    ["without a comment", ""],
    ["with a comment", " # mine"],
  ])("fixes a CRLF codex args line %s", async (_name, comment) => {
    const { root } = await project()
    const text = (bin: string) =>
      `[mcp_servers.simetra]${comment}\r\ncommand = "node"\r\nargs = ["${bin}", "mcp"]${comment}\r\n`
    await put(root, CODEX, text(OLD_BIN))
    const action = onlyWrite(await plan(root, ["codex"]))
    expect(action.content).toBe(text(BIN))
    await applyAndReplan(root, action, ["codex"])
  })

  it("refuses to append to an inline servers table", async () => {
    const { root } = await project()
    await put(root, CODEX, 'mcp_servers = { other = { command = "x" } }\n')
    expect(await plan(root, ["codex"])).toEqual({
      actions: [],
      notes: [],
      refusals: [{ path: join(root, CODEX), reason: "ambiguous-toml" }],
    })
  })

  it.each([
    [
      "inline table",
      `mcp_servers = { simetra = { command = "node", args = ["${OLD_BIN}", "mcp"] } }\n`,
    ],
    [
      "multi-line args",
      `[mcp_servers.simetra]\ncommand = "node"\nargs = [\n  "${OLD_BIN}",\n  "mcp",\n]\n`,
    ],
  ])(
    "refuses to fix an own codex entry it cannot locate: %s",
    async (_name, content) => {
      const { root } = await project()
      await put(root, CODEX, content)
      expect(await plan(root, ["codex"])).toEqual({
        actions: [],
        notes: [],
        refusals: [{ path: join(root, CODEX), reason: "ambiguous-toml" }],
      })
    }
  )
})
