import {
  createCentrifugoTokens,
  type SignalTokens,
} from "simetra/server/signals"
import project from "../../metadata/project.meta.json"
import { appOrigin, signalsConfig } from "./config"

let tokens: Promise<SignalTokens | undefined> | undefined

/**
 * Єдиний порт токенів процесу над `SIMETRA_SIGNALS_KEYS`; `undefined`, коли
 * сигналів не налаштовано (маршрути тоді 404). Невдалий старт не кешується.
 */
export function getSignalTokens(): Promise<SignalTokens | undefined> {
  tokens ??= (async () => {
    const config = signalsConfig()
    if (config === undefined) return undefined
    // Каталог рантайму назви проєкту не несе, тож audience — з файла проєкту
    return createCentrifugoTokens({
      keys: config.keys,
      audience: `centrifugo:${project.name}`,
      issuer: appOrigin(),
    })
  })().catch((error: unknown) => {
    tokens = undefined
    throw error
  })
  return tokens
}
