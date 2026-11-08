import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

/** Профіль локального стека, на який націлений DB-прогін. */
export type TestProvider = "postgres" | "supabase"

/** Змінна середовища з профілем; її ставить globalSetup проєкту через `enterProvider`. */
export const PROVIDER_ENV = "SIMETRA_TEST_PROVIDER"

/** Адреси й замок стека одного профілю. */
export interface TestStack {
  databaseUrl: string
  superuserUrl: string
  /** `null` — у стека немає пулера. */
  poolerUrl: string | null
  superuserName: string
  /** Ім'я файла замка в тимчасовій теці: один замок на стек. */
  lockFile: string
  /** `null` — у стека немає Garage. */
  garageAdminUrl: string | null
}

// Усе лише на 127.0.0.1: значення секретів і паролів годяться тільки для
// локального стека. Замок Supabase зберігає наявне ім'я, щоб сесії на старому
// коді й далі взаємно виключалися з новими.
export const TEST_STACKS: Record<TestProvider, TestStack> = {
  supabase: {
    databaseUrl: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
    superuserUrl:
      "postgresql://supabase_admin:postgres@127.0.0.1:54322/postgres",
    poolerUrl:
      "postgresql://postgres.pooler-dev:postgres@127.0.0.1:54329/postgres",
    superuserName: "supabase_admin",
    lockFile: "simetra-db-stack.lock",
    garageAdminUrl: null,
  },
  postgres: {
    databaseUrl: "postgresql://postgres:postgres@127.0.0.1:54422/postgres",
    superuserUrl: "postgresql://postgres:postgres@127.0.0.1:54422/postgres",
    poolerUrl: null,
    superuserName: "postgres",
    lockFile: "simetra-db-stack-postgres.lock",
    garageAdminUrl: "http://127.0.0.1:3903",
  },
}

const SECRETS_FILE = fileURLToPath(
  new URL("../../../../docker/postgres-stack/dev-secrets.env", import.meta.url)
)

/**
 * Токен адмінки Garage з файла dev-секретів стека `postgres`. Окрема функція,
 * а не поле профілю: прогін на Supabase цього файла не читає. `path` — лише
 * для тесту.
 */
export function garageAdminToken(path: string = SECRETS_FILE): string {
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch {
    throw new Error(`Cannot read the stack secrets file ${path}`)
  }
  const line = text
    .split(/\r?\n/)
    .find((l) => l.startsWith("GARAGE_ADMIN_TOKEN="))
  const value = line?.slice("GARAGE_ADMIN_TOKEN=".length).trim()
  if (value === undefined || value === "")
    throw new Error(`GARAGE_ADMIN_TOKEN is not set in ${path}`)
  return value
}

/** Профіль прогону; без змінної — `supabase` (типовий у ПГ-1). */
export function testProvider(): TestProvider {
  const value = process.env[PROVIDER_ENV]
  if (value === undefined || value === "") return "supabase"
  if (value === "postgres" || value === "supabase") return value
  throw new Error(
    `${PROVIDER_ENV}="${value}" is not a profile: use "postgres" or "supabase"`
  )
}

/**
 * Робить процес процесом прогону з профілем `p`. Інший профіль, що вже стоїть
 * в процесі, — помилка: один процес не б'є в два стеки.
 */
export function enterProvider(p: TestProvider): void {
  const current = process.env[PROVIDER_ENV]
  if (current !== undefined && current !== "" && current !== p)
    throw new Error(
      `${PROVIDER_ENV} is already "${current}": one process runs against one stack, cannot enter "${p}"`
    )
  process.env[PROVIDER_ENV] = p
}

export function testStack(): TestStack {
  return TEST_STACKS[testProvider()]
}
