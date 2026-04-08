import path from 'path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'
import { metadataPlugin } from './vite-metadata-plugin'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, '')
  const metadataDir = env.SIMETRA_METADATA_PATH

  return {
    plugins: [react(), tailwindcss(), metadataPlugin(metadataDir)],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    server: {
      port: 5174,
    },
  }
})
