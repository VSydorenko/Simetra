// Сигнали клієнта (Р10, Р12 D5). Окремий модуль: `centrifuge` тягне лише він, а
// кореневий роутер викликає його у клієнтській гілці `createIsomorphicFn`, тож
// серверна збірка модуля не несе (І8).
import { createCentrifugoTransport } from "simetra/data/centrifugo"
import type { SignalTransport } from "simetra/model"
import type { HostScope } from "./host-scope"
import { createSignalTokenCallbacks } from "./signal-tokens-client"

/**
 * Фабрика транспорту для `DataRuntimeOptions.signals`. Колбеки токенів — на
 * транспорт і суб'єкта; закриття транспорту (рантайм кличе його синхронно)
 * закриває й їх, щоб пакет, що чекає, не пережив рантайм.
 */
export function clientSignals(
  scope: Pick<HostScope, "holder" | "toLogin">,
  url: string
): (subject: string) => SignalTransport {
  return (subject) => {
    const callbacks = createSignalTokenCallbacks({
      subject,
      holder: scope.holder,
      navigateToLogin: scope.toLogin,
    })
    const transport = createCentrifugoTransport({
      url,
      getConnectionToken: callbacks.getConnectionToken,
      getChannelToken: callbacks.getChannelToken,
    })
    return {
      ...transport,
      close() {
        callbacks.close()
        transport.close()
      },
    }
  }
}
