import { appOrigin, authSecret, signalsConfig } from "./config"
import { assertAuthStartable } from "./start-checks"
import { signingKeyProblem } from "simetra/server/signals"

// Відмова старту (§4.1). У production Nitro не імпортує SSR-entry при запуску:
// сервіс вантажиться лінивим `import()` на першому запиті, тож перевірка в
// `src/server.ts` сама процес не зупинить. Плагін Nitro виконується в
// `useNitroApp()` на завантаженні `node-server`: синхронний виняток тут —
// необроблена помилка імпорту entry, процес виходить з ненульовим кодом і не
// слухає порт. Плагін має бути синхронним: Nitro не чекає проміс плагіна, а
// відхилення проміса процес не зупиняє.
export default function startupPlugin(): void {
  appOrigin()
  authSecret()
  assertAuthStartable()
  const signals = signalsConfig()
  if (signals === undefined) return
  // Штатна фаза ротації — не помилка конфігу, а попередження (профіль §6.3)
  const problem = signingKeyProblem(signals.keys)
  if (problem !== undefined) {
    console.warn(
      `[simetra] SIMETRA_SIGNALS_KEYS: ${problem}; token routes answer 503 until a key may sign`
    )
  }
}
