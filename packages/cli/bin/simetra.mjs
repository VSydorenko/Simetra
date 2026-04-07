#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { existsSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const entry = resolve(__dirname, '../src/index.ts')
const tsxBin = resolve(__dirname, '../node_modules/.bin/tsx')

if (!existsSync(tsxBin)) {
  console.error('tsx not found. Run "pnpm install" in the CLI package first.')
  process.exit(1)
}

const child = spawn(tsxBin, [entry, ...process.argv.slice(2)], {
  stdio: 'inherit',
})
child.on('error', (err) => {
  console.error(`Failed to start CLI: ${err.message}`)
  process.exit(1)
})
child.on('close', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
  } else {
    process.exit(code ?? 1)
  }
})
