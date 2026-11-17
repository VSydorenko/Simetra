import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { ESLint } from "eslint"
import { beforeAll, describe, expect, it } from "vitest"

// Негативні тести лінту споживача (спека П4-D §4.7): кожне правило має кейс
// «відмовляє» і парний кейс «дозволено», щоб правило не позеленіло порожнім.
const ROOT = fileURLToPath(new URL("..", import.meta.url))
const eslint = new ESLint({ cwd: ROOT })

// Літерал імені пакета оракула в цьому файлі зламав би тест дерева шаблону
const TEST_HOST = ["test", "host"].join("-")
const TESTING_ENTRY = `simetra/${"data"}/testing`

beforeAll(async () => {
  await eslint.lintText("", { filePath: join(ROOT, "src/router.tsx") })
}, 60_000)

type Group = "imports" | "syntax"
const RULES: Record<Group, string> = {
  imports: "@typescript-eslint/no-restricted-imports",
  syntax: "no-restricted-syntax",
}

/** Повідомлення правила; фатальна помилка розбору — виняток, а не порожній масив. */
async function lint(code: string, file: string, group: Group) {
  const [result] = await eslint.lintText(code, {
    filePath: join(ROOT, file),
  })
  const messages = result?.messages ?? []
  const broken = messages.filter((m) => m.fatal || m.ruleId === null)
  if (broken.length > 0)
    throw new Error(
      `${file}: lint did not run: ${broken.map((m) => m.message).join("; ")}`
    )
  return messages.filter((m) => m.ruleId === RULES[group]).map((m) => m.message)
}

async function expectRefused(
  group: Group,
  file: string,
  code: string,
  text: string
) {
  const messages = await lint(code, file, group)
  expect(messages, `${file}: ${code}`).toHaveLength(1)
  expect(messages[0]).toContain(text)
}

async function expectAllowed(group: Group, file: string, code: string) {
  expect(await lint(code, file, group), `${file}: ${code}`).toEqual([])
}

const use = (specifier: string) =>
  `import { probe } from "${specifier}"\nexport const used = probe\n`

