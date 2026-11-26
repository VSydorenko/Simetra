import { Pool } from "pg"
import {
  createCommandRuntime,
  createDataHandler,
  fromPgPool,
} from "simetra/server"
import { wrapDatabase } from "#instrument"
import runtimeCatalog from "../../generated/runtime-catalog.json"
import { requiredEnv } from "./config"
import { defer } from "./defer"

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

type DataHandler = ReturnType<typeof createDataHandler>
type Runtime = Awaited<ReturnType<typeof createCommandRuntime>>

let runtime: Promise<Runtime> | undefined
let handler: Promise<DataHandler> | undefined

/** Єдиний рантайм процесу: створюється ліниво, один раз; його беруть і маршрути сигналів. */
export function getRuntime(): Promise<Runtime> {
  runtime ??= createCommandRuntime({
    database: wrapDatabase(fromPgPool(getPool())),
    catalog: runtimeCatalog,
    defer,
  }).catch((error: unknown) => {
    // Невдалий старт не кешується: наступний запит пробує ще раз
    runtime = undefined
    throw error
  })
  return runtime
}

/** Обробник даних над єдиним рантаймом. */
export function getDataHandler(): Promise<DataHandler> {
  handler ??= getRuntime().then(
    (ready) =>
      createDataHandler(ready, {
        log: (error) => console.error("[simetra] data handler", error),
      }),
    (error: unknown) => {
      handler = undefined
      throw error
    }
  )
  return handler
}
