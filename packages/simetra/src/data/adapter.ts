import {
  CommandFailure,
  errorFromWire,
  type CatalogIndex,
  type DatabaseProvider,
  type SourceAdapter,
  type WireReadParts,
} from "simetra/model"
import { runtimeHandleOf, type RuntimeHandle } from "./runtime/handle"
import type { DataRuntime } from "./runtime/runtime"

/**
 * The Server Function source adapter (P4-B spec §5.2): a read goes through
 * the runtime transport wrapper as a one-part `read`; a failure of the
 * request or of its part is a `CommandFailure` of the same code.
 */
export function createServerFunctionAdapter(
  runtime: DataRuntime
): SourceAdapter {
  const { send, index } = runtimeHandleOf(runtime)
  return serverFunctionAdapter(send, index)
}

/**
 * The Server Function adapter over a transport wrapper; `createDataRuntime`
 * builds its default source with it before the runtime handle exists.
 */
export function serverFunctionAdapter(
  send: RuntimeHandle["send"],
  index: CatalogIndex
): SourceAdapter {
  return {
    // Сервер повертає `included` сам (§4.2, Р5).
    capabilities: { include: true },
    async read(query) {
      // Одна частина `query`: пакет частин адаптер шле разом із ядром (B1c-2).
      const value = (await send({
        type: "read",
        items: [{ type: "query", query }],
      })) as WireReadParts
      // Форму значення тримає обробник T3; тут лише звуження до рядків:
      // лічильник на рядковий запит — порушення контракту сервера.
      const item = value.items[0]
      if (item === undefined) {
        throw new CommandFailure({ code: "command.internal" })
      }
      if (!item.ok) throw new CommandFailure(errorFromWire(index, item.error))
      if (!("rows" in item.value)) {
        throw new CommandFailure({ code: "command.internal" })
      }
      return item.value
    },
  }
}

// Таблиця вибору за профілем (§5.1): новий профіль у `DATABASE_PROVIDERS`
// без рядка тут — помилка типів, тож вибір для нього робиться явно. Адаптер
// PostgREST для `supabase` — рішення блоку B4.
const DEFAULT_SOURCE: Record<DatabaseProvider, "serverFunction"> = {
  supabase: "serverFunction",
}

/**
 * Picks the source adapter: the application override, otherwise the default
 * of the database profile (Server Function for every profile until B4).
 */
export function selectSource(options: {
  profile: DatabaseProvider
  override?: SourceAdapter
  serverFunction: SourceAdapter
}): SourceAdapter {
  if (options.override !== undefined) return options.override
  return { serverFunction: options.serverFunction }[
    DEFAULT_SOURCE[options.profile]
  ]
}
