import { describe, expect, it } from "vitest"
import { compile, type CompiledModel } from "simetra/compiler"
import {
  policyDomain,
  profileLayer,
  superuserClient,
  uuid,
  type Layer,
} from "../../../simetra/test/support"
import { applyOn, planOn, withModelTarget } from "./support/db"

/**
 * План T2 умовного `publicRead` на справжньому apply дизайнера (план D1 §5,
 * інваріант 15; Р-D1-14). Причина DB-рівня: заповнення чернеток і копій ТЧ
 * виконує сама ціль під ролью apply, а крок «умовний → рядковий» двигун
 * будує з живої цілі — unit-тести бачать лише підставні дії.
 */

const NOTICE_FILE = "catalogs/Notice/Notice.meta.json"
const HEADER = "public.notice"
const SECTION = "public.notice_sites"

const sites = {
  id: uuid(9701),
  name: "sites",
  physicalName: "notice_sites",
  attributes: [
    {
      id: uuid(9702),
      name: "label",
      physicalName: "label",
      type: "String",
      length: 100,
    },
  ],
}

/** Модель з довідником «Повідомлення» у заданій формі `publicRead` і з ТЧ. */
async function model(
  publicRead: unknown,
  attributes: unknown[] = []
): Promise<CompiledModel> {
  const layer: Layer = {
    [NOTICE_FILE]: {
      id: uuid(9700),
      kind: "Catalog",
      name: "Notice",
      physicalName: "notice",
      kindLabel: "notice",
      scope: "none",
      publicRead,
      attributes,
      tabularSections: [sites],
    },
  }
  const result = await compile(policyDomain(profileLayer(), layer))
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
  return result.model!
}

const database = (url: string) => new URL(url).pathname.slice(1)

describe("conditional publicRead on apply", () => {
  it("enabling the condition on a catalog with rows makes drafts and fills the section copies", async () => {
    const open = await model("anon")
    await withModelTarget(open, async (url) => {
      const client = await superuserClient(database(url))
      try {
        const id = "00000000-0000-4000-8000-000000009801"
        await client.query(`INSERT INTO ${HEADER} (id) VALUES ($1)`, [id])
        await client.query(
          `INSERT INTO ${SECTION} (id, parent_id, line_number, label) VALUES (gen_random_uuid(), $1, 1, 'a')`,
          [id]
        )
        const conditional = await model({ role: "anon", published: true })
        const applied = await applyOn(url, conditional)
        expect(applied.status).toBe("committed")
        // Наявний рядок — чернетка, а не відкритий рядок
        const header = await client.query(
          `SELECT published, deletion_mark FROM ${HEADER}`
        )
        expect(header.rows).toEqual([
          { published: false, deletion_mark: false },
        ])
        // Копії умови на рядку ТЧ заповнені значеннями шапки
        const copies = await client.query<{ column_name: string }>(
          `SELECT column_name FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'notice_sites'
             AND data_type = 'boolean' ORDER BY column_name`
        )
        expect(copies.rows.length).toBe(2)
        for (const { column_name } of copies.rows) {
          const filled = await client.query(
            `SELECT ${column_name} AS value FROM ${SECTION}`
          )
          expect(filled.rows).toEqual([{ value: false }])
        }
        // Повторний план тієї самої моделі — без змін
        expect((await planOn(url, conditional)).status).toBe("unchanged")
      } finally {
        await client.end()
      }
    })
  }, 300_000)

  it("disabling the condition needs a permission for the column drop and a separate one for the policy", async () => {
    const conditional = await model({ role: "anon", published: true })
    await withModelTarget(conditional, async (url) => {
      const outcome = await planOn(url, await model("anon"))
      if (outcome.status !== "planned") throw new Error(outcome.status)
      const { steps, requiredPermissions } = outcome.artifact
      const drop = steps.find((s) =>
        s.destroyed.some((r) => r.kind === "column" && r.name === "published")
      )
      const policy = steps.find(
        (s) =>
          s.class === "relaxation" &&
          [...s.produced, ...s.consumed].some(
            (r) => r.kind === "policy" && r.name === "notice_public_read"
          )
      )
      expect(drop).toMatchObject({ class: "destructive", dataLoss: true })
      expect(policy).toBeDefined()
      expect(drop!.id).not.toBe(policy!.id)
      expect(requiredPermissions).toEqual(
        expect.arrayContaining([drop!.id, policy!.id])
      )
    })
  }, 300_000)

  it("turning the authenticated condition into the string form needs a permission even with a `current_user_id` column", async () => {
    // Реквізит `currentUser` дає колонку `current_user_id`, яку текст
    // рядкової політики `authenticated` читає як функцію, а не як колонку
    const reference = [
      {
        id: uuid(9703),
        name: "currentUser",
        physicalName: "current_user_id",
        type: "Ref",
        ref: { kind: "Catalog", name: "Notice" },
      },
    ]
    const conditional = await model(
      { role: "authenticated", published: true },
      reference
    )
    await withModelTarget(conditional, async (url) => {
      const outcome = await planOn(url, await model("authenticated", reference))
      if (outcome.status !== "planned") throw new Error(outcome.status)
      const { steps, requiredPermissions } = outcome.artifact
      const policy = steps.find(
        (s) =>
          s.class === "relaxation" &&
          [...s.produced, ...s.consumed].some(
            (r) => r.kind === "policy" && r.name === "notice_public_read"
          )
      )
      expect(policy).toBeDefined()
      expect(requiredPermissions).toContain(policy!.id)
    })
  }, 300_000)
})
