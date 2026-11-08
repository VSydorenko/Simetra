import {
  CommandFailure,
  type DatabaseProvider,
  type SourceAdapter,
  type WireReadResult,
} from "simetra/model"
import { facadeOf } from "./facade/handle"
import type { DataRuntime } from "./facade/runtime"

/**
 * The Server Function source adapter (P4-B spec §5.2): a read goes through
 * the runtime transport wrapper; a failure is a `CommandFailure` of the same
 * code.
 */
export function createServerFunctionAdapter(
  runtime: DataRuntime
): SourceAdapter {
  const { send } = facadeOf(runtime)
  return {
    // Сервер повертає `included` сам (§4.2, Р5).
    capabilities: { include: true },
    async read(query) {
      // Форму значення тримає обробник T3; тут лише звуження до рядків:
      // лічильник на рядковий запит — порушення контракту сервера.
      const value = (await send({ type: "read", query })) as WireReadResult
      if ("count" in value) {
        throw new CommandFailure({ code: "command.internal" })
      }
      return value
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
