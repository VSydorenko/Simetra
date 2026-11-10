import {
  appendFile,
  cp,
  readdir,
  readFile,
  readlink,
  writeFile,
} from "node:fs/promises"
import { dirname, join, resolve, sep } from "node:path"
import { Client } from "@modelcontextprotocol/client"
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio"
import { publint } from "publint"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  exec,
  installConsumer,
  REPO,
  listPackedFiles,
  packageRoots,
  packWorkspace,
  readPackedManifest,
  removeTemps,
  repackWithVersion,
} from "./support"

// Гейт пакування: потребує свіжого `pnpm build:packages` (корінь репо).
let tarballs: { simetra: string; designer: string }

beforeAll(async () => {
  tarballs = await packWorkspace()
})

afterAll(removeTemps)

const SKILL_DIRS = [".agents/skills", ".claude/skills"]
const AGENTS = "claude,codex,cursor,vscode"
const CONFIGS = [
  ".mcp.json",
  ".codex/config.toml",
  ".cursor/mcp.json",
  ".vscode/mcp.json",
]

/** Ціль лінку скіла, яку `init` мусить записати (спека designer §4.2). */
const skillTarget = (name: string) =>
  `../../node_modules/@simetrajs/designer/skills/${name}`

async function packedSkills(tarball: string): Promise<string[]> {
  return (await listPackedFiles(tarball))
    .map((f) => /^skills\/([^/]+)\/SKILL\.md$/.exec(f)?.[1])
    .filter((n): n is string => n !== undefined)
    .sort()
}

/**
 * Запускає MCP-сервер так, як його запустить агент: `command`/`args` із
 * `.mcp.json`, робоча тека — корінь проєкту.
 */
async function configuredServerTools(consumer: string): Promise<string[]> {
  const config = JSON.parse(
    await readFile(join(consumer, ".mcp.json"), "utf8")
  ) as { mcpServers: { simetra: { command: string; args: string[] } } }
  const { command, args } = config.mcpServers.simetra
  const client = new Client({ name: "packaging-gate", version: "0" })
  await client.connect(
    new StdioClientTransport({ command, args, cwd: consumer })
  )
  try {
    const { tools } = await client.listTools()
    return tools.map((t) => t.name)
  } finally {
    await client.close()
  }
}

/** publint над tarball: повідомлення рівня warning і вище. */
async function publintMessages(tarball: string): Promise<string[]> {
  const buffer = await readFile(tarball)
  const { messages } = await publint({
    pack: {
      tarball: buffer.buffer.slice(
        buffer.byteOffset,
        buffer.byteOffset + buffer.byteLength
      ),
    },
    level: "warning",
  })
  return messages.map((m) => `${m.code} ${m.path.join(".")}`)
}

