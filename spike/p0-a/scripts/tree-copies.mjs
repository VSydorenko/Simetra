// Portions copied from simplyCMS (https://github.com/simplyCMS/simplyCMS, tests/tanstack-db-single-instance.test.ts)
// Copyright (c) 2026 simplyCMS
// Licensed under MIT. Modified: a script, not a test; watches react, react-dom, every @tanstack/* and zod.
//
// Фізичні екземпляри пакетів у дереві host-а за `pnpm ls --json` (`path`
// несе peer-суфікс теки, тож ловить і два снапшоти однієї версії).
//   node tree-copies.mjs <host-dir>

import { execFileSync } from "node:child_process"

const WATCHED = /^(react|react-dom|@tanstack\/[^/]+|zod)$/

export function treeCopies(dir) {
  const out = execFileSync("pnpm", ["ls", "--depth", "Infinity", "--json"], {
    cwd: dir,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
  const paths = new Map()
  const walk = (node) => {
    if (!node || typeof node !== "object") return
    for (const [name, dep] of Object.entries(node)) {
      if (WATCHED.test(name) && dep?.path) {
        if (!paths.has(name)) paths.set(name, new Set())
        paths.get(name).add(dep.path)
      }
      if (dep && typeof dep === "object") walk(dep.dependencies)
    }
  }
  for (const project of JSON.parse(out))
    for (const key of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
    ])
      walk(project[key])
  return Object.fromEntries([...paths].map(([name, set]) => [name, [...set]]))
}

if (import.meta.filename === process.argv[1]) {
  const copies = treeCopies(process.argv[2])
  const dup = Object.fromEntries(
    Object.entries(copies).filter(([, p]) => p.length > 1)
  )
  console.log(
    JSON.stringify(
      { packages: Object.keys(copies).length, duplicated: dup },
      null,
      1
    )
  )
}
