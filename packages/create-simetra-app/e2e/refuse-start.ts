// Відмова старту сервера збірки: порт не відповідає весь час до виходу процесу,
// код виходу ненульовий, а вивід називає змінну. Спільне для `security.spec` і
// `signals.spec`.
import { expect } from "@playwright/test"
import type { App } from "./fixtures"
import { send } from "./http"

export async function refusesToStart(
  app: App,
  env: Record<string, string | undefined>,
  variable: string
): Promise<void> {
  const port = await app.freePort()
  const run = app.start({
    PORT: String(port),
    HOST: "127.0.0.1",
    NITRO_HOST: "127.0.0.1",
    ...env,
  })
  // Порт має відмовляти весь час до виходу процесу, а не лише після нього:
  // сервер, що встиг почати слухати, — вже небезпечний
  let exitCode: number | null | "alive" = "alive"
  void run.exited.then((code) => (exitCode = code))
  const deadline = Date.now() + 20_000
  while (exitCode === "alive" && Date.now() < deadline) {
    await expect(send({ port }, { path: "/" })).rejects.toThrow(/ECONNREFUSED/)
    await new Promise((r) => setTimeout(r, 50))
  }
  if (exitCode === "alive") run.child.kill("SIGKILL")
  expect(exitCode).not.toBe("alive")
  expect(exitCode).not.toBe(0)
  expect(run.output()).toContain(variable)
  await expect(send({ port }, { path: "/" })).rejects.toThrow(/ECONNREFUSED/)
}
