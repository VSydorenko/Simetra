import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { PROVIDER_OWNER_ROLES } from "simetra/model"

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

const POSTGRES_SERVER = "postgresql://postgres:postgres@127.0.0.1:54422"

// Усе лише на 127.0.0.1: значення секретів і паролів годяться тільки для
// локального стека. Замок Supabase зберігає наявне ім'я, щоб сесії на старому
// коді й далі взаємно виключалися з новими. Тести стека `postgres` входять
// суперкористувачем, а стартовий параметр `options` дає кожному новому
// з'єднанню з адреси тестів — і тест-хелпера, і рушія — роль власника: так
// тести бачать ті самі права, що й продовий власник, а `SET LOCAL ROLE`
// перевіряється за суперкористувачем сесії (спека профілю §10.3).
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
    databaseUrl: `${POSTGRES_SERVER}/simetra?options=${encodeURIComponent(`-c role=${PROVIDER_OWNER_ROLES.postgres}`)}`,
    superuserUrl: `${POSTGRES_SERVER}/simetra`,
    poolerUrl: null,
    superuserName: "postgres",
    lockFile: "simetra-db-stack-postgres.lock",
    garageAdminUrl: "http://127.0.0.1:3903",
  },
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
