import {
  appOrigin,
  authSecret,
  signalsConfig,
  signalsRotationWarning,
} from "./config"
import { getSignalTokens } from "./signal-tokens"

// Відмова старту (§4.1). У production Nitro не імпортує SSR-entry при запуску:
// сервіс вантажиться лінивим `import()` на першому запиті, тож перевірка в
// `src/server.ts` сама процес не зупинить. Плагін Nitro виконується в
// `useNitroApp()` на завантаженні `node-server`: виняток тут — необроблена
// помилка імпорту entry, процес виходить з ненульовим кодом і не слухає порт.
export default function startupPlugin(): Promise<void> | undefined {
  appOrigin()
  authSecret()
  const signals = signalsConfig()
  if (signals === undefined) return undefined
  const warning = signalsRotationWarning(signals.keys)
  if (warning !== undefined) console.warn(`[simetra] ${warning}`)
  // `createCentrifugoTokens` асинхронна: невідповідні `x`/`d` видно лише тут,
  // і відмова порту так само зупиняє процес
  return getSignalTokens().then(() => undefined)
}
