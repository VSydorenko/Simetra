// Типи для імпорту з TS-тестів: скрипт лишається .mjs без збірки, бо команди
// стека кличуть його до `pnpm install`.
import type { ChildProcess, SpawnOptions } from "node:child_process"

type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions
) => ChildProcess

type SignalSource = {
  on(event: string, listener: (signal: NodeJS.Signals) => void): unknown
  off(event: string, listener: (signal: NodeJS.Signals) => void): unknown
}

export function withStackLock(
  path: string,
  fn: () => Promise<void>
): Promise<void>

/** Lock file name of the postgres stack. */
export const POSTGRES_LOCK_FILE: string

/** Lock file of the postgres stack: in `/tmp` whatever `TMPDIR` is. */
export const POSTGRES_LOCK_PATH: string

/** Env variable that names the held stack lock to the children of the script. */
export const STACK_LOCK_ENV: string

/** Argv of `docker compose exec … psql`; holds no password (it goes through stdin). */
export const POSTGRES_PSQL_ARGS: readonly string[]

/** Argv and environment of the Better Auth step; the DSN is only in `env`. */
export function betterAuthCommand(
  secrets: Record<string, string>,
  superuserUrl: string
): { args: string[]; env: Record<string, string> }

/** Runs a child in its own process group; resolves with its exit code. */
export function runChild(
  command: string,
  args: readonly string[],
  opts?: {
    cwd?: string
    env?: NodeJS.ProcessEnv
    input?: string
    onStdout?: (chunk: string) => void
    signals?: SignalSource
    killAfterMs?: number
  },
  spawnFn?: SpawnFn
): Promise<number>

/** sha256 of the files of `docker/postgres-stack/**`. */
export function stackFilesHash(): string

/** StoredKey and ServerKey (base64) of a SCRAM-SHA-256 verifier. */
export function scramKeys(
  password: string,
  salt: string,
  iterations: number
): { storedKey: string; serverKey: string }

/** Whether a `pg_authid.rolpassword` value is a SCRAM verifier of `password`. */
export function passwordMatches(verifier: string, password: string): boolean

/** Starts the postgres stack; the caller holds the stack lock. */
export function startPostgres(options?: {
  spawnFn?: SpawnFn
  signals?: SignalSource
  noBuild?: boolean
}): Promise<void>
