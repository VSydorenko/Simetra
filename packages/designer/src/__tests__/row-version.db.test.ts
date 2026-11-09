import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import type { CompiledModel } from "simetra/compiler"
import type { PlanArtifact } from "simetra/schema"
import { attribute, uuid } from "../../../simetra/test/support"
import {
  applyArtifact,
  compiled,
  establish,
  EMPTY,
  inTarget,
  PARTY,
  party,
  plan,
  planned,
  useBuildPlanRoles,
} from "../schema-engine/__tests__/build-plan.support"
import { query } from "./support/db"

/**
 * Блок кроків `versions` на справжній базі (план → застосування з двигуном).
 * DB-рівень, бо пересоздану послідовність, максимум версій під замками й
 * `nextval` наступного запису вирішує Postgres, а не текст плану.
 */

useBuildPlanRoles()

const versionsOf = (artifact: PlanArtifact) =>
  artifact.steps.filter((s) => s.origin === "versions")

const epochOf = async (url: string) =>
  (
    await query<{ epoch: string }>(
      url,
      "select epoch::text from simetra.version_epoch"
    )
  )[0]!.epoch

const maxVersion = async (url: string) =>
  BigInt(
    (
      await query<{ v: string }>(
        url,
        "select max(version)::text as v from app.party"
      )
    )[0]!.v
  )

const nextValue = async (url: string) =>
  BigInt(
    (
      await query<{ v: string }>(
        url,
        "select nextval('simetra.row_version')::text as v"
      )
    )[0]!.v
  )

/** Рядки з версіями, виданими минулим життям послідовності. */
async function seedRows(url: string, versions: number[]): Promise<string[]> {
  const ids = versions.map(() => randomUUID())
  // Тригер механіки не бере значення клієнта: версії пишуться з вимкненими
  // користувацькими тригерами під власником
  await query(
    url,
    `insert into app.party (id) values ${ids.map((i) => `('${i}')`).join(", ")};
     alter table app.party disable trigger user;
     ${ids.map((id, i) => `update app.party set version = ${versions[i]} where id = '${id}';`).join("\n")}
     alter table app.party enable trigger user;`
  )
  return ids
}

/** Видалення послідовності — дрейф: застосування дозволяє його явно. */
async function dropSequence(url: string): Promise<void> {
  await query(url, "drop sequence simetra.row_version")
}

async function reapply(
  url: string,
  model: CompiledModel
): Promise<PlanArtifact> {
  const artifact = planned(await plan(url, model))
  await applyArtifact(url, artifact, model)
  return artifact
}

describe.concurrent("versions block on live rows", () => {
  it("a dropped sequence is reseeded above the highest version and the epoch changes", async () => {
    const model = await compiled({ [PARTY]: party() })
    await inTarget(EMPTY, async (url) => {
      await establish(url, model)
      const ids = await seedRows(url, [41, 1, 9_000])
      const epoch = await epochOf(url)
      await dropSequence(url)

      const artifact = await reapply(url, model)
      const steps = versionsOf(artifact)
      expect(steps.map((s) => s.class)).toEqual([
        "validationScan",
        "catalogOnly",
      ])
      expect(artifact.requiredPermissions).toContain("drift")

      // Наступне значення вище за найбільшу видану версію
      expect(await nextValue(url)).toBeGreaterThan(9_000n)
      // Видалений і створений знову ключ не повторює видану версію
      await query(url, "delete from app.party where id = $1", [ids[2]])
      await query(url, "insert into app.party (id) values ($1)", [ids[2]])
      const [again] = await query<{ version: string }>(
        url,
        "select version::text from app.party where id = $1",
        [ids[2]]
      )
      expect(BigInt(again!.version)).toBeGreaterThan(9_000n)
      // Епоха — новий UUID
      expect(await epochOf(url)).not.toBe(epoch)

      // Повторний план порожній, епоха та сама
      const stable = await epochOf(url)
      expect((await plan(url, model)).status).toBe("unchanged")
      expect(await epochOf(url)).toBe(stable)
    })
  })

  it("rows that all carry version 1 still get a next value above 1", async () => {
    const model = await compiled({ [PARTY]: party() })
    await inTarget(EMPTY, async (url) => {
      await establish(url, model)
      await seedRows(url, [1, 1, 1])
      await dropSequence(url)

      await reapply(url, model)
      expect(await maxVersion(url)).toBe(1n)
      expect(await nextValue(url)).toBeGreaterThan(1n)
    })
  })

  it("a base without the epoch row gets only the epoch and its plan is not empty", async () => {
    const model = await compiled({ [PARTY]: party() })
    await inTarget(EMPTY, async (url) => {
      await establish(url, model)
      await query(url, "delete from simetra.version_epoch")
      const artifact = planned(await plan(url, model))
      expect(versionsOf(artifact).map((s) => s.class)).toEqual(["catalogOnly"])
      await applyArtifact(url, artifact, model)
      expect(await epochOf(url)).toMatch(/^[0-9a-f-]{36}$/)
      expect((await plan(url, model)).status).toBe("unchanged")
    })
  })
})

