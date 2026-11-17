import { appOrigin, authSecret } from "./config"

// Відмова старту (§4.1). У production Nitro не імпортує SSR-entry при запуску:
// сервіс вантажиться лінивим `import()` на першому запиті, тож перевірка в
// `src/server.ts` сама процес не зупинить. Плагін Nitro виконується в
// `useNitroApp()` на завантаженні `node-server`: виняток тут — необроблена
// помилка імпорту entry, процес виходить з ненульовим кодом і не слухає порт.
export default function startupPlugin(): void {
  appOrigin()
  authSecret()
}
