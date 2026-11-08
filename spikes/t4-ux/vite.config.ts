import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  server: { port: 4317 },
  plugins: [tanstackStart(), viteReact()],
  resolve: {
    // Profiler onRender у production-збірці потребує профілювальної збірки react-dom.
    alias: process.env.T4_PROFILING ? { 'react-dom/client': 'react-dom/profiling' } : {},
  },
})
