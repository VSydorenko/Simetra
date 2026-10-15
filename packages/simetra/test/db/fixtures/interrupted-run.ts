// Дочірній процес `interrupt.db.test.ts`: відтворює головний процес DB-прогону
// з власним тегом. Вкладений vitest не підходить — він узяв би замок стеку,
// який уже тримає зовнішній прогін, тож фікстура ставить той самий обробник
// сигналу, що й `stack-guard`, і створює об'єкти так, як їх створюють тести.
//
// `node --import tsx interrupted-run.ts <тег>` — головний процес;
// `… --worker` — «воркер», що безперервно створює тегові бази.
import { fork } from "node:child_process"
import { fileURLToPath } from "node:url"
import pg from "pg"
import {
  RUN_TAG_ENV,
  SHADOW_PREFIX,
  shadowSuffix,
  testDatabaseName,
  testRoleName,
  testSuperuserUrl,
} from "../connection"
import { installInterruptCleanup } from "../interrupt"

// Запобіжник, якщо тест не надішле сигналу (упав чи сам був убитий): фікстура
// перериває себе тим самим шляхом, тож не висить і не лишає тегових об'єктів
const SELF_INTERRUPT_MS = 120_000
const WORKER_PAUSE_MS = 200

async function main(tag: string | undefined): Promise<void> {
  if (tag === undefined || !/^[0-9a-z]{6}$/.test(tag))
    throw new Error("Usage: interrupted-run.ts <run tag> | --worker")
  process.env[RUN_TAG_ENV] = tag
  installInterruptCleanup({ tag, release: () => {} })

  // Чужа на вигляд тінь: без тегу, тож прибиральник не сміє її торкнутися
  const foreign = `${SHADOW_PREFIX}${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  await asSuperuser(async (client) => {
    const id = (name: string): string => client.escapeIdentifier(name)
    await client.query(
      `CREATE DATABASE ${id(testDatabaseName("interrupt_copy"))}`
    )
    await client.query(`CREATE DATABASE ${id(SHADOW_PREFIX + shadowSuffix())}`)
    await client.query(`CREATE ROLE ${id(testRoleName("interrupt_owner"))}`)
    await client.query(`CREATE DATABASE ${id(foreign)}`)
  })

  // Воркер успадковує env (тег) і execArgv (`--import tsx`); `ready` — лише
  // після його першої бази, щоб сигнал гарантовано застав воркер у роботі
  const worker = fork(fileURLToPath(import.meta.url), ["--worker"])
  await new Promise<void>((resolve, reject) => {
    worker.once("message", () => resolve())
    worker.once("exit", (code) =>
      reject(new Error(`The worker exited early with code ${code}`))
    )
  })
  process.stdout.write(`ready ${foreign} ${worker.pid}\n`)
  setTimeout(() => process.kill(process.pid, "SIGTERM"), SELF_INTERRUPT_MS)
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

async function asSuperuser<T>(fn: (client: pg.Client) => Promise<T>) {
  const client = new pg.Client({ connectionString: testSuperuserUrl() })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

const arg = process.argv[2]
await (arg === "--worker" ? worker() : main(arg))
