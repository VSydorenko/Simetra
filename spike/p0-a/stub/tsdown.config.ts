import { defineConfig } from "tsdown"

// Форма пакета — як у `packages/simetra`: entry на субшлях, peer-залежності
// не вбудовуються (інакше host отримав би другу копію react і @tanstack/*).
export default defineConfig({
  entry: {
    "server/ours": "src/server/ours.ts",
    "server/synth": "src/server/synth.ts",
    // Окремий модуль реєстру, як у репорті #8139: імпорт, а не вбудовування.
    "server/registry": "src/server/registry.ts",
    "client/index": "src/client/index.tsx",
  },
  format: "esm",
  platform: "neutral",
  target: "esnext",
  fixedExtension: false,
  dts: true,
  outDir: "dist",
  deps: {
    neverBundle: [
      /^simetra(\/|$)/,
      /^@tanstack\//,
      /^react(\/|$)/,
      /^drizzle-orm(\/|$)/,
      /^zod(\/|$)/,
    ],
  },
})