describe("simetra", () => {
  let consumer: string

  beforeAll(async () => {
    consumer = await installConsumer([tarballs.simetra])
  })

  it("exposes only the built tiers", async () => {
    const manifest = await readPackedManifest(tarballs.simetra)
    expect(Object.keys(manifest.exports as object).sort()).toEqual([
      "./compiler",
      "./data",
      "./model",
      "./schema",
      "./schemas/*",
      "./server",
    ])
    expect(manifest.private).toBeUndefined()
    expect(JSON.stringify(manifest)).not.toContain("workspace:")
  })

  it("ships dist, schemas and the licence, not sources or tests", async () => {
    const files = await listPackedFiles(tarballs.simetra)
    for (const f of [
      "dist/model/index.js",
      "dist/model/index.d.ts",
      "dist/compiler/index.js",
      "dist/data/index.js",
      "dist/data/index.d.ts",
      "dist/schema/index.js",
      "dist/server/index.js",
      "dist/server/index.d.ts",
      "schemas/catalogs.schema.json",
      "LICENSE",
      "README.md",
    ])
      expect(files).toContain(f)
    expect(
      files.filter((f) => f.startsWith("src/") || f.includes("__tests__"))
    ).toEqual([])
  })

  it("each tier is self-contained in dist", async () => {
    // Спільний чанк між ярусами = друга копія модуля в рантаймі споживача
    // (реєстр видів, схеми Zod), бо ярус імпортує інший ярус через `simetra/<ярус>`
    const js = (await listPackedFiles(tarballs.simetra)).filter((f) =>
      f.endsWith(".js")
    )
    expect(
      js.filter((f) => !/^dist\/(model|compiler|data|schema|server)\//.test(f))
    ).toEqual([])
  })

  it("declares react as the only, optional peer", async () => {
    const m = await readPackedManifest(tarballs.simetra)
    expect(m.peerDependencies).toEqual({ react: "^19.3.1" })
    // Серверний споживач peer не ставить
    expect(
      Object.values(
        m.peerDependenciesMeta as Record<string, { optional?: boolean }>
      ).map((v) => v.optional)
    ).toEqual([true])
    expect(Object.keys(m.peerDependenciesMeta as object).sort()).toEqual(
      Object.keys(m.peerDependencies as object).sort()
    )
  })

  it("imports every server-side tier and simetra/data in plain Node without the peer", async () => {
    const { stdout } = await exec(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'await import("simetra/server"); await import("simetra/data")',
      ],
      { cwd: consumer }
    )
    expect(stdout).toBe("")
    await expect(
      readFile(join(consumer, "node_modules/react/package.json"))
    ).rejects.toThrow()
  })

  it("imports every tier in plain Node", async () => {
    const script = [
      'const model = await import("simetra/model")',
      'const compiler = await import("simetra/compiler")',
      'const schema = await import("simetra/schema")',
      'const server = await import("simetra/server")',
      "console.log([model, compiler, schema, server].map((m) => Object.keys(m).length > 0).join())",
    ].join("\n")
    const { stdout } = await exec(
      process.execPath,
      ["--input-type=module", "-e", script],
      { cwd: consumer }
    )
    expect(stdout.trim()).toBe("true,true,true,true")
  })

  it("passes publint", async () => {
    expect(await publintMessages(tarballs.simetra)).toEqual([])
  })

  it("passes arethetypeswrong (esm-only)", async () => {
    // attw завершується ненульовим кодом на будь-якій проблемі резолву типів
    await expect(
      exec(join(import.meta.dirname, "../../node_modules/.bin/attw"), [
        tarballs.simetra,
        "--profile",
        "esm-only",
        "--format",
        "ascii",
      ])
    ).resolves.toBeDefined()
  })
})

/** Вміст файлів tarball-а під `dir` із заданим закінченням імені. */
async function packedSources(
  tarball: string,
  dir: string,
  suffix: string
): Promise<Map<string, string>> {
  const files = (await listPackedFiles(tarball)).filter(
    (f) => f.startsWith(dir) && f.endsWith(suffix)
  )
  const sources = new Map<string, string>()
  for (const f of files) {
    // Бандл ярусу з WASM-парсером більший за типові 1 МБ буфера
    const { stdout } = await exec("tar", ["-xOzf", tarball, `package/${f}`], {
      maxBuffer: 128 * 1024 * 1024,
    })
    sources.set(f, stdout)
  }
  return sources
}

