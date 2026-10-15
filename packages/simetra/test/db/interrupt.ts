// Обробник сигналу DB-прогону. Репортер vitest на SIGINT/SIGTERM виходить
// через 1 мс і teardown globalSetup не кличе, а воркери гинуть без `finally` —
// без цього обробника кожен перерваний прогін лишав би свої об'єкти на
// спільному стеку. Обробник синхронний: поки він блокує цикл подій, таймер
// виходу vitest не спрацює. SIGKILL самого прогону не ловиться нічим — його
// сирот називає наступний прогін.
import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import { constants } from "node:os"
import { fileURLToPath, pathToFileURL } from "node:url"

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const
// Прибиральник сам здається через 30 с; запас — на старт tsx і з'єднання
const SWEEP_TIMEOUT_MS = 40_000

/**
 * Installs a synchronous SIGINT/SIGTERM/SIGHUP handler that kills this
 * process's children, sweeps the stack objects tagged `tag`, calls `release`
 * and exits with `128 + signal number`. Returns a function that removes it.
 */
export function installInterruptCleanup(o: {
  tag: string
  release: () => void
}): () => void {
  // Шлях до tsx — одразу: без нього обробник не запустить прибиральника, і
  // краще впасти на старті прогону, ніж мовчки на сигналі
  const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href
  const sweep = fileURLToPath(new URL("./sweep.ts", import.meta.url))
  const handler = (signal: NodeJS.Signals): void => {
    process.stderr.write(
      `\n${signal}: stopping DB run ${o.tag} and removing its stack objects…\n`
    )
    killChildren()
    const result = spawnSync(
      process.execPath,
      ["--import", tsx, sweep, o.tag],
      { stdio: "inherit", timeout: SWEEP_TIMEOUT_MS }
    )
    if (result.error !== undefined || result.status !== 0)
      process.stderr.write(
        `The sweep of DB run ${o.tag} did not finish cleanly (${result.error?.message ?? `exit ${result.status ?? result.signal}`})\n`
      )
    try {
      o.release()
    } finally {
      process.exit(128 + constants.signals[signal])
    }
  }
  for (const signal of SIGNALS) process.once(signal, handler)
  return () => {
    for (const signal of SIGNALS) process.removeListener(signal, handler)
  }
}

// Воркери vitest — прямі діти: живий воркер продовжував би створювати
// об'єкти, поки прибиральник їх видаляє
function killChildren(): void {
  const found = spawnSync("pgrep", ["-P", String(process.pid)], {
    encoding: "utf8",
  })
  if (found.error !== undefined) {
    process.stderr.write(
      `pgrep is unavailable (${found.error.message}): child processes are not killed before the sweep\n`
    )
    return
  }
  for (const pid of found.stdout.split("\n").filter((line) => line !== ""))
    try {
      process.kill(Number(pid), "SIGKILL")
    } catch (error) {
      // Виняток тут зірвав би обробник до прибирання — лише повідомляємо
      if ((error as NodeJS.ErrnoException).code !== "ESRCH")
        process.stderr.write(
          `Could not kill child ${pid}: ${(error as Error).message}\n`
        )
    }
}
