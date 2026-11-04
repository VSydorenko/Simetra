// Portions copied from simplyCMS (https://github.com/simplyCMS/simplyCMS, tests/pilot/store-template/vite.config.ts)
// Copyright (c) 2026 simplyCMS
// Licensed under MIT. Modified: plugin renamed, writes stats of every environment, config reads spike env.
import { writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import viteReact from "@vitejs/plugin-react"
import { nitro } from "nitro/vite"
import { defineConfig, type Plugin } from "vite"

// Граф модулів кожного середовища збірки — джерело гейтів C і «одна копія».
function emitBundleStats(): Plugin {
  return {
    name: "p0a-bundle-stats",
    generateBundle(_options, bundle) {
      const stats: Record<string, unknown> = {}
      for (const [fileName, chunk] of Object.entries(bundle)) {
        if (chunk.type !== "chunk") continue
        stats[fileName] = {
          modules: Object.keys(chunk.modules ?? {}),
          imports: chunk.imports ?? [],
          dynamicImports: chunk.dynamicImports ?? [],
          isEntry: chunk.isEntry,
          name: chunk.name,
        }
      }
      const env = this.environment?.name ?? "unknown"
      writeFileSync(
        resolve(import.meta.dirname, `bundle-stats.${env}.json`),
        JSON.stringify(stats, null, 2)
      )
    },
  }
}

const preset = process.env.SPIKE_PRESET ?? "node-server"
// Крок 6: список `dedupe` задає прогін; порожньо — без `dedupe`.
const dedupe = process.env.SPIKE_DEDUPE?.split(",").filter(Boolean)

// Крок 6: Vite-alias субшляхів заглушки на сирий TS робочої копії.
const aliasSrc = process.env.SPIKE_ALIAS_SRC
const alias = aliasSrc
  ? {
      "@simetra-spike/p0a-stub/server/ours": resolve(
        aliasSrc,
        "server/ours.ts"
      ),
      "@simetra-spike/p0a-stub/server/synth": resolve(
        aliasSrc,
        "server/synth.ts"
      ),
      "@simetra-spike/p0a-stub/client": resolve(aliasSrc, "client/index.tsx"),
    }
  : undefined

export default defineConfig({
  plugins: [
    tanstackStart({ router: { virtualRouteConfig: "./routes.ts" } }),
    nitro({ preset }),
    viteReact(),
    emitBundleStats(),
  ],
  resolve: {
    ...(dedupe?.length ? { dedupe } : {}),
    ...(alias ? { alias } : {}),
  },
})
