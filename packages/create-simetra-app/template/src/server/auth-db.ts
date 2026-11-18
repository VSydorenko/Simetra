import { Pool } from "pg"
import { requiredEnv } from "./config"

/**
 * Параметри пула Better Auth. `search_path` ставиться опцією з'єднання, а не
 * `database.schemaName`: зі `schemaName` Better Auth шле `CREATE SCHEMA IF NOT
 * EXISTS`, а Postgres вимагає `CREATE` на базу ще до `IF NOT EXISTS`.
 */
export function authPoolConfig(): {
  connectionString: string
  options: string
} {
  return {
    connectionString: requiredEnv("SIMETRA_AUTH_DATABASE_URL"),
    options: "-c search_path=better_auth",
  }
}

let pool: Pool | undefined

/** Пул ролі `simetra_auth` на рівні модуля: один на процес. */
export function getAuthPool(): Pool {
  pool ??= new Pool(authPoolConfig())
  return pool
}
