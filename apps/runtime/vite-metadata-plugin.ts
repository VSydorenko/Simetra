import fs from 'node:fs'
import path from 'node:path'
import type { Plugin } from 'vite'

/**
 * Vite plugin що проєктує каталог metadata як static assets.
 * Автоматично генерує index.json зі списком усіх .json файлів.
 */
export function metadataPlugin(metadataDir: string): Plugin {
  const resolvedDir = path.resolve(metadataDir)

  function collectJsonFiles(dir: string, prefix = ''): string[] {
    if (!fs.existsSync(dir)) return []
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    const result: string[] = []

    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        result.push(...collectJsonFiles(path.join(dir, entry.name), relativePath))
      } else if (entry.name.endsWith('.json')) {
        result.push(relativePath)
      }
    }

    return result
  }

  return {
    name: 'simetra-metadata',
    configureServer(server) {
      server.middlewares.use('/metadata', (req, res, next) => {
        const urlPath = req.url?.split('?')[0] ?? '/'

        // index.json — динамічно згенерований список файлів
        if (urlPath === '/index.json') {
          const files = collectJsonFiles(resolvedDir)
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(files))
          return
        }

        // Окремі metadata файли
        const filePath = path.join(resolvedDir, urlPath)

        // Запобігти path traversal
        if (!filePath.startsWith(resolvedDir)) {
          res.statusCode = 403
          res.end('Forbidden')
          return
        }

        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
          res.setHeader('Content-Type', 'application/json')
          res.end(fs.readFileSync(filePath, 'utf-8'))
          return
        }

        next()
      })
    },
  }
}
