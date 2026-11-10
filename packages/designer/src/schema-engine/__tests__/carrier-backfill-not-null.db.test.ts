import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import { canonicalSnapshot } from "simetra/compiler"
import { buildPlan, executePlan } from "simetra/schema"
import {
  COMMENT_FILE,
  COMMENT_TABLE,
  policyDomain,
  refAttribute,
  uuid,
} from "../../../../simetra/test/support"
import { query } from "../../__tests__/support/db"
import {
  carrierTables,
  compiledFiles,
  dbs,
  engine,
  establish,
  inModelTarget,
  one,
  planned,
  ref,
  writer,
} from "./build-plan.support"

/**
 * І20 на живих рядках. Тест живе в окремому файлі, а не поруч із кроками
 * копій носіїв: у спільному `describe.concurrent` три важкі тести ділять
 * один потік Node, і він з'їдав CPU тесту промоції (26 с наодинці → 39 с).
 */
describe.concurrent("carrier copy steps ordering on live rows", () => {
  it("a NOT NULL fill runs before the carrier trigger a later step creates", async () => {
    // І20 (платформна спека §6.6, спека промоції §7.2): коментар отримує
    // власність — носій, чий тригер створює пізніший крок плану, — і
    // обов'язковий `note` з default. Перевірка тригерів Р4а не вимагає
    // тригера, якого ще немає, а копію пише крок копій після блоку двигуна.
    // Двигун знімає тригер механіки до заповнення й створює пізніше, тож
    // версію рядка підвищує блок `versions`: таблиця заповнення для нього
    // переписана
    const note = (over: Record<string, unknown> = {}) => ({
      id: uuid(6905),
      name: "note",
      physicalName: "note",
      type: "String",
      length: 50,
      ...over,
    })
    const task = refAttribute(6051, "task", "task_id", ref("Document", "Task"))
    const before = await compiledFiles(
      policyDomain({
        [COMMENT_FILE]: { ownership: undefined, attributes: [task, note()] },
      })
    )
    const after = await compiledFiles(
      policyDomain({
        [COMMENT_FILE]: {
          attributes: [task, note({ required: true, defaultValue: "n/a" })],
        },
      })
    )
    const id = {
      org: randomUUID(),
      u1: randomUUID(),
      task: randomUUID(),
      comment: randomUUID(),
    }
    await inModelTarget(after, async (url) => {
      await establish(url, before)
      await query(
        url,
        `insert into public.organization (id) values ('${id.org}');
         insert into public.org_member (id, org_id) values ('${id.u1}', '${id.org}');
         insert into public.task (id, org_id, date, assignee_id)
           values ('${id.task}', '${id.org}', now(), '${id.u1}');
         insert into public.${COMMENT_TABLE} (id, org_id, task_id)
           values ('${id.comment}', '${id.org}', '${id.task}');`
      )
      const version = async () =>
        BigInt(
          (
            await one<{ version: string }>(
              url,
              `select version::text from public.${COMMENT_TABLE} where id = $1`,
              [id.comment]
            )
          ).version
        )
      const was = await version()
      const artifact = planned(
        await buildPlan(engine, dbs, after, { target: { url } }, [])
      )
      const fills = artifact.steps.filter((s) => s.origin === "backfill")
      expect(fills.map((s) => s.backfill)).toEqual([
        expect.objectContaining({
          table: { schema: "public", name: COMMENT_TABLE },
          column: "note",
          rowsAtPlan: 1,
          permission: false,
        }),
      ])
      // Тригер носіїв коментаря створює крок після заповнення: інакше випадок
      // не той, який доводить тест
      const created = artifact.steps.findIndex((s) =>
        s.produced.some(
          (r) =>
            r.kind === "trigger" &&
            r.table === COMMENT_TABLE &&
            r.name === `${COMMENT_TABLE}_simetra_carriers`
        )
      )
      expect(created).toBeGreaterThan(artifact.steps.indexOf(fills[0]!))
      expect(carrierTables(artifact)).toContain(COMMENT_TABLE)
      const outcome = await executePlan(writer, { url }, artifact, {
        mode: "apply",
        planHash: artifact.planHash,
        allow: artifact.requiredPermissions,
        snapshot: canonicalSnapshot(after),
      })
      expect(outcome.diagnostics).toEqual([])
      expect(outcome).toMatchObject({
        status: "committed",
        backfills: [{ step: fills[0]!.id, rows: 1 }],
      })
      expect(
        await one(
          url,
          `select note, task_id_assignee_id as copy from public.${COMMENT_TABLE} where id = $1`,
          [id.comment]
        )
      ).toEqual({ note: "n/a", copy: id.u1 })
      expect(await version()).toBeGreaterThan(was)
    })
  })
})
