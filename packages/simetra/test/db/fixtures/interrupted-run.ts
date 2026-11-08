// Дочірній процес `interrupt.db.test.ts`: відтворює головний процес DB-прогону
// з власним тегом. Вкладений vitest не підходить — він узяв би замок стеку,
// який уже тримає зовнішній прогін, тож фікстура ставить той самий обробник
// сигналу, що й `stack-guard`, і створює об'єкти так, як їх створюють тести.
//
// `node --import tsx interrupted-run.ts <тег>` — головний процес (на стеку
// postgres ще й з контейнером і бакетом тегу);
// `… --worker` — «воркер», що безперервно створює тегові бази.
// `… <тег> --sleep <файл замка>` — головний процес, що тримає замок-файл
// (обробник сигналу його видаляє), і `… --sleep-worker` — воркер посеред
// довгого запиту, який сервер після смерті клієнта виконує й далі.
import { fork } from "node:child_process"
import { readFileSync, writeFileSync, rmSync } from "node:fs"
import { fileURLToPath } from "node:url"
import pg from "pg"
import {
  enterRun,
  isRunTag,
  runTag,
  SHADOW_PREFIX,
  shadowSuffix,
  testDatabaseName,
  testDatabaseUrl,
  testRoleName,
  testSuperuserUrl,
} from "../connection"
import { createRunBucket, nodeExec } from "../external"
import { installInterruptCleanup } from "../interrupt"
import { testProvider, testStack } from "../profile"

// Запобіжник, якщо тест не надішле сигналу (упав чи сам був убитий): фікстура
// перериває себе тим самим шляхом, тож не висить і не лишає тегових об'єктів
const SELF_INTERRUPT_MS = 120_000
const WORKER_PAUSE_MS = 200

const COMPOSE_FILE = fileURLToPath(
  new URL("../../../../../docker/postgres-stack/compose.yaml", import.meta.url)
)

// Образ сервісу postgres — з compose-файла стека, єдиного місця його тегу:
// тег, продубльований тут, розійшовся б із ним на першому оновленні
function stackPostgresImage(): string {
  const image = /^ {2}postgres:\n(?: {4}.*\n)*? {4}image: (\S+)$/m.exec(
    readFileSync(COMPOSE_FILE, "utf8")
  )?.[1]
  if (image === undefined)
    throw new Error(`No image of service postgres in ${COMPOSE_FILE}`)
  return image
}

function interruptContainerName(tag: string): string {
  return `simetra-run-${tag}-interrupt`
}

// Довший за будь-яке очікування тесту: запит, що завершився сам, нічого б не
// довів про сторожа
const SLEEP_SECONDS = 60

async function main(
  tag: string | undefined,
  lockPath: string | undefined
): Promise<void> {
  if (tag === undefined || !isRunTag(tag))
    throw new Error(
      "Usage: interrupted-run.ts <run tag> [--sleep <lock file>] | --worker | --sleep-worker"
    )
  enterRun(tag)
  if (lockPath !== undefined) writeFileSync(lockPath, `${process.pid}\n`)
  installInterruptCleanup({
    tag,
    release: () => {
      if (lockPath !== undefined) rmSync(lockPath, { force: true })
    },
  })

  if (lockPath === undefined) await createObjects()
  // Воркер успадковує env (тег і `PGAPPNAME`) і execArgv (`--import tsx`);
  // `ready` — лише після його першого кроку, щоб сигнал гарантовано застав
  // воркер у роботі
  const worker = fork(fileURLToPath(import.meta.url), [
    lockPath === undefined ? "--worker" : "--sleep-worker",
  ])
  await new Promise<void>((resolve, reject) => {
    worker.once("message", () => resolve())
    worker.once("exit", (code) =>
      reject(new Error(`The worker exited early with code ${code}`))
    )
  })
  process.stdout.write(`ready ${worker.pid}\n`)
  setTimeout(() => process.kill(process.pid, "SIGTERM"), SELF_INTERRUPT_MS)
}

async function createObjects(): Promise<void> {
  await asSuperuser(async (client) => {
    const id = (name: string): string => client.escapeIdentifier(name)
    await client.query(
      `CREATE DATABASE ${id(testDatabaseName("interrupt_copy"))}`
    )
    await client.query(`CREATE DATABASE ${id(SHADOW_PREFIX + shadowSuffix())}`)
    await client.query(`CREATE ROLE ${id(testRoleName("interrupt_owner"))}`)
  })
  // На стеку postgres прогін має й зовнішні ресурси: прибиральник на сигналі
  // мусить видалити і їх. `ready` друкується лише після обох
  if (testProvider() === "postgres") {
    const tag = runTag()
    await nodeExec(
      "docker",
      [
        "run",
        "-d",
        "--name",
        interruptContainerName(tag),
        "--label",
        `simetra-run=${tag}`,
        "--label",
        "simetra-stack=postgres",
        // Образ локальний (його збирає `db:pg:start`): без нього прогін має
        // впасти, а не тягнути щось із реєстру
        "--pull",
        "never",
        stackPostgresImage(),
        "sleep",
        "infinity",
      ],
      { timeoutMs: 30_000 }
    )
    await createRunBucket(tag, testStack(), fetch)
  }
}

async function worker(): Promise<void> {
  // Без живого батька воркер створював би бази безкінечно — виходить сам
  process.on("disconnect", () => process.exit(1))
  for (let created = 0; ; created++) {
    await asSuperuser((client) =>
      client.query(
        `CREATE DATABASE ${client.escapeIdentifier(testDatabaseName("interrupt_worker"))}`
      )
    )
    if (created === 0) process.send?.("created")
    await new Promise((resolve) => setTimeout(resolve, WORKER_PAUSE_MS))
  }
}

async function sleepWorker(): Promise<void> {
  process.on("disconnect", () => process.exit(1))
  // Ім'я з'єднанню не задаємо: тег мусить дійти через успадкований
  // `PGAPPNAME`, як до з'єднань тестів і designer
  const client = new pg.Client({ connectionString: testDatabaseUrl() })
  await client.connect()
  process.send?.("connected")
  await client.query(`SELECT pg_sleep(${SLEEP_SECONDS})`)
}

async function asSuperuser<T>(fn: (client: pg.Client) => Promise<T>) {
  const client = new pg.Client({ connectionString: testSuperuserUrl() })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

const [arg, mode, lockPath] = process.argv.slice(2)
await (arg === "--worker"
  ? worker()
  : arg === "--sleep-worker"
    ? sleepWorker()
    : main(arg, mode === "--sleep" ? lockPath : undefined))
