// `pnpm demo` / `pnpm demo:drop`: шаблон на локальному стеку `postgres` для
// людини в браузері. База демо одна й постійна; створення й видалення — під
// замком стека, бо DB-прогін, що йде одночасно, побачив би нову чи зниклу базу
// у звірці сторожа. Сервер працює вже без замка: база в обох знімках
// сторожа однакова.
import { randomBytes } from "node:crypto"
import net from "node:net"
import { currentStack } from "../../../../scripts/db-stack.mjs"
import {
  postgresLockPath,
  loginSecrets,
  stackUrl,
  withStackLock,
} from "../../../../scripts/db-stack.mjs"
import { assertLoopback } from "../../template/scripts/dev-guard.mjs"
import { createDevUser } from "../../template/scripts/dev-user.mjs"
import { seed } from "../../template/scripts/seed.mjs"
import {
  appDsns,
  appServerEnv,
  buildTemplate,
  insertOwnClients,
  prepareDatabase,
  startServer,
  stopServer,
  waitReady,
  withClient,
  withDatabase,
  type AppDsns,
} from "./app-database.mts"
import {
  generateSigningKeys,
  removeSignalsContainers,
  signalsDsn,
  startSignals,
} from "./signals-stand.mts"

/** The demo database on the postgres stack. */
export const DEMO_DATABASE = "simetra_demo"
export const DEMO_PORT = 3000
export const DEMO_ORIGIN = `http://localhost:${DEMO_PORT}`

// Мітка власності — коментар бази: демо видаляє лише базу зі своєю міткою.
// `incomplete` стоїть від `CREATE DATABASE` до кінця підготовки, тож
// обірвана підготовка впізнається й готується заново
export const DEMO_MARK = {
  incomplete: "simetra-demo:incomplete",
  ready: "simetra-demo:ready",
} as const

/** `Client` rows of each demo user; Alice's come with the shared `Country` rows. */
export const DEMO_USERS = [
  { email: "alice@demo.test", name: "Alice", clients: 250 },
  { email: "bob@demo.test", name: "Bob", clients: 5 },
] as const

// Власний Centrifugo демо (Р1 плану D5): мітка й ім'я окремі від контейнерів
// стека, тож залишок попереднього запуску знімається лише за нею
export const DEMO_SIGNALS_LABEL = "simetra-demo=signals"
const DEMO_SIGNALS_NAME = "simetra-demo-signals"

export type DemoState = "absent" | "ready" | "incomplete" | "foreign"

/** State of the demo database from its row (`undefined` — no such database). */
export function demoState(
  row: { comment: string | null } | undefined
): DemoState {
  if (row === undefined) return "absent"
  if (row.comment === DEMO_MARK.ready) return "ready"
  if (row.comment === DEMO_MARK.incomplete) return "incomplete"
  return "foreign"
}

export type DemoStep = "create" | "recreate" | "reuse" | "drop" | "nothing"

/** What `command` does with the demo database in `state`; throws on a foreign one. */
export function demoStep(command: "up" | "drop", state: DemoState): DemoStep {
  if (state === "foreign")
    throw new Error(
      `refused: the database "${DEMO_DATABASE}" exists but was not created by the demo (no "${DEMO_MARK.ready}" comment); it is left untouched`
    )
  if (command === "drop") return state === "absent" ? "nothing" : "drop"
  // База з міткою ready до правила CONNECT лишає PUBLIC CONNECT, доки її не
  // перестворено (`pnpm demo:drop`)
  if (state === "ready") return "reuse"
  return state === "incomplete" ? "recreate" : "create"
}

interface Stack {
  maintenanceUrl: string
  dsns: AppDsns
}

/** Адреси лише локального стека: нелокальний хост — відмова до першого запиту. */
export function demoStack(
  superuserUrl: string,
  secrets: Record<string, string>
): Stack {
  const dsns = appDsns(superuserUrl, DEMO_DATABASE, secrets)
  const maintenanceUrl = withDatabase(superuserUrl, "postgres")
  for (const url of [maintenanceUrl, ...Object.values(dsns)])
    assertLoopback(url)
  return { maintenanceUrl, dsns }
}

/**
 * Позначка стека в повідомленнях: порожня для стека 1 (тексти без змін),
 * інакше змінна, якою обирають той самий стек для `demo` і `demo:drop`.
 */
