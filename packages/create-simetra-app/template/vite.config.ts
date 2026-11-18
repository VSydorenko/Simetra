import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import viteReact from "@vitejs/plugin-react"
import { fileURLToPath } from "node:url"
import { nitro } from "nitro/vite"
import { defineConfig } from "vite"

// Обхід TanStack Start #8139 — нижня межа Rolldown в `pnpm-workspace.yaml`;
// `dedupe` — для пакета під `link:` (звіт П0 (а)): стан на рівні модуля мусить
// мати один фізичний екземпляр.
export default defineConfig({
  resolve: {
    dedupe: [
      "react",
      "react-dom",
      "@tanstack/react-router",
      "@tanstack/react-start",
      "zod",
    ],
  },
  plugins: [
    tanstackStart(),
    nitro({
      preset: "node-server",
      // Перевірка оточення на старті сервера (src/server/startup-plugin.ts)
      plugins: [
        fileURLToPath(
          new URL("./src/server/startup-plugin.ts", import.meta.url)
        ),
      ],
      // `useRequest()` в `defer` (runtime.ts) працює лише з асинхронним контекстом
      experimental: { asyncContext: true },
    }),
    viteReact(),
  ],
})