describe.concurrent("versions of the columns the engine rewrites", () => {
  // Обробник підписки падає на `UPDATE`: якщо крок підвищення не вимкне
  // тригери користувача, застосування зірветься
  const HANDLER = `CREATE FUNCTION app.on_party() RETURNS trigger LANGUAGE plpgsql VOLATILE SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN RAISE EXCEPTION 'user trigger fired'; END IF;
  RETURN NEW;
END $$;`
  const amount = (scale: number) =>
    attribute("amount", {
      id: uuid(9301),
      type: "Numeric",
      precision: 12,
      scale,
    })
  const withScale = (scale: number) =>
    compiled({
      [PARTY]: party([amount(scale)]),
      "event-subscriptions/OnParty/OnParty.meta.json": {
        id: uuid(9302),
        kind: "EventSubscription",
        name: "OnParty",
        physicalName: "on_party",
        sources: [{ kind: "Catalog", name: "Party" }],
        event: "beforeWrite",
        handler: { schema: "app", name: "on_party" },
      },
      "sql/app/handlers.sql": HANDLER,
    })

  const rows = (url: string) =>
    query<{ id: string; version: string; updated_at: string; amount: string }>(
      url,
      "select id::text, version::text, updated_at::text, amount::text from app.party order by id"
    )

  // Значення цілі: звуження зі втратою відмовляє сторож типу
  // (`apply.type-narrowing`), тож рядки несуть цілі значення, а перепис
  // таблиці робить сама зміна масштабу
  it("a scale decrease raises the version of every row and leaves updated_at and user triggers alone", async () => {
    const before = await withScale(2)
    const after = await withScale(0)
    await inTarget(EMPTY, async (url) => {
      await establish(url, before)
      await query(
        url,
        `insert into app.party (id, amount) values
         ('${randomUUID()}', 1), ('${randomUUID()}', 2), ('${randomUUID()}', 3)`
      )
      const was = await rows(url)

      const artifact = planned(await plan(url, after))
      const bump = versionsOf(artifact).filter((s) => s.class === "dataStep")
      expect(bump.map((s) => s.sql)).toEqual([
        "UPDATE app.party SET version = GREATEST(nextval('simetra.row_version'), version + 1)",
      ])
      expect(bump[0]!.triggers!.map((t) => t.name)).toContain("on_party")
      await applyArtifact(url, artifact, after)

      const now = await rows(url)
      expect(now.map((r) => r.id)).toEqual(was.map((r) => r.id))
      now.forEach((row, i) => {
        expect(BigInt(row.version)).toBeGreaterThan(BigInt(was[i]!.version))
        expect(row.updated_at).toBe(was[i]!.updated_at)
      })
      expect(now.map((r) => r.amount)).toEqual(
        was.map((r) => String(Number(r.amount)))
      )
      // Тригери повернуто, а наступний запис знову підвищує версію
      expect(
        await query(
          url,
          "select count(*)::int as n from pg_trigger where tgrelid = 'app.party'::regclass and not tgisinternal and tgenabled <> 'O'"
        )
      ).toEqual([{ n: 0 }])
      expect((await plan(url, after)).status).toBe("unchanged")
    })
  })

  // Послідовність відстає від версій рядків (логічна реплікація чи ручний
  // `setval`): голий `nextval` дав би версію нижчу за видану; крок підвищення
  // йде за правилом тригера оновлення
  it("a lagging sequence does not lower the version of a rewritten row", async () => {
    const before = await withScale(2)
    const after = await withScale(0)
    await inTarget(EMPTY, async (url) => {
      await establish(url, before)
      await seedRows(url, [5_000, 7_000, 9_000])
      await query(url, "select setval('simetra.row_version', 10)")
      const was = await rows(url)

      await reapply(url, after)

      const now = await rows(url)
      expect(now.map((r) => r.id)).toEqual(was.map((r) => r.id))
      now.forEach((row, i) => {
        expect(BigInt(row.version)).toBeGreaterThan(BigInt(was[i]!.version))
      })
    })
  })
})