export function stackNote(index: number): string {
  return index === 1 ? "" : ` (SIMETRA_STACK=${index})`
}

export function busyMessage(index: number, detail: string): string {
  return `DB run in progress on the postgres stack${stackNote(index)}, retry when it ends (${detail})`
}

export function noDemoMessage(index: number): string {
  return `demo: no ${DEMO_DATABASE} database${stackNote(index)}; nothing to drop`
}

async function readState(maintenanceUrl: string): Promise<DemoState> {
  const rows = await withClient(maintenanceUrl, async (client) => {
    const result = await client.query<{ comment: string | null }>(
      "SELECT pg_catalog.shobj_description(oid, 'pg_database') AS comment FROM pg_catalog.pg_database WHERE datname = $1",
      [DEMO_DATABASE]
    )
    return result.rows
  })
  return demoState(rows[0])
}

async function dropDemo(maintenanceUrl: string): Promise<void> {
  await withClient(maintenanceUrl, (client) =>
    client.query(`DROP DATABASE IF EXISTS "${DEMO_DATABASE}" WITH (FORCE)`)
  )
}

const comment = (mark: string): string =>
  `COMMENT ON DATABASE "${DEMO_DATABASE}" IS '${mark}'`

// Замок стека береться одразу або ніколи: демо — команда, а не прогін, що чекає
async function underLock(fn: () => Promise<void>): Promise<void> {
  try {
    await withStackLock(postgresLockPath(), fn)
  } catch (error) {
    if (
      error instanceof Error &&
      / stack is in use by PID /.test(error.message)
    )
      throw new Error(busyMessage(currentStack().index, error.message))
    throw error
  }
}

async function createDemo(
  stack: Stack,
  origin: string,
  secret: string
): Promise<Record<string, string>> {
  const { dsns } = stack
  await prepareDatabase({
    database: DEMO_DATABASE,
    maintenanceUrl: stack.maintenanceUrl,
    dsns,
    origin,
    secret,
    created: (client) =>
      client.query(comment(DEMO_MARK.incomplete)).then(() => undefined),
  })
  const passwords = await setPasswords(dsns, origin, secret)
  const ids = await withClient(dsns.SIMETRA_SUPERUSER_DATABASE_URL, (client) =>
    client
      .query<{ id: string; email: string }>(
        'SELECT id, email FROM better_auth."user" WHERE email = ANY($1)',
        [DEMO_USERS.map((u) => u.email)]
      )
      .then(
        (r) => new Map(r.rows.map((row) => [row.email, row.id.toLowerCase()]))
      )
  )
  const [alice, bob] = DEMO_USERS.map((u) => ids.get(u.email)!)
  // `seed` дає спільний довідник `Country` і рядки Alice; рядки Bob — окремо,
  // з іншим префіксом коду
  await withClient(dsns.SIMETRA_OWNER_DATABASE_URL, (client) =>
    seed(client, { count: DEMO_USERS[0].clients, owner: alice })
  )
  await insertOwnClients(dsns.SIMETRA_OWNER_DATABASE_URL, {
    owner: bob!,
    count: DEMO_USERS[1].clients,
    prefix: "B",
    description: "Bob's client",
  })
  await withClient(stack.maintenanceUrl, (client) =>
    client.query(comment(DEMO_MARK.ready))
  )
  return passwords
}

// Пароль випадковий і друкується щоразу (спека П4-D §4.3): повторний запуск
// міняє його наявному користувачу, у файл він не пишеться
async function setPasswords(
  dsns: AppDsns,
  origin: string,
  secret: string
): Promise<Record<string, string>> {
  const passwords: Record<string, string> = {}
  for (const user of DEMO_USERS) {
    const result = await createDevUser({
      dsn: dsns.SIMETRA_AUTH_DATABASE_URL,
      email: user.email,
      name: user.name,
      origin,
      secret,
    })
    passwords[user.email] = result.password
  }
  return passwords
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolvePort) => {
    const server = net.createServer()
    server.once("error", () => resolvePort(false))
    server.listen(port, "127.0.0.1", () =>
      server.close(() => resolvePort(true))
    )
  })
}

function stackFromEnvironment(): Stack {
  return demoStack(stackUrl("postgres", "postgres"), loginSecrets())
}

