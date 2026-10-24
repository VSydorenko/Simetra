import { randomUUID } from "node:crypto"
import pg from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { compile } from "simetra/compiler"
import { engineScope, renderDesiredState } from "simetra/schema"
import { CHECKLIST_TABLE, policyDomain } from "../../../simetra/test/support"
import { inTarget } from "./support/db"

/**
 * Блокування тригерів копій носіїв (спека прав §5.2, Р2a2-7, Р2a2-17): чи
 * чекає вставка рядка ТЧ на блокування власника і чи не дають одночасні
 * `UPDATE` рядка ТЧ і власника взаємоблокування, вирішує Postgres — це
 * властивість двох сесій. Обидві сесії бачать лише закомічене, тож засів
 * комітиться — у тіні двигуна (`inTarget`), яку порт прибирає після опису.
 */

/** Сесія на базі цілі; закриває її той, хто відкрив. */
async function session(url: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  return client
}

/** Код помилки Postgres запиту або `undefined`, якщо запит пройшов. */
const errorCode = (pending: Promise<unknown>) =>
  pending.then(
    () => undefined,
    (e: { code?: string }) => e.code
  )

/**
 * Ціль `policyDomain()`, відкрита на весь опис (одне розгортання на опис):
 * `inTarget` тримає тінь, доки `close` не відпустить колбек.
 */
function heldTarget() {
  let release: (() => void) | undefined
  let held: Promise<void> | undefined
  return {
    open: async (): Promise<string> => {
      const result = await compile(policyDomain())
      expect(result.diagnostics).toEqual([])
      const model = result.model!
      const released = new Promise<void>((resolve) => (release = resolve))
      let loaded: ((url: string) => void) | undefined
      const ready = new Promise<string>((resolve) => (loaded = resolve))
      held = inTarget(
        renderDesiredState(model).sql,
        (await engineScope(model)).scope,
        async (url) => {
          loaded?.(url)
          await released
        }
      )
      // Тінь, що не завантажилась, завершує `held` раніше за `ready`
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

describe("carrier copy locks", () => {
  const target = heldTarget()
  let url = ""
  const ids = {
    org: randomUUID(),
    m1: randomUUID(),
    m2: randomUUID(),
    task: randomUUID(),
    row: randomUUID(),
  }

  beforeAll(async () => {
    url = await target.open()
    const owner = await session(url)
    try {
      await owner.query("INSERT INTO public.organization (id) VALUES ($1)", [
        ids.org,
      ])
      for (const member of [ids.m1, ids.m2]) {
        await owner.query(
          "INSERT INTO public.org_member (id, org_id) VALUES ($1, $2)",
          [member, ids.org]
        )
      }
      await owner.query(
        "INSERT INTO public.task (id, org_id, date, assignee_id) VALUES ($1, $2, now(), $3)",
        [ids.task, ids.org, ids.m2]
      )
      await owner.query(
        `INSERT INTO public.${CHECKLIST_TABLE} (id, org_id, parent_id, line_number, note) VALUES ($1, $2, $3, 1, 'a')`,
        [ids.row, ids.org, ids.task]
      )
    } finally {
      await owner.end()
    }
  }, 60_000)

  afterAll(() => target.close(), 60_000)

  // `FOR SHARE` виведення копії конфліктує з блокуванням `UPDATE` власника:
  // вставка не прочитає носія, який змінює незакомічена транзакція. Власника
  // тримає `FOR NO KEY UPDATE`: він сумісний з `FOR KEY SHARE` перевірки FK
  // рядка ТЧ, тож чекання доводить саме `FOR SHARE` тригера, а не FK.
  it("inserting a tabular row waits for the owner row lock", async () => {
    const first = await session(url)
    const second = await session(url)
    try {
      await first.query("BEGIN")
      await first.query(
        "SELECT id FROM public.task WHERE id = $1 FOR NO KEY UPDATE",
        [ids.task]
      )
      await second.query("SET lock_timeout = '200ms'")
      // Передумова: блокування FK (`FOR KEY SHARE`) власника вільне
      expect(
        await errorCode(
          second.query(
            "SELECT id FROM public.task WHERE id = $1 FOR KEY SHARE",
            [ids.task]
          )
        )
      ).toBeUndefined()
      expect(
        await errorCode(
          second.query(
            `INSERT INTO public.${CHECKLIST_TABLE} (org_id, parent_id, line_number) VALUES ($1, $2, 2)`,
            [ids.org, ids.task]
          )
        )
      ).toBe("55P03")
      await first.query("ROLLBACK")
    } finally {
      await first.end()
      await second.end()
    }
  })

  // `UPDATE` рядка ТЧ без зміни зв'язку власника не блокує, тож поширення
  // від власника лише чекає на рядок ТЧ, а не замикає коло.
  it("updating a tabular row and its owner at once does not deadlock", async () => {
    const first = await session(url)
    const second = await session(url)
    try {
      const { rows } = await second.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid"
      )
      const secondPid = rows[0]!.pid
      await second.query("BEGIN")
      await second.query(
        "SELECT id FROM public.task WHERE id = $1 FOR UPDATE",
        [ids.task]
      )
      await first.query("BEGIN")
      await first.query("SET LOCAL lock_timeout = '2s'")
      // Під блокуванням власника на кожному `UPDATE` рядка ТЧ тут був би `55P03`
      expect(
        await errorCode(
          first.query(
            `UPDATE public.${CHECKLIST_TABLE} SET note = 'x' WHERE id = $1`,
            [ids.row]
          )
        )
      ).toBeUndefined()
      const propagated = errorCode(
        second.query("UPDATE public.task SET assignee_id = $1 WHERE id = $2", [
          ids.m1,
          ids.task,
        ])
      )
      // Друга сесія має справді чекати на рядок ТЧ першої, перш ніж та
      // закомітить: `pg_blocking_pids` читає менеджер блокувань наживо
      for (let waited = 0; ; waited += 50) {
        const blocking = await first.query<{ n: number }>(
          "SELECT cardinality(pg_blocking_pids($1)) AS n",
          [secondPid]
        )
        if (blocking.rows[0]!.n > 0) break
        if (waited > 10_000) throw new Error("the owner update never waited")
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      await first.query("COMMIT")
      expect(await propagated).toBeUndefined()
      await second.query("COMMIT")
      const copy = await first.query<{ assignee_id: string; note: string }>(
        `SELECT assignee_id, note FROM public.${CHECKLIST_TABLE} WHERE id = $1`,
        [ids.row]
      )
      expect(copy.rows).toEqual([{ assignee_id: ids.m1, note: "x" }])
    } finally {
      await first.end()
      await second.end()
    }
  })
})
