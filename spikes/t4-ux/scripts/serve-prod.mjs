// Production-сервер полігона: зібраний fetch-обробник Start + статика клієнта.
import { createServer } from "node:http"
import { readFile } from "node:fs/promises"
import { extname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
const { default: entry } = await import(join(root, "dist/server/server.js"))
const port = Number(process.argv[2] ?? 4318)
const types = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
}

createServer(async (req, res) => {
  try {
    if (req.url.startsWith("/assets/")) {
      const file = join(root, "dist/client", req.url.split("?")[0])
      res.writeHead(200, {
        "content-type": types[extname(file)] ?? "application/octet-stream",
      })
      return res.end(await readFile(file))
    }
    const chunks = []
    for await (const c of req) chunks.push(c)
    const body = chunks.length ? Buffer.concat(chunks) : undefined
    const request = new Request(`http://localhost:${port}${req.url}`, {
      method: req.method,
      headers: req.headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
    })
    const response = await entry.fetch(request)
    const headers = {}
    response.headers.forEach(
      (v, k) =>
        (headers[k] = k === "set-cookie" ? response.headers.getSetCookie() : v)
    )
    res.writeHead(response.status, headers)
    if (response.body) for await (const chunk of response.body) res.write(chunk)
    res.end()
  } catch (e) {
    res.writeHead(500)
    res.end(String(e?.stack ?? e))
  }
}).listen(port, () => console.log(`prod on ${port}`))
