import {
  CommandFailure,
  wireReadPartsResultSchema,
  type DatabaseProvider,
  type SourceAdapter,
} from "simetra/model"
import { runtimeHandleOf, type RuntimeHandle } from "./runtime/handle"
import type { DataRuntime } from "./runtime/runtime"

/**
 * The Server Function source adapter (P4-B spec §5.2): the parts go through
 * the runtime transport wrapper as one `read` request; a failure of the whole
 * request is a `CommandFailure` of the same code, a failure of a part stays
 * in its item.
 */
export function createServerFunctionAdapter(
  runtime: DataRuntime
): SourceAdapter {
  return serverFunctionAdapter(runtimeHandleOf(runtime).send)
}

/**
 * The Server Function adapter over a transport wrapper; `createDataRuntime`
 * builds its default source with it before the runtime handle exists.
 */
export function serverFunctionAdapter(
  send: RuntimeHandle["send"]
): SourceAdapter {
  return {
    // Сервер повертає `included` сам (§4.2, Р5).
    capabilities: { include: true },
    async read(items) {
      const value = await send({ type: "read", items: [...items] })
      // Значення — від сервера, а не від ядра: форму перевіряє схема, і
      // хибна відповідь — дефект сервера (`command.internal`), а не
      // `TypeError` на чужому полі. Помилки частин мапить джерело ядра.
      const parsed = wireReadPartsResultSchema.safeParse(value)
      if (!parsed.success) {
        throw new CommandFailure({ code: "command.internal" })
      }
      return parsed.data
    },
  }
}

// Таблиця вибору за профілем (§5.1): новий профіль у `DATABASE_PROVIDERS`
// без рядка тут — помилка типів, тож вибір для нього робиться явно. Адаптер
// PostgREST для `supabase` — рішення блоку B4.
const DEFAULT_SOURCE: Record<DatabaseProvider, "serverFunction"> = {
  supabase: "serverFunction",
  postgres: "serverFunction",
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
