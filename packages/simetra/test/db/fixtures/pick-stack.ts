// Дочірній процес `stack-guard.test.ts`: один конкурент за стек пулу. Замки
// лежать у теці тесту, а не в `/tmp`, і живість стека підставна: тест не
// торкається ні реальних замків, ні стека.
//
// `node --import tsx pick-stack.ts <тека> <кандидати через кому> <тека-прапор> hold <мс>`
// — бере стек, друкує `picked <N> <мс епохи>`, тримає, звільняє, друкує
// `released <N> <мс епохи>`; `… interrupt` — тримає до сигналу з тим самим
// обробником, що й сторож. `FAKE_DEAD` — індекси не живих стеків.
import { existsSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { installInterruptCleanup } from "../interrupt"
import { takeStack } from "../stack-guard"

const [dir, candidates, goFile, mode, holdMs, rounds = "1"] =
  process.argv.slice(2)
if (
  dir === undefined ||
  candidates === undefined ||
  goFile === undefined ||
  mode === undefined
)
  throw new Error(
    "Usage: pick-stack.ts <dir> <candidates> <go file> hold|interrupt [ms]"
  )
const dead = new Set(
  (process.env.FAKE_DEAD ?? "").split(",").filter(Boolean).map(Number)
)

process.stdout.write("ready\n")
// Спільний старт усіх конкурентів: інакше різниця в старті tsx ховала б гонку
while (!existsSync(goFile)) {
  /* spin */
}
try {
  const pick = (): ReturnType<typeof takeStack> =>
    takeStack("postgres", {
      candidates: candidates.split(",").map(Number),
      lockOf: (index) => join(dir, `stack-${index}.lock`),
      live: async (index) => !dead.has(index),
      pollMs: 1,
      waitMs: 60_000,
    })
  const taken = await pick()
  process.stdout.write(
    `picked ${taken.index} ${Date.now()} env=${process.env.SIMETRA_STACK}\n`
  )
  if (mode === "interrupt") {
    installInterruptCleanup({
      tag: "abc123",
      release: taken.release,
      sweep: fileURLToPath(new URL("./noop-sweep.ts", import.meta.url)),
    })
    setTimeout(() => process.exit(3), 120_000)
  } else {
    // Кілька кругів поспіль: одна спроба рідко потрапляє у вікно гонки
    let current = taken
    for (let round = 1; ; round++) {
      await new Promise((resolve) => setTimeout(resolve, Number(holdMs)))
      // Час — до звільнення: наступний власник замка стартує вже після нього
      const at = Date.now()
      current.release()
      process.stdout.write(`released ${current.index} ${at}\n`)
      if (round >= Number(rounds)) break
      current = await pick()
      process.stdout.write(`picked ${current.index} ${Date.now()}\n`)
    }
    process.exit(0)
  }
} catch (error) {
  process.stdout.write(`error ${(error as Error).message}\n`)
  process.exit(2)
}