/** Голі специфікатори статичних і динамічних імпортів модуля ES. */
function bareSpecifiers(source: string): string[] {
  const found = [
    ...source.matchAll(/\bfrom\s*["']([^"']+)["']/g),
    ...source.matchAll(/\bimport\s*\(?\s*["']([^"']+)["']/g),
  ].map((m) => m[1])
  return [...new Set(found.filter((s) => !s.startsWith(".")))].sort()
}

// Пара «поточні» звіту П0 (а) і Vite з нижньою межею збирача шаблону host-а
const HOST_STACK = {
  "@tanstack/react-router": "1.170.46",
  "@tanstack/react-start": "1.169.4",
  "react-dom": "19.3.1",
  vite: "8.3.6",
}

// Бібліотеки зі станом на рівні модуля, які імпортують і host, і пакет
// (правило списку звіту П0 (а), спека П4-B §3): друга копія кожної з них —
// другий кеш, реєстр чи контекст React у тому самому бандлі
const SINGLE_COPY = ["react", "react-dom", "zod", "simetra"]

const MODULE_IDS = "module-ids.json"

/**
 * Клієнтський вхід host-а. Кожна бібліотека списку єдиності вжита
 * по-справжньому, інакше tree-shaking прибрав би її модулі й гейт пройшов би
 * вхолосту.
 */
const HOST_FILES = {
  "index.html":
    '<!doctype html><div id="root"></div><script type="module" src="/src/main.js"></script>\n',
  // Плагін лише пише id модулів кожного чанка; розбирає їх тест, тож правило
  // коренів одне й живе в репо
  "vite.config.mjs": `import { writeFileSync } from "node:fs"
export default {
  logLevel: "warn",
  build: {
    rolldownOptions: {
      plugins: [
        {
          name: "module-ids",
          generateBundle(_options, bundle) {
            const ids = Object.values(bundle).flatMap((c) =>
              c.type === "chunk" ? c.moduleIds : []
            )
            writeFileSync(${JSON.stringify(MODULE_IDS)}, JSON.stringify(ids))
          },
        },
      ],
    },
  },
}
`,
  "src/main.js": `import { createElement } from "react"
import { createRoot } from "react-dom/client"
import { createDataRuntime } from "simetra/data"
import { z } from "zod"

const runtime = createDataRuntime({
  catalog: { format: 1, snapshotHash: "gate", provider: "supabase", objects: [] },
  transport: async () => ({ ok: true, value: null }),
  subject: "gate",
})
const shape = z.object({ subject: z.string() })

function App() {
  return createElement("pre", null, shape.parse(runtime).subject)
}

createRoot(document.getElementById("root")).render(createElement(App))
`,
}

describe("simetra/data", () => {
  it("public declarations do not reference @tanstack", async () => {
    // Типи `simetra/data` — контракт пакета: ні бібліотек, ні внутрішніх
    // типів ядра. Межа слова: публічне `onSessionChanged` дозволене.
    const dts = await packedSources(tarballs.simetra, "dist/data/", ".d.ts")
    expect([...dts.keys()]).toContain("dist/data/index.d.ts")
    expect(
      [...dts].filter(([, s]) => s.includes("@tanstack/")).map(([f]) => f)
    ).toEqual([])
    expect(
      [...dts]
        .filter(([, s]) =>
          /\b(CoreSession|Session|Scope|ObjectStore|SectionStore)\b/.test(s)
        )
        .map(([f]) => f)
    ).toEqual([])
  })

  it("imports peers by bare specifiers instead of bundling them", async () => {
    // Вбудована копія peer-а — друга копія в бандлі споживача, якої граф
    // модулів не покаже: вона лежить у корені `simetra`
    const m = await readPackedManifest(tarballs.simetra)
    const allowed = new Set([
      ...Object.keys(m.peerDependencies as object),
      "simetra/model",
    ])
    const specifiers = [
      ...(await packedSources(tarballs.simetra, "dist/data/", ".js")).values(),
    ].flatMap(bareSpecifiers)
    // Без цього перелік міг би бути порожнім і перевірка нічого б не казала
    expect(specifiers).toContain("simetra/model")
    expect(specifiers.filter((s) => !allowed.has(s))).toEqual([])
  })
})

// Better Auth і kysely — тестова залежність `simetra` (рішення Р2): жоден
// тарбол не оголошує їх і жоден файл `dist` не імпортує
describe("test-only auth dependencies", () => {
  const BANNED = /^(?:better-auth|kysely)(?:\/|$)/

  it.each(["simetra", "designer"] as const)(
    "the %s tarball declares neither better-auth nor kysely",
    async (name) => {
      const m = await readPackedManifest(tarballs[name])
      for (const field of [
        "dependencies",
        "peerDependencies",
        "optionalDependencies",
      ])
        expect(
          Object.keys((m[field] as object | undefined) ?? {}).filter((d) =>
            BANNED.test(d)
          ),
          field
        ).toEqual([])
    }
  )

  it.each(["simetra", "designer"] as const)(
    "no file of dist in the %s tarball imports them",
    async (name) => {
      const sources = [
        ...(await packedSources(tarballs[name], "dist/", ".js")).values(),
        ...(await packedSources(tarballs[name], "dist/", ".d.ts")).values(),
      ]
      // Без файлів перевірка нічого б не казала
      expect(sources.length).toBeGreaterThan(0)
      expect(
        sources.flatMap(bareSpecifiers).filter((s) => BANNED.test(s))
      ).toEqual([])
    }
  )
})

describe("simetra/data in a pnpm host", () => {
  let consumer: string

  beforeAll(async () => {
    const m = await readPackedManifest(tarballs.simetra)
    const dev = m.devDependencies as Record<string, string>
    // Peer-и — точними версіями, проти яких пакет іде у своїх тестах
    const peers = Object.fromEntries(
      Object.keys(m.peerDependencies as object).map((p) => [p, dev[p]])
    )
    const zod = (m.dependencies as Record<string, string>).zod
    // pnpm, а не npm: пласка розкладка npm дедуплікує сама, і гейт там
    // пройшов би вхолосту (звіт П0 (а))
    consumer = await installConsumer([tarballs.simetra], "pnpm", {
      dependencies: { ...peers, ...HOST_STACK, zod },
      files: HOST_FILES,
    })
  })

  it("imports simetra/data in plain Node", async () => {
    const { stdout } = await exec(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'const d = await import("simetra/data"); console.log(typeof d.createDataRuntime)',
      ],
      { cwd: consumer }
    )
    expect(stdout.trim()).toBe("function")
  })

  it("bundles one copy of each module-state library", async () => {
    await exec(join(consumer, "node_modules/.bin/vite"), ["build"], {
      cwd: consumer,
    })
    const ids = JSON.parse(
      await readFile(join(consumer, MODULE_IDS), "utf8")
    ) as string[]
    // Рівно один корінь: 0 — бібліотеку прибрав tree-shaking (гейт вхолосту),
    // 2+ — дві копії стану
    expect(
      Object.entries(packageRoots(ids, SINGLE_COPY)).filter(
        ([, roots]) => roots.length !== 1
      ),
      "packages whose bundle roots are not exactly one"
    ).toEqual([])
  })
})

