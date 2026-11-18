// Склад збірки (спека П4-D §8.3): production-збірка шаблону не несе ні
// секретів у клієнтських асетах, ні шляху dev-користувача, ні тестових входів.
// Кожна перевірка має негативний контроль — збірку з навмисним витоком: гейт,
// який нічого не знаходить, нічого й не довів би.
import { join } from "node:path"
import { randomBytes } from "node:crypto"
import { appendFile, mkdir, writeFile } from "node:fs/promises"
import { afterAll, describe, expect, it } from "vitest"
import {
  copyTemplate,
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
]

async function leaks(dir: string) {
  return {
    publicSentinels: await findNeedles(
      join(dir, ".output/public"),
      Object.values(SENTINELS)
    ),
    markers: await findNeedles(join(dir, ".output"), MARKERS),
  }
}

describe("production build content", () => {
  it("has no sentinel in the client assets and no marker anywhere", async () => {
    const dir = await copyTemplate("clean")
    await viteBuild(dir, SENTINELS)
    expect(await leaks(dir)).toEqual({ publicSentinels: {}, markers: {} })
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
})
