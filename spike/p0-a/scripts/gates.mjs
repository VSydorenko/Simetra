// Portions copied from simplyCMS (https://github.com/simplyCMS/simplyCMS, scripts/pilot-pack/gate-a.mjs, gate-b.mjs, gate-c.mjs)
// Copyright (c) 2026 simplyCMS
// Licensed under MIT. Modified: route-id set fixed per stub variant, gate B reads stub data without a database,
// gate C payload list for this host, plus a one-physical-copy check over bundle stats.
//
// Гейти A, B, C і «одна копія» на зібраному host-і.
//   node gates.mjs <host-dir>   → gates.json поруч із host-ом

import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { startHost } from "./serve.mjs"

const EXPECTED_IDS = {
  ours: ["__root__", "/", "/heavy", "/tx", "/after"],
  synth: ["__root__", "/", "/heavy"],
}
const EXPECTED_SOURCE = { ours: "simetra/model", synth: "synthetic-registry" }

/** Ключі `interface FileRoutesById` генерату. */
function routeIds(source) {
  const block = /interface FileRoutesById \{([\s\S]*?)\n\}/.exec(source)
  if (!block) throw new Error("gate A: FileRoutesById is missing")
  return new Set(
    [...block[1].matchAll(/^\s*'?([^':\s]+)'?:/gm)].map((m) => m[1])
  )
}

function gateA(dir, variant) {
  const source = readFileSync(join(dir, "src/routeTree.gen.ts"), "utf8")
  const ids = routeIds(source)
  const expected = new Set(EXPECTED_IDS[variant])
  const missing = [...expected].filter((id) => !ids.has(id))
  const extra = [...ids].filter((id) => !expected.has(id))
  const imports = [...source.matchAll(/^import .* from '(.+)'$/gm)].map(
    (m) => m[1]
  )
  // Tarball — шлях через `node_modules`; лінкування — шлях робочої копії.
  const fromPackage = imports.filter((p) =>
    /node_modules\/.*p0a-stub|spike\/p0-a\/stub\//.test(p)
  )
  const viaPnpmStore = fromPackage.filter((p) => p.includes("/.pnpm/"))
  return {
    ok: !missing.length && !extra.length && fromPackage.length > 0,
    details: {
      ids: [...ids],
      missing,
      extra,
      fromPackage: fromPackage.length,
      viaPnpmStore: viaPnpmStore.length,
    },
  }
}

async function gateB(dir, preset, variant, port) {
  const host = await startHost(dir, preset, port)
  try {
    const home = await fetch(`http://127.0.0.1:${port}/`)
    const html = await home.text()
    const data = /data-stub="p0a"><pre>([^<]*)/.exec(html)?.[1] ?? ""
    const heavy = await fetch(`http://127.0.0.1:${port}/heavy`)
    const heavyHtml = await heavy.text()
    const hasSource = data.includes(EXPECTED_SOURCE[variant])
    // Клієнт react-query з провайдера host-а й рядок колекції TanStack DB
    // пакета: друга копія бібліотеки дала б помилку рендеру чи порожній список.
    const libs = /data-libs="p0a">(.*?)<\/p>/
      .exec(html)?.[1]
      ?.replaceAll("<!-- -->", "")
    return {
      ok:
        home.status === 200 &&
        hasSource &&
        libs === "true:1" &&
        heavy.status === 200 &&
        heavyHtml.includes("heavy-route-marker"),
      details: {
        home: home.status,
        data: data.replaceAll("&quot;", '"').slice(0, 300),
        libs,
        heavy: heavy.status,
        error: home.status === 200 ? undefined : html.slice(0, 600),
        logs: host.logs().slice(-1500),
      },
    }
  } finally {
    host.stop()
  }
}

// Серверний вантаж, якому не місце в клієнті. Модулі `dist/server/*` заглушки
// в клієнті є законно: це RPC-заглушки серверних функцій.
const SERVER_PAYLOAD = [
  /\/node_modules\/(\.pnpm\/[^/]+\/node_modules\/)?(pg|pg-pool|pg-protocol|drizzle-orm|@vercel\/functions)\//,
  /\/simetra\/dist\/server\//,
  /db\.server\.ts$/,
]
const SERVER_FN_STUB =
  /(p0a-stub|p0-a\/stub)\/(dist\/server\/(ours|synth)\.js|src\/server\/(ours|synth)\.ts)/

/** Замикання за статичними імпортами від entry-чанків. */
function initialChunks(stats) {
  const queue = Object.keys(stats).filter((f) => stats[f].isEntry)
  const seen = new Set(queue)
  while (queue.length) {
    for (const next of stats[queue.pop()].imports) {
      if (stats[next] && !seen.has(next)) {
        seen.add(next)
        queue.push(next)
      }
    }
  }
  return [...seen]
}