describe("@simetrajs/designer", () => {
  let consumer: string
  let bin: string
  const run = (args: string[]) => exec(bin, args, { cwd: consumer })

  beforeAll(async () => {
    consumer = await installConsumer([tarballs.simetra, tarballs.designer])
    // Симлінк, який створив npm, а не `node dist/main.js`: так його запускає споживач
    bin = join(consumer, "node_modules/.bin/simetra")
    await cp(
      join(REPO, "examples/reference/metadata"),
      join(consumer, "metadata"),
      { recursive: true }
    )
  })

  it("pins simetra to its own version and has no dev launcher deps", async () => {
    const m = await readPackedManifest(tarballs.designer)
    const s = await readPackedManifest(tarballs.simetra)
    expect(m.version).toBe(s.version) // lockstep, Р1
    expect((m.dependencies as Record<string, string>).simetra).toBe(s.version)
    expect(m.dependencies).not.toHaveProperty("tsx")
    expect(m.bin).toEqual({ simetra: "./dist/main.js" })
  })

  it("ships dist and both consumer skills, not the dev launcher", async () => {
    const files = await listPackedFiles(tarballs.designer)
    for (const f of [
      "dist/main.js",
      "skills/simetra-metadata/SKILL.md",
      "skills/simetra-adoption/SKILL.md",
      "LICENSE",
      "README.md",
    ])
      expect(files).toContain(f)
    expect(files.filter((f) => /^(bin|src)\//.test(f))).toEqual([])
  })

  it("--version prints the package version", async () => {
    const { version } = await readPackedManifest(tarballs.designer)
    const { stdout } = await run(["--version"])
    expect(stdout.trim()).toBe(version)
  })

  it("compiles the reference metadata", async () => {
    const { stdout } = await run(["compile", "metadata"])
    expect(stdout).toContain("0 error(s)")
  })

  it("fix writes $schema that resolves inside node_modules/simetra", async () => {
    const file = join(consumer, "metadata/catalogs/Currency/Currency.meta.json")
    const json = JSON.parse(await readFile(file, "utf8")) as Record<
      string,
      unknown
    >
    delete json.$schema
    await writeFile(file, JSON.stringify(json, null, 2))
    await run(["fix", "metadata"])
    const { $schema } = JSON.parse(await readFile(file, "utf8"))
    const target = resolve(dirname(file), $schema)
    expect(
      target.startsWith(join(consumer, "node_modules/simetra/schemas") + sep)
    ).toBe(true)
    await expect(readFile(target, "utf8")).resolves.toContain('"$schema"')
  })

  it("serves tools over MCP", async () => {
    const client = new Client({ name: "packaging-gate", version: "0" })
    await client.connect(
      new StdioClientTransport({
        command: bin,
        args: ["mcp", "metadata", "--read-only"],
        cwd: consumer,
      })
    )
    try {
      const { tools } = await client.listTools()
      expect(tools.map((t) => t.name)).toContain("compile")
    } finally {
      await client.close()
    }
  })

  it("passes publint", async () => {
    expect(await publintMessages(tarballs.designer)).toEqual([])
  })

  // Тести `init` нижче йдуть по черзі над тим самим проєктом споживача
  it("init links the skills and writes MCP configs", async () => {
    await run(["init", "--agents", AGENTS])
    const skills = await packedSkills(tarballs.designer)
    expect(skills.length).toBeGreaterThan(0)
    for (const dir of SKILL_DIRS)
      for (const name of skills) {
        const link = join(consumer, dir, name)
        expect(await readlink(link)).toBe(skillTarget(name))
        await expect(
          readFile(join(link, "SKILL.md"), "utf8")
        ).resolves.toContain(`name: ${name}`)
      }
    for (const file of CONFIGS)
      await expect(readFile(join(consumer, file), "utf8")).resolves.toBeTruthy()
  })

  it("init --check is green and a second init changes nothing", async () => {
    await run(["init", "--check", "--agents", AGENTS])
    const read = () =>
      Promise.all(CONFIGS.map((f) => readFile(join(consumer, f))))
    const before = await read()
    await run(["init", "--agents", AGENTS])
    expect(await read()).toEqual(before)
  })

  it("the configured MCP server starts", async () => {
    expect(await configuredServerTools(consumer)).toContain("compile")
  })

  it("a package update flows through the links", async () => {
    const { version } = await readPackedManifest(tarballs.designer)
    const marker = "<!-- packaging-gate update marker -->"
    const updated = await repackWithVersion(
      tarballs.designer,
      `${version}-update.0`,
      (dir) =>
        appendFile(
          join(dir, "skills/simetra-metadata/SKILL.md"),
          `\n${marker}\n`
        )
    )
    await exec("npm", ["install", "--no-audit", "--no-fund", updated], {
      cwd: consumer,
    })
    for (const dir of SKILL_DIRS) {
      const link = join(consumer, dir, "simetra-metadata")
      expect(await readlink(link)).toBe(skillTarget("simetra-metadata"))
      await expect(readFile(join(link, "SKILL.md"), "utf8")).resolves.toContain(
        marker
      )
    }
    await run(["init", "--check", "--agents", AGENTS])
  })
})

describe("@simetrajs/designer under pnpm", () => {
  let consumer: string

  beforeAll(async () => {
    consumer = await installConsumer(
      [tarballs.simetra, tarballs.designer],
      "pnpm"
    )
    await cp(
      join(REPO, "examples/reference/metadata"),
      join(consumer, "metadata"),
      { recursive: true }
    )
  })

  it("resolves simetra to the packed tarball, not the registry", async () => {
    // Без override designer з tarball-а біг би проти опублікованого simetra
    const entries = await readdir(join(consumer, "node_modules/.pnpm"))
    expect(entries.some((e) => e.startsWith("simetra@file+"))).toBe(true)
    expect(entries.filter((e) => /^simetra@\d/.test(e))).toEqual([])
  })

  it("init links through node_modules, not the .pnpm store", async () => {
    await exec(join(consumer, "node_modules/.bin/simetra"), ["init"], {
      cwd: consumer,
    })
    const link = join(consumer, ".claude/skills/simetra-metadata")
    expect(await readlink(link)).toBe(skillTarget("simetra-metadata"))
    await expect(readFile(join(link, "SKILL.md"), "utf8")).resolves.toContain(
      "name: simetra-metadata"
    )
  })

  it("the configured MCP server starts", async () => {
    expect(await configuredServerTools(consumer)).toContain("compile")
  })
})
