// Склад збірки (спека П4-D §8.3): production-збірка шаблону не несе ні
// секретів у клієнтських асетах, ні шляху dev-користувача, ні тестових входів.
// Кожна перевірка має негативний контроль — збірку з навмисним витоком: гейт,
// який нічого не знаходить, нічого й не довів би.
import { join } from "node:path"
import { randomBytes } from "node:crypto"
import { appendFile, mkdir, writeFile } from "node:fs/promises"
import { afterAll, describe, expect, it } from "vitest"
import { MAIL_CAPTURE_MARKER } from "./mail-capture"
import {
  copyTemplate,
  copyTemplateWithMailCapture,
  findNeedles,
  removeCopies,
  viteBuild,
} from "./template-copy"

afterAll(removeCopies)

const tag = randomBytes(6).toString("hex")
/** Значення змінних збірки: сентинели, які не мають потрапити в клієнтські асети. */
const SENTINELS = {
  SIMETRA_RUNTIME_DATABASE_URL: `postgresql://sentinel-runtime-${tag}:pw@sentinel.test/db`,
  SIMETRA_AUTH_DATABASE_URL: `postgresql://sentinel-auth-${tag}:pw@sentinel.test/db`,
  BETTER_AUTH_SECRET: `sentinel-secret-${tag}`,
}

/** Маркери, яких у production-збірці бути не може. */
const MARKERS = [
  // рядкова стала `dev-user.mjs`: за нею видно, що скрипт потрапив у збірку
  "simetra-dev-user-script",
  "simetra/server/testing",
  "simetra/data/testing",
  "countingTransport",
  "__oracle",
  // захоплювач пошти e2e (Р-D5-5): лише копія з підміненим `mail.ts`
  MAIL_CAPTURE_MARKER,
]

/**
 * Серверний код, якого в клієнтських асетах бути не може (клієнтський граф
 * імпортує `data-transport.ts`, тож серверні імпорти можуть протекти разом із ним). Маркери — рядки, що переживають мініфікацію:
 * назва змінної пулу, рядок журналу обробника даних, текст помилки драйвера `pg` і
 * назва секрету Better Auth.
 */
const SERVER_MARKERS = [
  "SIMETRA_RUNTIME_DATABASE_URL",
  "[simetra] data handler",
  "Connection terminated unexpectedly",
  "BETTER_AUTH_SECRET",
]

/**
 * Рядки модуля `centrifuge`, що переживають мініфікацію (літерали SDK). Сервер
 * сигналів не збирає (І8 D5): модуль живе лише в клієнтському графі.
 */
const CENTRIFUGE_MARKERS = [
  "centrifuge.debug",
  "__centrifuge_debug:connect_frame_sent",
]

async function leaks(dir: string) {
  return {
    publicSentinels: await findNeedles(
      join(dir, ".output/public"),
      Object.values(SENTINELS)
    ),
    markers: await findNeedles(join(dir, ".output"), MARKERS),
    centrifugeInServer: await findNeedles(
      join(dir, ".output/server"),
      CENTRIFUGE_MARKERS
    ),
    serverInClient: await findNeedles(
      join(dir, ".output/public"),
      SERVER_MARKERS
    ),
  }
}

describe("production build content", () => {
  it("has no sentinel in the client assets and no marker anywhere", async () => {
    const dir = await copyTemplate("clean")
    await viteBuild(dir, SENTINELS)
    expect(await leaks(dir)).toEqual({
      publicSentinels: {},
      markers: {},
      centrifugeInServer: {},
      serverInClient: {},
    })
    // Позитивний контроль маркера: у клієнтських асетах `centrifuge` є, тож
    // порожній серверний результат означає відсутність модуля, а не сліпий маркер
    const client = await findNeedles(
      join(dir, ".output/public"),
      CENTRIFUGE_MARKERS
    )
    expect([...new Set(Object.values(client).flat())].sort()).toEqual(
      [...CENTRIFUGE_MARKERS].sort()
    )
  })

  it("the centrifuge check finds the module in the server output (negative control)", async () => {
    const dir = await copyTemplate("centrifuge-in-server")
    // Серверний модуль, що тягне `centrifuge`, у вході сервера
    await writeFile(
      join(dir, "src/server/leak-centrifuge.ts"),
      `import { Centrifuge } from "centrifuge"
console.log(typeof Centrifuge)
`
    )
    await appendFile(
      join(dir, "src/server.ts"),
      `import "./server/leak-centrifuge"\n`
    )
    await viteBuild(dir, SENTINELS)
    const found = await leaks(dir)
    expect(
      [...new Set(Object.values(found.centrifugeInServer).flat())].sort()
    ).toEqual([...CENTRIFUGE_MARKERS].sort())
  })

  it("the server-in-client check finds a server import in the client graph (negative control)", async () => {
    const dir = await copyTemplate("server-in-client")
    // Клієнтський маршрут тягне серверний модуль із пулом і каталогом рантайму
    await mkdir(join(dir, "src/routes"), { recursive: true })
    await writeFile(
      join(dir, "src/routes/server-leak.tsx"),
      `import { createFileRoute } from "@tanstack/react-router"
import { getDataHandler, serverHash } from "../server/runtime"
import { verifySession } from "../server/auth"
export const Route = createFileRoute("/server-leak")({
  component: () => <p>{serverHash}{typeof verifySession}{typeof getDataHandler}</p>,
})
`
    )
    await viteBuild(dir, SENTINELS)
    const found = await leaks(dir)
    // Кожен маркер, а не будь-який: пропущений маркер означав би сліпу перевірку
    expect(
      [...new Set(Object.values(found.serverInClient).flat())].sort()
    ).toEqual([...SERVER_MARKERS].sort())
  })

  it("the check finds a leak (negative control)", async () => {
    const dir = await copyTemplate("leak")
    // Секрети літералом у клієнтському маршруті...
    await mkdir(join(dir, "src/routes"), { recursive: true })
    await writeFile(
      join(dir, "src/routes/leak.tsx"),
      `import { createFileRoute } from "@tanstack/react-router"
export const Route = createFileRoute("/leak")({
  component: () => <p>{${JSON.stringify(Object.values(SENTINELS).join(" "))}}</p>,
})
`
    )
    // ...і скрипт dev-користувача, імпортований з `src/`
    await writeFile(
      join(dir, "src/server/leak-dev-user.ts"),
      `import { DEV_USER_MARKER } from "../../scripts/dev-user.mjs"
console.log(DEV_USER_MARKER)
`
    )
    await appendFile(
      join(dir, "src/server.ts"),
      `import "./server/leak-dev-user"\n`
    )
    await viteBuild(dir, SENTINELS)
    const found = await leaks(dir)
    const publicHits = Object.values(found.publicSentinels).flat()
    for (const sentinel of Object.values(SENTINELS))
      expect(publicHits).toContain(sentinel)
    expect(Object.values(found.markers).flat()).toContain(
      "simetra-dev-user-script"
    )
  })

  it("the mail capturer is found in a copy with the replaced mail module (negative control)", async () => {
    const dir = await copyTemplateWithMailCapture("mail-capture")
    await viteBuild(dir, SENTINELS)
    const found = await leaks(dir)
    expect(Object.values(found.markers).flat()).toContain(MAIL_CAPTURE_MARKER)
  })
})