function gateC(dir) {
  const stats = JSON.parse(
    readFileSync(join(dir, "bundle-stats.client.json"), "utf8")
  )
  const all = Object.values(stats).flatMap((c) => c.modules)
  const leaked = [
    ...new Set(all.filter((id) => SERVER_PAYLOAD.some((rx) => rx.test(id)))),
  ]
  const stubs = all.filter((id) => SERVER_FN_STUB.test(id)).length
  const simetraModel = all.filter((id) =>
    /\/simetra\/dist\/model\//.test(id)
  ).length
  const initial = initialChunks(stats)
  const initialModules = initial.flatMap((f) => stats[f].modules)
  // Визначення маршруту в initial — законно; компонент має бути окремим
  // чанком (`?tsr-split=component`), інакше #4984 повернувся.
  const HEAVY =
    /(p0a-stub|p0-a\/stub)\/routes\/[^/]+\/heavy\.tsx\?tsr-split=component/
  const heavyInBundle = all.filter((id) => HEAVY.test(id)).length
  const heavyInInitial = initialModules.filter((id) => HEAVY.test(id)).length
  return {
    ok:
      leaked.length === 0 &&
      stubs > 0 &&
      heavyInBundle > 0 &&
      heavyInInitial === 0,
    details: {
      chunks: Object.keys(stats).length,
      initialChunks: initial.length,
      leaked,
      serverFnStubs: stubs,
      simetraModelInClient: simetraModel,
      heavyInBundle,
      heavyInInitial,
    },
  }
}

// Окрім react і @tanstack/* — пакети з глобальним станом у графі host-а:
// друга копія `simetra` чи `zod` дала б два реєстри видів і дві схеми.
const WATCHED = /^(react|react-dom|@tanstack\/[^/]+|simetra|zod|drizzle-orm)$/

/** Фізичний корінь пакета з module id: шлях до останнього `node_modules/<name>`. */
export function packageRoots(ids) {
  const roots = new Map()
  for (const raw of ids) {
    const id = raw.replace(/^\0/, "").split("?")[0]
    // Злінкована робоча копія `simetra` — не під `node_modules`.
    const linked = /^(.*\/packages\/simetra)\//.exec(id)
    if (linked && !id.includes("/node_modules/")) {
      if (!roots.has("simetra")) roots.set("simetra", new Set())
      roots.get("simetra").add(linked[1])
      continue
    }
    const at = id.lastIndexOf("/node_modules/")
    if (at < 0) continue
    const rest = id.slice(at + "/node_modules/".length).split("/")
    const name = rest[0].startsWith("@") ? `${rest[0]}/${rest[1]}` : rest[0]
    if (!WATCHED.test(name)) continue
    const root = id.slice(0, at + "/node_modules/".length) + name
    if (!roots.has(name)) roots.set(name, new Set())
    roots.get(name).add(root)
  }
  return roots
}

// Серверний граф — об'єднання `ssr` і `nitro`: проміжна SSR-збірка лишає
// `node_modules` зовнішніми, а модулі поза ними (злінкована робоча копія)
// вбудовує; Nitro потім збирає зовнішні. Дубль видно лише в об'єднанні.
const GRAPHS = { client: ["client"], server: ["ssr", "nitro"] }

function singleCopy(dir) {
  const result = {}
  let ok = true
  for (const [env, files] of Object.entries(GRAPHS)) {
    const ids = []
    for (const file of files) {
      try {
        const stats = JSON.parse(
          readFileSync(join(dir, `bundle-stats.${file}.json`), "utf8")
        )
        ids.push(...Object.values(stats).flatMap((c) => c.modules))
      } catch {
        // середовища немає в цій збірці
      }
    }
    const roots = packageRoots(ids)
    const dup = Object.fromEntries(
      [...roots].filter(([, s]) => s.size > 1).map(([n, s]) => [n, [...s]])
    )
    if (Object.keys(dup).length) ok = false
    result[env] = { packages: [...roots.keys()].sort(), duplicated: dup }
  }
  const required = ["react", "@tanstack/react-start"]
  const seen = new Set(Object.values(result).flatMap((r) => r.packages))
  // `@tanstack/react-start` у графі — під субшляхами; без нього гейт вхолосту.
  const missing = required.filter((n) => !seen.has(n))
  return {
    ok: ok && missing.length === 0,
    details: { ...result, missingRequired: missing },
  }
}

if (import.meta.filename === process.argv[1]) {
  const dir = process.argv[2]
  const meta = JSON.parse(readFileSync(join(dir, "pipeline.json"), "utf8"))
  const port = 4400 + Math.floor(Math.random() * 500)
  const out = { ...meta, buildOk: meta.buildExit === 0 }
  if (out.buildOk) {
    out.gateA = gateA(dir, meta.variant)
    out.gateB = await gateB(dir, meta.preset, meta.variant, port)
    out.gateC = gateC(dir)
    out.singleCopy = singleCopy(dir)
  }
  writeFileSync(join(dir, "gates.json"), JSON.stringify(out, null, 2))
  const verdict = (g) => (g ? (g.ok ? "green" : "RED") : "-")
  console.log(
    `${meta.name}: build=${out.buildOk ? "green" : "RED"} A=${verdict(out.gateA)} B=${verdict(out.gateB)} C=${verdict(out.gateC)} copy=${verdict(out.singleCopy)}`
  )
}
