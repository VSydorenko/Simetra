import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { basename } from "node:path"
import { PROVIDER_OWNER_ROLES } from "simetra/model"
import {
  assertSupabaseUnindexed,
  postgresStack,
  STACK_ENV,
  stackIndex,
} from "../../../../scripts/db-stack-index.mjs"

/** Профіль локального стека, на який націлений DB-прогін. */
export type TestProvider = "postgres" | "supabase"

/** Змінна середовища з профілем; її ставить globalSetup проєкту через `enterProvider`. */
export const PROVIDER_ENV = "SIMETRA_TEST_PROVIDER"

/** Адреси й замок стека одного профілю. */
export interface TestStack {
  /** Індекс стека `postgres`; у `supabase` індексу немає — 1. */
  index: number
  /** Значення мітки `simetra-stack`: `postgres`, `postgres-N` або `supabase`. */
  key: string
  databaseUrl: string
  superuserUrl: string
  /** `null` — у стека немає пулера. */
  poolerUrl: string | null
  superuserName: string
  /** Ім'я файла замка в тимчасовій теці: один замок на стек. */
  lockFile: string
  /** `null` — у стека немає Garage. */
  garageAdminUrl: string | null
  /** S3-адреса Garage; `null` — у стека немає Garage. */
  garageS3Url: string | null
}

// Усе лише на 127.0.0.1: значення секретів і паролів годяться тільки для
// локального стека. Замок Supabase зберігає наявне ім'я, щоб сесії на старому
// коді й далі взаємно виключалися з новими. Тести стека `postgres` входять
// суперкористувачем, а стартовий параметр `options` дає кожному новому
// з'єднанню з адреси тестів — і тест-хелпера, і рушія — роль власника: так
// тести бачать ті самі права, що й продовий власник, а `SET LOCAL ROLE`
// перевіряється за суперкористувачем сесії (спека профілю §10.3).
const SUPABASE_STACK: TestStack = {
  index: 1,
  key: "supabase",
  databaseUrl: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  superuserUrl: "postgresql://supabase_admin:postgres@127.0.0.1:54322/postgres",
  poolerUrl:
    "postgresql://postgres.pooler-dev:postgres@127.0.0.1:54329/postgres",
  superuserName: "supabase_admin",
  lockFile: "simetra-db-stack.lock",
  garageAdminUrl: null,
  garageS3Url: null,
}

/**
 * Стек профілю `p`, обчислений на виклик: індекс `postgres` береться з
 * `SIMETRA_STACK` у цю мить, а не при імпорті, бо адреса, обчислена до вибору
 * стека, веде прогін на чужий стек.
 */
export function profileStack(p: TestProvider): TestStack {
  if (p === "supabase") {
    assertSupabaseUnindexed(process.env)
    return SUPABASE_STACK
  }
  const s = postgresStack(stackIndex(process.env))
  const server = `postgresql://postgres:postgres@127.0.0.1:${s.pgPort}`
  return {
    index: s.index,
    key: s.key,
    databaseUrl: `${server}/simetra?options=${encodeURIComponent(`-c role=${PROVIDER_OWNER_ROLES.postgres}`)}`,
    superuserUrl: `${server}/simetra`,
    poolerUrl: null,
    superuserName: "postgres",
    lockFile: basename(s.lockPath),
    garageAdminUrl: `http://127.0.0.1:${s.garageAdminPort}`,
    garageS3Url: `http://127.0.0.1:${s.garageS3Port}`,
  }
}

/**
 * Префікс `SIMETRA_STACK=<N> ` для надрукованих команд прибирання: для стека
 * з індексом N ≠ 1 без нього команда пішла б на стек 1. Для стека 1 і для
 * `supabase` порожній, тож вивід не змінюється.
 */
export function stackEnvPrefix(stack: TestStack): string {
  return stack.index === 1 ? "" : `${STACK_ENV}=${stack.index} `
}

/** Dev-секрети стека `postgres`, які читає не лише скрипт старту (Garage). */
export const DEV_SECRETS_FILE = fileURLToPath(
  new URL("../../../../docker/postgres-stack/dev-secrets.env", import.meta.url)
)

/**
 * Паролі ролей входу стека `postgres`: окремий файл, бо `dev-secrets.env`
 * паролів входу не тримає (`stack-files.test.ts`).
 */
export const LOGIN_SECRETS_FILE = fileURLToPath(
  new URL(
    "../../../../docker/postgres-stack/login-secrets.env",
    import.meta.url
  )
)

/**
 * Значення змінної `name` з файла секретів стека `postgres` (типово —
 * dev-секрети; паролі ролей входу — `LOGIN_SECRETS_FILE`). Читає лише на
 * виклик, а не при імпорті: прогін на Supabase цих файлів не має потребувати.
 */
export function devSecret(
  name: string,
  path: string = DEV_SECRETS_FILE
): string {
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch {
    throw new Error(
      `Cannot read the stack secrets file ${path} (looking for ${name})`
    )
  }
  const prefix = `${name}=`
  const line = text.split(/\r?\n/).find((l) => l.startsWith(prefix))
  const value = line?.slice(prefix.length).trim()
  if (value === undefined || value === "")
    throw new Error(`${name} is not set in ${path}`)
  return value
}

/** Токен адмінки Garage стека `postgres`; `path` — лише для тесту. */
export function garageAdminToken(path: string = DEV_SECRETS_FILE): string {
  return devSecret("GARAGE_ADMIN_TOKEN", path)
}

/**
 * Прелюдія з'єднання суперкористувача стека: адреса без `options` і так не
 * несе ролі, але явне `SET ROLE NONE` не дає успадкованому налаштуванню ролі
 * (`ALTER ROLE … SET role`) підмінити суперкористувача, а `search_path` —
 * чужій схемі перехопити некваліфіковане ім'я. Одне місце форми для
 * `superuserClient`, сторожа й прибиральника.
 */
export const SUPERUSER_PRELUDE: readonly string[] = [
  "SET ROLE NONE",
  "SET search_path = pg_catalog, pg_temp",
]

/** Профіль прогону; без змінної — `postgres` (типовий після перемикання проєкту `db`). */
export function testProvider(): TestProvider {
  const value = process.env[PROVIDER_ENV]
  if (value === undefined || value === "") return "postgres"
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
  return profileStack(testProvider())
}