describe("consumer lint", () => {
  it("lets a Postgres driver in only the runtime and auth pool modules", async () => {
    for (const driver of ["pg", "postgres", "@neondatabase/serverless"])
      await expectRefused(
        "imports",
        "src/routes/x.tsx",
        use(driver),
        "A Postgres driver"
      )
    await expectRefused(
      "imports",
      "src/server/data-fn.ts",
      use("pg"),
      "A Postgres driver"
    )
    for (const file of ["src/server/runtime.ts", "src/server/auth-db.ts"])
      await expectAllowed("imports", file, use("pg"))
    // Тип драйвера пул не відкриває, а `test/` і `scripts/` поза правилом
    await expectAllowed(
      "imports",
      "src/server/auth.ts",
      'import type { Pool } from "pg"\nexport type P = Pool\n'
    )
    await expectAllowed("imports", "test/x.db.test.ts", use("pg"))
    await expectAllowed("imports", "scripts/x.mjs", use("pg"))
  })

  it("lets only runtime.ts read the runtime DSN variable", async () => {
    const read =
      'export const url = process.env["SIMETRA_RUNTIME_DATABASE_URL"]'
    const dotted = "export const url = process.env.SIMETRA_RUNTIME_DATABASE_URL"
    const name = "export const name = `SIMETRA_RUNTIME_DATABASE_URL`"
    // Звернення через крапку літерала не має: його ловить рядкове ім'я
    // (`requiredEnv("…")`); сама крапка лишається гігієною коду-рев'ю
    for (const code of [read, name])
      await expectRefused(
        "syntax",
        "src/server/auth.ts",
        code,
        "SIMETRA_RUNTIME_DATABASE_URL"
      )
    await expectAllowed("syntax", "src/server/runtime.ts", read)
    await expectAllowed("syntax", "src/server/auth.ts", dotted)
  })

  it("forbids session SQL strings and templates outside runtime.ts", async () => {
    const cases = [
      'export const q = "SET ROLE simetra_command"',
      'export const q = "set role x"',
      "export const q = \"SELECT set_config('a', 'b', true)\"",
      'export const q = "simetra.environment"',
      'export const q = "request.jwt.claims"',
      "export const q = `SET ROLE ${role}`",
    ]
    for (const code of cases) {
      await expectRefused("syntax", "src/server/auth.ts", code, "Session SQL")
      await expectAllowed("syntax", "src/server/runtime.ts", code)
    }
    // `simetra/server` — не `simetra.`: імпорт пакета рядкового правила не чіпає
    await expectAllowed("syntax", "src/server/auth.ts", use("simetra/model"))
    await expectAllowed("syntax", "test/x.test.ts", cases[0]!)
  })

  it("forbids createRequire and a dynamic import with a non-literal argument", async () => {
    await expectRefused(
      "syntax",
      "src/server/auth.ts",
      'import { createRequire } from "node:module"\nexport const r = createRequire',
      "createRequire"
    )
    await expectRefused(
      "syntax",
      "src/server/auth.ts",
      'import * as m from "node:module"\nexport const r = m.createRequire(import.meta.url)',
      "createRequire"
    )
    for (const code of [
      "export const m = (name: string) => import(name)",
      "export const m = (name: string) => import(`./${name}`)",
    ])
      await expectRefused("syntax", "src/server/auth.ts", code, "literal")
    await expectAllowed(
      "syntax",
      "src/server/auth.ts",
      'export const m = () => import("./config")'
    )
    // Правило лише для `src/`
    await expectAllowed(
      "syntax",
      "scripts/x.mjs",
      "export const m = (name) => import(name)"
    )
  })

  it("keeps simetra/server inside src/server", async () => {
    for (const file of ["src/routes/x.tsx", "src/router.tsx", "src/client.tsx"])
      await expectRefused(
        "imports",
        file,
        use("simetra/server"),
        "src/server/**"
      )
    await expectRefused(
      "imports",
      "src/routes/x.tsx",
      use("simetra/server/internal"),
      "src/server/**"
    )
    for (const file of ["src/server/x.ts", "src/server.ts"])
      await expectAllowed("imports", file, use("simetra/server"))
    await expectAllowed("imports", "src/routes/x.tsx", use("simetra/model"))
  })

  it("lets the inProcess literal appear only in ssr-transport.ts", async () => {
    const property = "export const o = { inProcess: true }"
    const string = 'export const o = { "inProcess": true }'
    for (const code of [property, string]) {
      await expectRefused("syntax", "src/server/data-fn.ts", code, "inProcess")
      await expectRefused("syntax", "src/routes/x.tsx", code, "inProcess")
      await expectAllowed("syntax", "src/server/ssr-transport.ts", code)
    }
  })

  it("forbids createServerFn in ssr-transport.ts and router.tsx", async () => {
    const code =
      'import { createServerFn } from "@tanstack/react-start"\nexport const f = createServerFn({ method: "GET" })'
    for (const file of ["src/server/ssr-transport.ts", "src/router.tsx"]) {
      const messages = await lint(code, file, "syntax")
      // Імпорт дає кілька збігів ідентифікатора, виклик — ще один
      expect(messages.length, file).toBeGreaterThan(1)
      expect(messages[0]).toContain("createServerFn")
    }
    await expectAllowed("syntax", "src/server/session-fn.ts", code)
    await expectAllowed("syntax", "src/server/data-fn.ts", code)
  })

  it("lets only router.tsx import ssr-transport", async () => {
    for (const [file, specifier] of [
      ["src/server/data-fn.ts", "./ssr-transport"],
      ["src/routes/x.tsx", "../server/ssr-transport"],
      ["src/server.ts", "./server/ssr-transport"],
    ] as const)
      await expectRefused("imports", file, use(specifier), "src/router.tsx")
    await expectAllowed(
      "imports",
      "src/router.tsx",
      use("./server/ssr-transport")
    )
  })

  it("keeps the oracle package and testing entries out of the whole template", async () => {
    for (const file of [
      "src/server/x.ts",
      "test/x.test.ts",
      "scripts/x.mjs",
      "src/routes/x.tsx",
    ]) {
      await expectRefused("imports", file, use(TEST_HOST), "oracle")
      await expectRefused("imports", file, use(`${TEST_HOST}/oracle`), "oracle")
      await expectRefused("imports", file, use(TESTING_ENTRY), "testing")
    }
    await expectAllowed("imports", "test/x.test.ts", use("simetra/model"))
  })

  it("lets only the named points import #instrument", async () => {
    for (const file of [
      "src/routes/index.tsx",
      "src/server.ts",
      "src/server/auth.ts",
    ])
      await expectRefused("imports", file, use("#instrument"), "#instrument")
    for (const file of [
      "src/router.tsx",
      "src/client.tsx",
      "src/server/runtime.ts",
      "src/server/data-fn.ts",
    ])
      await expectAllowed("imports", file, use("#instrument"))
  })

  it("never lets src import a script, dev-user included", async () => {
    for (const specifier of [
      "../scripts/dev-user.mjs",
      "../../scripts/seed.mjs",
    ])
      await expectRefused(
        "imports",
        "src/server/auth.ts",
        use(specifier),
        "Scripts"
      )
    await expectAllowed(
      "imports",
      "test/x.test.ts",
      use("../scripts/dev-user.mjs")
    )
  })
})
