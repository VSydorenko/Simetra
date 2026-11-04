import { randomUUID } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import pg from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { compile } from "simetra/compiler"
import { PLATFORM_ROLES, RIGHTS_MAINTENANCE_SETTING } from "simetra/model"
import { desiredForApply } from "simetra/schema"
import { readRoleOf } from "simetra/server"
import {
  GAUGE_TABLE,
  GAUGE_WRITER_ID,
  policyDomain,
  runtimeValuesLayer,
  signUp,
} from "../../../simetra/test/support"
import {
  inTarget,
  seedMarker,
  throughPoolerAs,
  withRuntimeLogin,
} from "./support/db"

/**
 * Спайк П0 (а), крок 8 — лише в спайк-гілці. Зібрані host-и (`SPIKE_HOSTS`:
 * JSON `[{ dir, preset }]`) запускаються проти тіні з моделлю й тегованою
 * роллю входу — напряму й через Supavisor у режимі транзакцій. Сторінка
 * `/tx` host-а виконує команду через `simetra/server` і повертає, що бачила
 * транзакція на своєму з'єднанні. Результат — `SPIKE_RESULT_OUT`.
 */

const hosts: { dir: string; preset: string }[] = JSON.parse(
  process.env.SPIKE_HOSTS ?? "[]"
)
const REQUEST_ROLE = readRoleOf("supabase")!

interface Actor {
  org: string
  user: string
}

async function seedActor(owner: pg.Client): Promise<Actor> {
  const org = randomUUID()
  const member = randomUUID()
  await owner.query("BEGIN")
  const user = await signUp(owner)
  await owner.query("SELECT set_config($1, 'on', true)", [
    RIGHTS_MAINTENANCE_SETTING,
  ])
  await owner.query("INSERT INTO public.organization (id) VALUES ($1)", [org])
  await owner.query(
    "INSERT INTO public.org_member (id, org_id, user_id) VALUES ($1, $2, $3)",
    [member, org, user]
  )
  await owner.query(
    "INSERT INTO public.org_role_assignments (id, org_id, subject, archetype) VALUES ($1, $2, $3, $4)",
    [randomUUID(), org, member, GAUGE_WRITER_ID]
  )
  await owner.query("SET CONSTRAINTS ALL IMMEDIATE")
  await owner.query("COMMIT")
  return { org, user }
}

interface Env {
  me: Actor
  other: Actor
  login: string
  owner: pg.Client
}

function heldEnv() {
  let release: (() => void) | undefined
  let held: Promise<void> | undefined
  return {
    open: async (): Promise<Env> => {
      const result = await compile(policyDomain(runtimeValuesLayer()))
      expect(result.diagnostics).toEqual([])
      const model = result.model!
      const desired = await desiredForApply(model)
      const released = new Promise<void>((r) => (release = r))
      let loaded: ((env: Env) => void) | undefined
      const ready = new Promise<Env>((r) => (loaded = r))
      held = inTarget(desired.sql, desired.scope, async (url) => {
        const owner = new pg.Client({ connectionString: url })
        await owner.connect()
        try {
          await seedMarker(owner, model.hash)
          const me = await seedActor(owner)
          const other = await seedActor(owner)
          await withRuntimeLogin(
            url,
            [PLATFORM_ROLES.command, REQUEST_ROLE],
            async (login) => {
              loaded?.({ me, other, login, owner })
              await released
            },
            "spike_p0a"
          )
        } finally {
          await owner.end()
        }
      })
      return Promise.race([
        ready,
        held.then(() => {
          throw new Error("target closed before the scenario")
        }),
      ])
    },
    close: async () => {
      release?.()
      await held
    },
  }
}

interface Probe {
  id: string
  user: string
  author: Record<string, string>
  inTx: {
    role?: string
    claimsSub?: string
    pid?: string
    hookUser?: string
    deferPath?: string
  }
  next: { role: string; claims: unknown; pid: string }
  instance: string
  startedAt: number
  respondedAt: number
}

const decode = (html: string, attr: string): unknown => {
  const raw = new RegExp(`data-${attr}="p0a">([^<]*)<`).exec(html)?.[1]
  if (!raw) throw new Error(`no data-${attr} in ${html.slice(0, 800)}`)
  return JSON.parse(
    raw
      .replaceAll("&quot;", '"')
      .replaceAll("&#x27;", "'")
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&amp;", "&")
  )
}

async function probe(
  port: number,
  actor: Actor,
  delay: number,
  after: number
): Promise<{ status: number; body: Probe; ms: number }> {
  const started = Date.now()
  const url = `http://127.0.0.1:${port}/tx?user=${actor.user}&org=${actor.org}&delay=${delay}&after=${after}`
  const response = await fetch(url)
  const html = await response.text()
  const ms = Date.now() - started
  if (response.status !== 200)
    throw new Error(`/tx ${response.status}: ${html.slice(0, 1500)}`)
  return { status: response.status, body: decode(html, "tx") as Probe, ms }
}

