// Запуск зібраного host-а локально: node-server — `.output/server/index.mjs`;
// пресет Vercel — функція `.vercel/output/functions/__server.func` під
// обв'язкою, яка, як платформа, дає `context.waitUntil` і контекст запиту
// `@vercel/request-context` (його читає `attachDatabasePool`).
//   node serve.mjs <host-dir> <port>

import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

/** Чекає, доки сервер відповідає. */
export async function waitReady(port) {
  for (let i = 0; i < 150; i += 1) {
    try {
      await fetch(`http://127.0.0.1:${port}/__ready`)
      return
    } catch {
      await new Promise((r) => setTimeout(r, 200))
    }
  }
  throw new Error(`server did not start on ${port}`)
}

/** Піднімає host у дочірньому процесі; повертає зупинку й журнал. */
export async function startHost(dir, preset, port, env = {}) {
  const args =
    preset === "vercel"
      ? [import.meta.filename, dir, String(port)]
      : [join(dir, ".output/server/index.mjs")]
  let logs = ""
  const child = spawn("node", args, {
    cwd: dir,
    env: { ...process.env, ...env, PORT: String(port), HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe"],
  })
  child.stdout.on("data", (c) => (logs += c))
  child.stderr.on("data", (c) => (logs += c))
  const exited = new Promise((_, reject) =>
    child.once("exit", (code) =>
      reject(new Error(`host exited ${code}\n${logs}`))
    )
  )
  await Promise.race([waitReady(port), exited])
  return { stop: () => child.kill("SIGTERM"), logs: () => logs }
}

async function serveVercel(dir, port) {
  const fn = join(dir, ".vercel/output/functions/__server.func/index.mjs")
  const pending = new Set()
  const waitUntil = (promise) => {
    const started = Date.now()
    const tracked = Promise.resolve(promise)
      .then(
        () =>
          console.log(
            `HARNESS_WAIT_UNTIL settled after ${Date.now() - started}ms`
          ),
        (e) => console.log(`HARNESS_WAIT_UNTIL rejected ${e}`)
      )
      .finally(() => pending.delete(tracked))
    pending.add(tracked)
  }
  const context = { waitUntil }
  globalThis[Symbol.for("@vercel/request-context")] = { get: () => context }
  const { default: handler } = await import(pathToFileURL(fn).href)
  createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const body = chunks.length ? Buffer.concat(chunks) : undefined
    const request = new Request(`http://${req.headers.host}${req.url}`, {
      method: req.method,
      headers: req.headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
    })
    const response = await handler.fetch(request, context)
    res.writeHead(response.status, Object.fromEntries(response.headers))
    if (response.body) for await (const c of response.body) res.write(c)
    res.end()
  }).listen(port, "127.0.0.1")
}

if (import.meta.filename === process.argv[1]) {
  const [dir, port] = process.argv.slice(2)
  await serveVercel(dir, Number(port))
}
