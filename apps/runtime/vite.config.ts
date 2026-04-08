import path from 'path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { metadataPlugin } from './vite-metadata-plugin'

// Каталог metadata: за замовчуванням temp/metadata у корені монорепо
const metadataDir = process.env.SIMETRA_METADATA_PATH
  || path.resolve(__dirname, '../../temp/metadata')

export default defineConfig({
  plugins: [react(), tailwindcss(), metadataPlugin(metadataDir)],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5174,
  },
})
