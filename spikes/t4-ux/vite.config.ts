import { fileURLToPath } from 'node:url'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  server: { port: 4317 },
  plugins: [tanstackStart(), viteReact()],
  resolve: {
    alias: {
      // Ядро спайку 1 імпортує T0 як `simetra/model` — беремо джерела пакета.
      'simetra/model': fileURLToPath(new URL('../../packages/simetra/src/model/index.ts', import.meta.url)),
      // Profiler onRender у production-збірці потребує профілювальної збірки react-dom.
      ...(process.env.T4_PROFILING ? { 'react-dom/client': 'react-dom/profiling' } : {}),
    },
  },
})