async function afterEntries(
  port: number
): Promise<{ id: string; at: number }[]> {
  const html = await (await fetch(`http://127.0.0.1:${port}/after`)).text()
  return (decode(html, "after") as { entries: { id: string; at: number }[] })
    .entries
}

describe.skipIf(!hosts.length)(
  "spike P0 (a): command transaction on host presets",
  () => {
    const target = heldEnv()
    let env: Env
    const results: Record<string, unknown>[] = []

    beforeAll(async () => {
      env = await target.open()
    }, 180_000)
    afterAll(async () => {
      if (process.env.SPIKE_RESULT_OUT)
        writeFileSync(
          process.env.SPIKE_RESULT_OUT,
          JSON.stringify(results, null, 2)
        )
      await target.close()
    }, 60_000)

    for (const host of hosts) {
      for (const mode of ["direct", "pooler"] as const) {
        it(`${host.dir.split("/").at(-1)} · ${mode}`, async () => {
          const { startHost } = await import(
            join(
              import.meta.dirname,
              "../../../../spike/p0-a/scripts/serve.mjs"
            )
          )
          const loginRole = new URL(env.login).username
          const databaseUrl =
            mode === "direct" ? env.login : throughPoolerAs(env.login)
          const port = 4900 + Math.floor(Math.random() * 90)
          const server = await startHost(host.dir, host.preset, port, {
            DATABASE_URL: databaseUrl,
            POOL_MAX: "4",
          })
          const record: Record<string, unknown> = {
            host: host.dir.split("/").at(-1),
            preset: host.preset,
            mode,
          }
          try {
            // Прогрів: перший запит створює рантайм (звірка хеша й членства).
            await probe(port, env.me, 0, 0)

            // 1. Два паралельні запити різних користувачів — транзакції перекриваються.
            const [a, b] = await Promise.all([
              probe(port, env.me, 800, 0),
              probe(port, env.other, 800, 0),
            ])
            const overlap =
              a.body.startedAt < b.body.respondedAt &&
              b.body.startedAt < a.body.respondedAt
            record.parallel = { a: a.body, b: b.body, overlap }
            for (const [r, actor] of [
              [a.body, env.me],
              [b.body, env.other],
            ] as const) {
              expect(r.inTx.role).toBe(PLATFORM_ROLES.command)
              expect(r.inTx.claimsSub).toBe(actor.user)
              expect(r.inTx.hookUser).toBe(actor.user)
            }
            expect(overlap).toBe(true)
            if (mode === "direct")
              expect(a.body.inTx.pid).not.toBe(b.body.inTx.pid)

            // 2. Роль і claims не переходять у наступну транзакцію з'єднання.
            for (const r of [a.body, b.body]) {
              expect(r.next.role).toBe(loginRole)
              expect(r.next.claims ?? "").toBe("")
            }

            // 3. `afterCommit` через `waitUntil` — після відповіді.
            const AFTER = 1500
            const c = await probe(port, env.me, 0, AFTER)
            expect(c.body.inTx.deferPath).toBe("request.waitUntil")
            expect(c.ms).toBeLessThan(AFTER)
            const beforeDone = (await afterEntries(port)).some(
              (e) => e.id === c.body.id
            )
            let entry: { id: string; at: number } | undefined
            for (let i = 0; i < 40 && !entry; i += 1) {
              await new Promise((r) => setTimeout(r, 100))
              entry = (await afterEntries(port)).find((e) => e.id === c.body.id)
            }
            record.afterCommit = {
              httpMs: c.ms,
              respondedAt: c.body.respondedAt,
              ranAt: entry?.at,
              deferPath: c.body.inTx.deferPath,
              beforeDone,
            }
            expect(beforeDone).toBe(false)
            expect(entry).toBeDefined()
            expect(entry!.at).toBeGreaterThan(c.body.respondedAt)
            record.ok = true
          } catch (error) {
            record.ok = false
            record.error = String(error).slice(0, 2000)
            throw error
          } finally {
            server.stop()
            record.logs = server
              .logs()
              .split("\n")
              .filter((l: string) => /P0A_|HARNESS_|Error|error/.test(l))
              .slice(-20)
            results.push(record)
            // Бекенди ролі входу завершує `withRuntimeLogin`; тут — лише рядки проби.
            await env.owner
              .query(
                `DELETE FROM public.${GAUGE_TABLE} WHERE org_id = ANY($1)`,
                [[env.me.org, env.other.org]]
              )
              .catch(() => undefined)
          }
        }, 120_000)
      }
    }
  }
)

// Перевірка, що хости спайку взагалі передано, — інакше файл мовчки зелений.
it.skipIf(hosts.length > 0 || !process.env.SPIKE_RESULT_OUT)(
  "spike P0 (a): SPIKE_HOSTS is set",
  () => {
    expect(readFileSync).toBeDefined()
    throw new Error("SPIKE_RESULT_OUT without SPIKE_HOSTS")
  }
)
