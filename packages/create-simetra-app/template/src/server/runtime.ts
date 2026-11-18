import { useRequest } from "nitro/context"
import { Pool } from "pg"
import {
  createCommandRuntime,
  createDataHandler,
  fromPgPool,
} from "simetra/server"
import { wrapDatabase } from "#instrument"
import runtimeCatalog from "../../generated/runtime-catalog.json"
import { requiredEnv } from "./config"

/** Хеш каталогу сервера: його несе кожна відповідь, і відмови до обробника теж. */
export const serverHash: string = runtimeCatalog.snapshotHash

let pool: Pool | undefined

// Пул роллю `simetra_runtime` на рівні модуля (Рт17): рантайм живе довше за запит
function getPool(): Pool {
  pool ??= new Pool({
    connectionString: requiredEnv("SIMETRA_RUNTIME_DATABASE_URL"),
  })
  return pool
}

/**
 * `waitUntil` береться на кожен виклик з поточного запиту: рантайм на рівні
 * модуля переживає перший запит, а його `waitUntil` після відповіді вже мертвий.
 */
function defer(work: Promise<unknown>): void {
  const request = useRequest()
  if (typeof request.waitUntil === "function") {
    request.waitUntil(work)
    return
  }
  // Платформа без `waitUntil`: робота не губиться, а її збій — у журнал
  work.catch((error: unknown) => console.error("[simetra] deferred", error))
}

type DataHandler = ReturnType<typeof createDataHandler>

let handler: Promise<DataHandler> | undefined

/** Обробник даних: рантайм створюється ліниво, один раз. */
export function getDataHandler(): Promise<DataHandler> {
  handler ??= createCommandRuntime({
    database: wrapDatabase(fromPgPool(getPool())),
    catalog: runtimeCatalog,
    defer,
  }).then(
    (runtime) =>
      createDataHandler(runtime, {
        log: (error) => console.error("[simetra] data handler", error),
      }),
    (error: unknown) => {
      // Невдалий старт не кешується: наступний запит пробує ще раз
      handler = undefined
      throw error
    }
  )
  return handler
}