/**
 * Виконує `run` і знімає стенд на будь-якому виході: помилка генерації ключа
 * чи старту сервера теж не лишає контейнер. Помилка `down` не затуляє помилку
 * `run`.
 */
export async function withStand<T>(
  stand: { down: () => Promise<void> },
  run: () => Promise<T>
): Promise<T> {
  let result: T
  try {
    result = await run()
  } catch (error) {
    await stand.down().catch(() => undefined)
    throw error
  }
  await stand.down()
  return result
}

/** `pnpm demo`: prepares (or reuses) the demo database, builds and serves the template. */
export async function demoUp(): Promise<number> {
  const stack = stackFromEnvironment()
  if (!(await portFree(DEMO_PORT)))
    throw new Error(
      `refused: port ${DEMO_PORT} is busy; stop what listens there and rerun`
    )
  // Секрет на запуск: сесії попереднього запуску просто перестають діяти
  const secret = randomBytes(32).toString("base64url")
  let passwords: Record<string, string> = {}
  await underLock(async () => {
    const step = demoStep("up", await readState(stack.maintenanceUrl))
    if (step === "recreate") {
      console.log(
        `demo: the previous setup was interrupted; recreating ${DEMO_DATABASE}`
      )
      await dropDemo(stack.maintenanceUrl)
    }
    if (step === "reuse") {
      console.log(`demo: reusing the database ${DEMO_DATABASE}`)
      passwords = await setPasswords(stack.dsns, DEMO_ORIGIN, secret)
    } else {
      console.log(`demo: creating the database ${DEMO_DATABASE}`)
      passwords = await createDemo(stack, DEMO_ORIGIN, secret)
    }
  })
  console.log("demo: building the template (production)")
  await buildTemplate()
  // Залишок: контейнер попереднього запуску міг пережити SIGKILL
  await removeSignalsContainers(DEMO_SIGNALS_LABEL)
  console.log("demo: starting Centrifugo")
  const signals = await startSignals({
    name: DEMO_SIGNALS_NAME,
    labels: ["--label", DEMO_SIGNALS_LABEL],
    origin: DEMO_ORIGIN,
    hostPort: DEMO_PORT,
    databaseUrl: signalsDsn(
      stackUrl("postgres", "postgres"),
      DEMO_DATABASE,
      loginSecrets()
    ),
  })
  return withStand(signals, async () => {
    // Новий ключ і `kid` на кожен запуск (Р3): жодного ключа в git
    const keys = await generateSigningKeys()
    const server = startServer(
      appServerEnv({
        dsns: stack.dsns,
        origin: DEMO_ORIGIN,
        port: DEMO_PORT,
        host: "127.0.0.1",
        secret,
        signals: { url: signals.wsUrl, keys: keys.json },
      }),
      { echo: true }
    )
    const stop = (): void => void stopServer(server)
    process.once("SIGINT", stop)
    process.once("SIGTERM", stop)
    try {
      await waitReady(`${DEMO_ORIGIN}/`, server)
    } catch (error) {
      // Сервер, що не відповів вчасно, не лишається висіти на порту
      await stopServer(server)
      throw error
    }
    console.log(
      [
        "",
        `Simetra demo: ${DEMO_ORIGIN}`,
        ...DEMO_USERS.map(
          (u) => `  ${u.name}: ${u.email}  password: ${passwords[u.email]}`
        ),
        "Each user sees only their own clients. Ctrl-C stops the server; `pnpm demo:drop` removes the demo database.",
        "",
      ].join("\n")
    )
    return (await server.exited) ?? 0
  })
}

/** `pnpm demo:drop`: drops the demo database, and only it. */
export async function demoDrop(): Promise<void> {
  const stack = stackFromEnvironment()
  // Centrifugo тримає з'єднання з базою демо: знімається до видалення бази
  await removeSignalsContainers(DEMO_SIGNALS_LABEL)
  await underLock(async () => {
    const step = demoStep("drop", await readState(stack.maintenanceUrl))
    if (step === "nothing") {
      console.log(noDemoMessage(currentStack().index))
      return
    }
    await dropDemo(stack.maintenanceUrl)
    console.log(`demo: dropped the database ${DEMO_DATABASE}`)
  })
}
