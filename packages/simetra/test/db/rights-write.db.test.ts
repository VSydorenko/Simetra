import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type pg from "pg"
import {
  COMMAND_SETTING,
  PLATFORM_ROLES,
  PROVIDER_API_ROLES,
  type CommandContext,
} from "simetra/model"
import {
  BULLETIN_TABLE,
  CHECKLIST_TABLE,
  COMMENT_TABLE,
  PROJECT_WRITER_ID,
  REASSIGN_ACTION_ID,
  REGION_NOTES_TABLE,
  REGION_WRITER_ID,
  TASK_MARKER_ID,
  TASK_WRITER_ID,
  compileRights,
  policyDomain,
  writableRegister,
  writeRoles,
} from "../../src/compiler/__tests__/fixtures/rights"
import { signUp } from "./auth"
import { type Refusal, commandAs } from "./connection"
import {
  type Assignment,
  type Seed,
  assignmentRow,
  describeTransaction,
  insert,
  deploy,
} from "./rights-seed"

/**
 * Запис під роллю команд на справжньому Postgres (спека прав §5.3, §6.2,
 * план Права-2b1): які рядки пише роль під RLS запису (запобіжник контексту,
 * дві родини політик, межі тенанта 2a2), що відхиляє тригер ефектів `AFTER`
 * і як каскад ТЧ проходить тригер — вирішує Postgres, компілятор бачить лише
 * текст. Одне розгортання на опис; кожен запит — у точці збереження, яку
 * `commandAs` відкочує, тож порядок кейсів нічого не змінює.
 *
 * Механізм ролі (Р2b1-13) — перший шлях: `GRANT simetra_command TO
 * CURRENT_USER WITH SET TRUE` у транзакції опису. Роль тестів стеку
 * (`postgres`) має `ADMIN` на ролі команд, тож Postgres гранту не відмовляє;
 * запасна тегова роль і клієнт суперкористувача не потрібні.
 */

/**
 * Засів: організації A, B; учасники w1 (A, `TaskWriter` і `RegionWriter`,
 * регіон r1 у `MemberRegion`), w2 (A, `TaskMarker`), w3 (B, `TaskWriter`),
 * w4 (A, лише `ProjectWriter` на P1), w5 (`TaskWriter` і в A, і в B —
 * `tenant-move`). Задачі A у P1: T1 (виконавець w2), T2 (w1, рядок ТЧ),
 * T5 (w1, проведена), T3 (w1, два рядки ТЧ і коментар), T4 (два рядки ТЧ, без
 * коментарів: коментар тримає задачу FK `NO ACTION`); T6 — задача A без
 * посилань і залежних рядків: її ключ і скоуп змінює лише тригер, не FK.
 * Задача B — TB у PB. Учасник `u` організації `O` — ключ `u@O`.
 */
async function seedWrites(client: pg.Client): Promise<Seed> {
  const ids: Seed = { new: randomUUID() }
  const create = async (
    key: string,
    table: string,
    values: Record<string, unknown> = {}
  ) => {
    ids[key] = randomUUID()
    await insert(client, table, { id: ids[key], ...values })
  }
  const assign = (member: string, a: Assignment) =>
    insert(client, "org_role_assignments", {
      org_id: ids[member.split("@")[1]!],
      ...assignmentRow(ids[member]!, a),
    })

  for (const user of ["w1", "w2", "w3", "w4", "w5"])
    ids[user] = await signUp(client)
  await create("A", "organization")
  await create("B", "organization")
  for (const [member, org] of [
    ["w1", "A"],
    ["w2", "A"],
    ["w3", "B"],
    ["w4", "A"],
    ["w5", "A"],
    ["w5", "B"],
  ] as const) {
    await create(`${member}@${org}`, "org_member", {
      org_id: ids[org],
      user_id: ids[member],
    })
  }
  await create("P1", "project", { org_id: ids.A })
  await create("PB", "project", { org_id: ids.B })
  await create("r1", "region", { org_id: ids.A })
  await create("r2", "region", { org_id: ids.A })
  await create("BA", BULLETIN_TABLE, { org_id: ids.A })
  await create("BB", BULLETIN_TABLE, { org_id: ids.B })

  await assign("w1@A", { archetype: TASK_WRITER_ID })
  await assign("w1@A", { archetype: REGION_WRITER_ID })
  await assign("w2@A", { archetype: TASK_MARKER_ID })
  await assign("w3@B", { archetype: TASK_WRITER_ID })
  await assign("w4@A", { archetype: PROJECT_WRITER_ID, container: ids.P1 })
  await assign("w5@A", { archetype: TASK_WRITER_ID })
  await assign("w5@B", { archetype: TASK_WRITER_ID })
  await insert(client, "member_region", {
    org_id: ids.A,
    member_id: ids["w1@A"],
    region_id: ids.r1,
  })

  const now = new Date()
  const task = (
    key: string,
    org: string,
    values: Record<string, unknown>,
    lines = 0
  ) =>
    create(key, "task", { org_id: ids[org], date: now, ...values }).then(
      async () => {
        for (let line = 1; line <= lines; line++)
          await create(`${key}.l${line}`, CHECKLIST_TABLE, {
            org_id: ids[org],
            parent_id: ids[key],
            line_number: line,
          })
      }
    )
  await task("T1", "A", { project_id: ids.P1, assignee_id: ids["w2@A"] })
  await task("T2", "A", { project_id: ids.P1, assignee_id: ids["w1@A"] }, 1)
  await task("T5", "A", {
    project_id: ids.P1,
    assignee_id: ids["w1@A"],
    posted: true,
  })
  await task("T3", "A", { project_id: ids.P1, assignee_id: ids["w1@A"] }, 2)
  await task("T4", "A", { project_id: ids.P1 }, 2)
  await task("T6", "A", {})
  await task("TB", "B", { project_id: ids.PB, assignee_id: ids["w3@B"] })
  await create("T3.c", COMMENT_TABLE, { org_id: ids.A, task_id: ids.T3 })
  return ids
}

/**
 * Контекст запиту: дія, мітка й ключ кореня засіву або сирий рядок з
 * `<ключ>` на місці id (фігурні дужки — синтаксис JSON).
 */
type Context = [action: string, object: string, root: string] | string

/** Очікування: перші колонки повернутих рядків і `after` — ключі засіву. */
type Expected = { rows: string[]; after?: string[] } | Refusal

/**
 * Запит кейсу: користувач, контекст, SQL з `{ключ}` на місці id засіву
 * (підставляється літералом), `after` — запит власника до відкату.
 */
interface Step {
  user: string
  context?: Context
  sql: string
  after?: string
  expected: Expected
}

const refused = (message: string, detail: string): Refusal => ({
  code: "42501",
  message,
  detail,
})
/**
 * Відмова тригера ефектів; колонка — та, на якій він відмовив (без неї —
 * відмова DML чи рядка, а не колонки). Інакше кейс, де колонка лише випала з
 * однієї перевірки й упала в іншу з тим самим кодом, лишився б зеленим.
 */
const effect = (column?: string): Refusal =>
  column === undefined
    ? refused("command.forbidden", "effect")
    : { ...refused("command.forbidden", "effect"), column }
const context = (detail: string) => refused("command.context", detail)
/** Відмова RLS: `42501` з текстом Postgres про порушення політики. */
const RLS = {
  code: "42501",
  message: expect.stringMatching(/violates row-level security policy/),
} as unknown as Refusal
const ok = (rows: string[], after?: string[]): Expected =>
  after === undefined ? { rows } : { rows, after }

const step = (
  user: string,
  context: Context | undefined,
  sql: string,
  expected: Expected,
  after?: string
): Step => ({ user, context, sql, expected, after })

const CASES: [name: string, steps: Step[]][] = [
  [
    "no-context",
    [
      step(
        "w1",
        undefined,
        "UPDATE public.task SET region_id = {r2} WHERE id = {T2}",
        context("missing")
      ),
      // Без запобіжника рядок пропустила б природна `write@region` ролі
      // `RegionWriter`: регістр не має кореневої родини.
      step(
        "w1",
        undefined,
        `INSERT INTO public.${REGION_NOTES_TABLE} (org_id, region_id, note) VALUES ({A}, {r1}, 'n')`,
        context("missing")
      ),
    ],
  ],
  [
    "malformed-context",
    [
      step(
        "w1",
        '{"action":"update","object":"task"}',
        "UPDATE public.task SET region_id = {r2} WHERE id = {T2}",
        context("malformed")
      ),
      step(
        "w1",
        '{"action":"update","object":"task","root":"<T2>","x":1}',
        "UPDATE public.task SET region_id = {r2} WHERE id = {T2}",
        context("malformed")
      ),
      // Не JSON, не об'єкт і корінь не UUID — теж контракт §6.2, а не
      // помилка розбору (`22P02`, `22023`) з глибини функції контексту.
      ...[
        "not json",
        "[1,2,3]",
        '{"action":"update","object":"task","root":"x"}',
      ].map((raw) =>
        step(
          "w1",
          raw,
          "UPDATE public.task SET region_id = {r2} WHERE id = {T2}",
          context("malformed")
        )
      ),
    ],
  ],
  [
    "root-transition",
    [
      step(
        "w2",
        ["markDeletion", "task", "T1"],
        "UPDATE public.task SET deletion_mark = true WHERE id = {T1} RETURNING id",
        ok(["T1"])
      ),
    ],
  ],
  [
    "rest-needs-natural",
    [
      step(
        "w2",
        ["markDeletion", "task", "T1"],
        "UPDATE public.task SET deletion_mark = true WHERE id = {T2} RETURNING id",
        ok([])
      ),
    ],
  ],
  [
    "rest-delete-needs-natural",
    [
      // T2 не кореневий: видалити його може лише природна `delete`, якої
      // `TaskMarker` не має.
      step(
        "w2",
        ["markDeletion", "task", "T1"],
        "DELETE FROM public.task WHERE id = {T2} RETURNING id",
        ok([])
      ),
    ],
  ],
  [
    "post-extent",
    [
      // T1 — чужа: `update@any` є, `post@own` — ні.
      step(
        "w1",
        ["post", "task", "T1"],
        "UPDATE public.task SET posted = true WHERE id = {T1} RETURNING id",
        ok([])
      ),
      step(
        "w1",
        ["post", "task", "T2"],
        "UPDATE public.task SET posted = true WHERE id = {T2} RETURNING id",
        ok(["T2"])
      ),
    ],
  ],
  [
    "root-effect",
    [
      step(
        "w2",
        ["markDeletion", "task", "T1"],
        "UPDATE public.task SET deletion_mark = true, region_id = {r2} WHERE id = {T1}",
        effect("region_id")
      ),
    ],
  ],
  [
    "root-dml",
    [
      step(
        "w1",
        ["update", "task", "T2"],
        "DELETE FROM public.task WHERE id = {T2}",
        effect()
      ),
    ],
  ],
  [
    "tabular-transition",
    [
      step(
        "w2",
        ["markDeletion", "task", "T1"],
        `INSERT INTO public.${CHECKLIST_TABLE} (org_id, parent_id, line_number) VALUES ({A}, {T1}, 1)`,
        effect()
      ),
      step(
        "w1",
        ["update", "task", "T1"],
        `INSERT INTO public.${CHECKLIST_TABLE} (org_id, parent_id, line_number) VALUES ({A}, {T1}, 1) RETURNING parent_id`,
        ok(["T1"])
      ),
    ],
  ],
  [
    "delete-cascade",
    [
      // Рядки T3 у тій самій вибірці — позитивний контроль: порожнє `after`
      // для T4 інакше могло б означати лише, що запит нічого не бачить.
      step(
        "w1",
        ["delete", "task", "T4"],
        "DELETE FROM public.task WHERE id = {T4} RETURNING id",
        ok(["T4"], ["T3", "T3"]),
        `SELECT parent_id FROM public.${CHECKLIST_TABLE} WHERE parent_id IN ({T4}, {T3})`
      ),
    ],
  ],
  [
    "delete-single-line",
    [
      step(
        "w1",
        ["delete", "task", "T4"],
        `DELETE FROM public.${CHECKLIST_TABLE} WHERE parent_id = {T4} AND id = {T4.l1}`,
        effect()
      ),
    ],
  ],
  [
    "copy-only",
    [
      step(
        "w1",
        [REASSIGN_ACTION_ID, "task", "T3"],
        "UPDATE public.task SET assignee_id = {w2@A} WHERE id = {T3} RETURNING id",
        ok(["T3"], ["w2@A"]),
        `SELECT DISTINCT assignee_id FROM public.${CHECKLIST_TABLE} WHERE parent_id = {T3}`
      ),
    ],
  ],
  [
    "tenant-boundary",
    [
      step(
        "w4",
        ["update", "task", "TB"],
        "UPDATE public.task SET assignee_id = NULL WHERE id = {TB} RETURNING id",
        ok([])
      ),
      // RLS — раніше за FK `AFTER`: (B, P1) не існує, але відмовляє межа.
      step(
        "w4",
        ["create", "task", "new"],
        "INSERT INTO public.task (id, org_id, project_id, date) VALUES ({new}, {B}, {P1}, now())",
        RLS
      ),
      // Без `WHERE` і `RETURNING`: інакше `UPDATE` потребує читання, і новий
      // рядок відкинула б уже `task_scope_read`, а не `task_scope_update`.
      // Рядки обирають лише `USING` політик запису — T2 кореневою родиною,
      // решта задач P1 природною `update`.
      step(
        "w4",
        ["update", "task", "T2"],
        "UPDATE public.task SET org_id = {B}",
        RLS
      ),
    ],
  ],
  [
    "register-dimension",
    [
      step(
        "w1",
        ["write", REGION_NOTES_TABLE, "new"],
        `INSERT INTO public.${REGION_NOTES_TABLE} (org_id, region_id, note) VALUES ({A}, {r1}, 'n') RETURNING region_id`,
        ok(["r1"])
      ),
      step(
        "w1",
        ["write", REGION_NOTES_TABLE, "new"],
        `INSERT INTO public.${REGION_NOTES_TABLE} (org_id, region_id, note) VALUES ({A}, {r2}, 'n')`,
        RLS
      ),
    ],
  ],
  [
    "public-read-write",
    [
      step(
        "w1",
        ["update", BULLETIN_TABLE, "BA"],
        `UPDATE public.${BULLETIN_TABLE} SET text = 'x' WHERE id = {BA} RETURNING id`,
        ok(["BA"])
      ),
      // BB видно через `publicRead`, але запису не пускає вже предикат прав:
      // у w1 немає прав в організації B (межу тенанта доводить
      // `tenant-boundary`).
      step(
        "w1",
        ["update", BULLETIN_TABLE, "BB"],
        `UPDATE public.${BULLETIN_TABLE} SET text = 'x' WHERE id = {BB} RETURNING id`,
        ok([])
      ),
    ],
  ],
  [
    "forged-author",
    [
      // `created_by_id` незмінний (Рт7): тригер авторства ставить його лише
      // на вставці, а зміну на оновленні відмовляє тригер ефектів.
      step(
        "w1",
        ["post", "task", "T2"],
        "UPDATE public.task SET posted = true, created_by_id = {w2} WHERE id = {T2}",
        effect("created_by_id")
      ),
    ],
  ],
  [
    "create-existing-root",
    [
      step(
        "w1",
        ["create", "task", "T2"],
        `UPDATE public.${CHECKLIST_TABLE} SET note = 'x' WHERE parent_id = {T2}`,
        effect()
      ),
    ],
  ],
  [
    "update-cannot-post",
    [
      step(
        "w1",
        ["update", "task", "T2"],
        "UPDATE public.task SET posted = true WHERE id = {T2}",
        effect("posted")
      ),
    ],
  ],
  [
    "update-cannot-mark",
    [
      step(
        "w1",
        ["update", "task", "T2"],
        "UPDATE public.task SET deletion_mark = true WHERE id = {T2}",
        effect("deletion_mark")
      ),
    ],
  ],
  [
    "create-cannot-post",
    [
      step(
        "w1",
        ["create", "task", "new"],
        "INSERT INTO public.task (id, org_id, project_id, date, posted) VALUES ({new}, {A}, {P1}, now(), true)",
        effect("posted")
      ),
    ],
  ],
  [
    "post-cannot-unpost",
    [
      step(
        "w1",
        ["post", "task", "T5"],
        "UPDATE public.task SET posted = false WHERE id = {T5}",
        effect("posted")
      ),
    ],
  ],
  [
    "rest-cannot-post",
    [
      // T1 — природна `update`, яку w1 має.
      step(
        "w1",
        ["post", "task", "T2"],
        "UPDATE public.task SET posted = true WHERE id = {T1}",
        effect("posted")
      ),
    ],
  ],
  [
    "cross-object-transition",
    [
      // Запис іншого об'єкта — природна `update` без колонок переходів.
      step(
        "w1",
        ["update", "task", "T2"],
        `UPDATE public.${BULLETIN_TABLE} SET deletion_mark = true WHERE id = {BA}`,
        effect("deletion_mark")
      ),
    ],
  ],
  [
    "unknown-action",
    [
      step(
        "w1",
        ["invent", "task", "T2"],
        `UPDATE public.${BULLETIN_TABLE} SET text = 'x' WHERE id = {BA}`,
        context("unknown-action")
      ),
      // Дія `post` існує, але в задачі, а не в оголошенні: пару «дія, об'єкт»
      // судить запобіжник, а не саме ім'я дії.
      step(
        "w1",
        ["post", BULLETIN_TABLE, "BA"],
        `UPDATE public.${BULLETIN_TABLE} SET text = 'x' WHERE id = {BA}`,
        context("unknown-action")
      ),
    ],
  ],
  [
    "root-rekey",
    [
      // T6 — без залежних рядків: на T2 FK `NO ACTION` рядка ТЧ (тригер
      // `RI_…` за ім'ям іде раніше за тригер ефектів) відмовив би `23503`.
      step(
        "w1",
        ["update", "task", "T6"],
        "UPDATE public.task SET id = gen_random_uuid() WHERE id = {T6}",
        effect("id")
      ),
    ],
  ],
  [
    "section-owner-move",
    [
      // Р2b1-24: рядок ТЧ T2 до іншої задачі того самого тенанта. `update` у
      // w1 є на обох (RLS пропускає), FK (A, T1) існує, а дія над коренем
      // дозволяє в ТЧ усе — відмовляє лише незмінність власника.
      step(
        "w1",
        ["update", "task", "T2"],
        `UPDATE public.${CHECKLIST_TABLE} SET parent_id = {T1} WHERE id = {T2.l1}`,
        effect("parent_id")
      ),
    ],
  ],
  [
    "create-root",
    [
      step(
        "w1",
        ["create", "task", "new"],
        "INSERT INTO public.task (id, org_id, project_id, date) VALUES ({new}, {A}, {P1}, now()) RETURNING id",
        ok(["new"])
      ),
    ],
  ],
  [
    "tenant-move",
    [
      // RLS пропускає (`USING` в A, `WITH CHECK` у B); відмовляє тригер.
      step(
        "w5",
        ["update", "task", "T6"],
        "UPDATE public.task SET org_id = {B} WHERE id = {T6}",
        effect("org_id")
      ),
      // Рядок ТЧ разом із власником до B: FK (B, TB) існує, RLS пропускає, а
      // шапку ТЧ тригер не порівнює — скоуп рядка тримає лише незмінність.
      // В основній таблиці її дублює порівняння шапки з тією самою колонкою.
      step(
        "w5",
        ["update", "task", "T2"],
        `UPDATE public.${CHECKLIST_TABLE} SET org_id = {B}, parent_id = {TB} WHERE id = {T2.l1}`,
        effect("org_id")
      ),
    ],
  ],
]

/**
 * Вирази плану `EXPLAIN (FORMAT JSON, VERBOSE)`: виходи піддерев InitPlan і
 * умови решти вузлів (фільтри, умови індексу й з'єднання).
 */
function planExpressions(
  plan: unknown,
  inInitPlan = false,
  found: { initPlans: string[]; quals: string[] } = {
    initPlans: [],
    quals: [],
  }
): { initPlans: string[]; quals: string[] } {
  if (Array.isArray(plan)) {
    for (const item of plan) planExpressions(item, inInitPlan, found)
    return found
  }
  if (typeof plan !== "object" || plan === null) return found
  const node = plan as Record<string, unknown>
  const init = inInitPlan || node["Parent Relationship"] === "InitPlan"
  for (const [key, value] of Object.entries(node)) {
    if (key === "Output" && init && Array.isArray(value)) {
      found.initPlans.push(...value.map(String))
    } else if (/(Filter|Cond)$/.test(key) && typeof value === "string") {
      ;(init ? found.initPlans : found.quals).push(value)
    } else {
      planExpressions(value, init, found)
    }
  }
  return found
}

describe("command writes", () => {
  const tx = describeTransaction()
  let ids: Seed = {}

  beforeAll(async () => {
    const result = await compileRights(
      policyDomain(writeRoles(), writableRegister())
    )
    expect(result.diagnostics).toEqual([])
    const client = await tx.open()
    await deploy(client, result.model!)
    // Р2b1-13: DML і членство з `SET` ролі команд — лише в цій транзакції;
    // згенерований SQL їх не дає (П4).
    await client.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${PLATFORM_ROLES.command}`
    )
    await client.query(
      `GRANT ${PLATFORM_ROLES.command} TO CURRENT_USER WITH SET TRUE`
    )
    // Серверний код споживача досі пише сервісною роллю провайдера: DML їй
    // теж лише в цій транзакції (кейс `provider-api-role-write`).
    await client.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${PROVIDER_API_ROLES.supabase.service}`
    )
    ids = await seedWrites(client)
  })

  afterAll(() => tx.close())

  const key = (name: string) => {
    // Невідомий ключ дав би `NULL` замість id — і зелений кейс без причини.
    const id = ids[name]
    if (id === undefined) throw new Error(`unknown seed key ${name}`)
    return id
  }
  const literal = (sql: string) =>
    sql.replace(/\{([^}]+)\}/g, (_, name: string) => `'${key(name)}'`)
  const claims = (user: string) => ({ sub: key(user), role: "authenticated" })

  /** Перша колонка рядків як ключі засіву; невідомий id — як є. */
  const byKey = (rows: pg.QueryResultRow[]) => {
    const names = new Map(Object.entries(ids).map(([k, v]) => [v, k]))
    return rows.map((row) => {
      const value = String(Object.values(row)[0])
      return names.get(value) ?? value
    })
  }

  const run = async ({ user, context, sql, after }: Step) => {
    const value: CommandContext | string | undefined = Array.isArray(context)
      ? { action: context[0], object: context[1], root: key(context[2]) }
      : context?.replace(/<([^>]+)>/g, (_, name: string) => key(name))
    const result = await commandAs(
      tx.client(),
      claims(user),
      value,
      literal(sql),
      after === undefined ? {} : { after: literal(after) }
    )
    if (!("rows" in result)) return result
    return result.after === undefined
      ? { rows: byKey(result.rows) }
      : { rows: byKey(result.rows), after: byKey(result.after) }
  }

  /** Запит власника в точці збереження з відкатом. */
  const probe = async <T>(fn: (client: pg.Client) => Promise<T>) => {
    const client = tx.client()
    await client.query("SAVEPOINT probe")
    try {
      return await fn(client)
    } finally {
      await client.query("ROLLBACK TO SAVEPOINT probe")
    }
  }

  // Р2b1-9: виняток каскаду тримається на тому, що під час каскаду FK
  // власник уже не видимий; якщо це не так, виняток пропустив би видалення
  // рядка ТЧ живого документа.
  it("fact: during the cascade the owner row is already gone", async () => {
    const seen = await probe(async (client) => {
      await client.query("CREATE TABLE public.probe_owner_seen (seen boolean)")
      await client.query(
        `CREATE FUNCTION public.probe_owner_seen() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN
           INSERT INTO public.probe_owner_seen VALUES (EXISTS (SELECT 1 FROM public.task WHERE id = OLD.parent_id));
           RETURN NULL;
         END $$`
      )
      await client.query(
        `CREATE TRIGGER probe_owner_seen AFTER DELETE ON public.${CHECKLIST_TABLE} FOR EACH ROW EXECUTE FUNCTION public.probe_owner_seen()`
      )
      await client.query(literal("DELETE FROM public.task WHERE id = {T4}"))
      const { rows } = await client.query<{ seen: boolean }>(
        "SELECT seen FROM public.probe_owner_seen"
      )
      return rows.map((r) => r.seen)
    })
    expect(seen).toEqual([false, false])
  })

  // Р2b1-8: функція ефектів `SECURITY DEFINER` читає власника рядка ТЧ, якого
  // роль команд під своїми політиками читання може й не бачити.
  it("fact: a security definer function sees a row the command role does not", async () => {
    const seen = await probe(async (client) => {
      await client.query(
        `CREATE FUNCTION public.probe_task_exists(p uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' SET row_security = off AS $$ SELECT EXISTS (SELECT 1 FROM public.task WHERE id = p) $$`
      )
      await client.query(
        `GRANT EXECUTE ON FUNCTION public.probe_task_exists(uuid) TO ${PLATFORM_ROLES.command}`
      )
      return commandAs<{ role: boolean; definer: boolean }>(
        client,
        claims("w3"),
        { action: "update", object: "task", root: key("TB") },
        literal(
          "SELECT EXISTS (SELECT 1 FROM public.task WHERE id = {T1}) AS role, public.probe_task_exists({T1}) AS definer"
        )
      )
    })
    expect(seen).toEqual({ rows: [{ role: false, definer: true }] })
  })

  // Р2b1-8: тригер ефектів спрацьовує й на записі ролі API, а `EXECUTE` на
  // функціях контексту має лише роль команд. Під правами викликача кожен
  // такий запис упав би на функції контексту; `SECURITY DEFINER` дає йому
  // дійти до раннього виходу без контексту. Права функцій вирішує Postgres.
  it("provider-api-role-write", async () => {
    const written = await probe(async (client) => {
      await client.query(
        `SET LOCAL ROLE ${PROVIDER_API_ROLES.supabase.service}`
      )
      const { rows } = await client.query<{ region_id: string }>(
        "UPDATE public.task SET region_id = $1 WHERE id = $2 RETURNING region_id",
        [key("r2"), key("T2")]
      )
      await client.query("RESET ROLE")
      const after = await client.query<{ region_id: string }>(
        "SELECT region_id FROM public.task WHERE id = $1",
        [key("T2")]
      )
      return { rows: byKey(rows), after: byKey(after.rows) }
    })
    expect(written).toEqual({ rows: ["r2"], after: ["r2"] })
  })

  // Р-A1-8: зіпсований контекст у сесії ролі API — відмова контракту §6.2,
  // а не тихий запис «без контексту». Першим його читає `BEFORE`-тригер
  // авторства (`SECURITY DEFINER`), і що функція контексту відмовляє саме
  // так під роллю без `EXECUTE` на ній, вирішує Postgres.
  it("provider-api-role-malformed-context", async () => {
    const refusal = await probe(async (client) => {
      await client.query(
        `SET LOCAL ROLE ${PROVIDER_API_ROLES.supabase.service}`
      )
      await client.query("SELECT set_config($1, 'not json', true)", [
        COMMAND_SETTING,
      ])
      try {
        await client.query(
          "UPDATE public.task SET region_id = $1 WHERE id = $2",
          [key("r2"), key("T2")]
        )
        return undefined
      } catch (error) {
        const { code, message, detail } = error as Refusal
        return { code, message, detail }
      }
    })
    expect(refusal).toEqual(context("malformed"))
  })

  it.each(CASES)("%s", async (_, steps) => {
    for (const s of steps) {
      // Мʼяка перевірка: червоні всі розбіжності кейсу, а не лише перша.
      expect
        .soft(await run(s), `${s.user} ${JSON.stringify(s.context)}: ${s.sql}`)
        .toEqual(s.expected)
    }
  })

  // Причина DB-рівня (платформна спека §6.8, §5.4): чи рахується умова
  // родини й запобіжник контексту раз на оператор (InitPlan), а не на рядок,
  // вирішує планувальник. `USING` політик запису стає фільтром сканування, тож
  // виклик функції платформи поза InitPlan означає обчислення на кожен рядок.
  // `INSERT … VALUES` перевірок `WITH CHECK` у плані не показує — його тут немає.
  it.each([
    [
      "update",
      "task",
      "UPDATE public.task SET region_id = {r2} WHERE id = {T2}",
    ],
    ["delete", "task", "DELETE FROM public.task WHERE id = {T2}"],
    [
      "update",
      CHECKLIST_TABLE,
      `UPDATE public.${CHECKLIST_TABLE} SET note = 'x' WHERE parent_id = {T2}`,
    ],
    [
      "delete",
      CHECKLIST_TABLE,
      `DELETE FROM public.${CHECKLIST_TABLE} WHERE parent_id = {T2}`,
    ],
  ])(
    "plan of %s on %s evaluates the write policies once per statement",
    async (action, _table, sql) => {
      const result = await commandAs<{ "QUERY PLAN": unknown }>(
        tx.client(),
        claims("w1"),
        { action, object: "task", root: key("T2") },
        `EXPLAIN (FORMAT JSON, VERBOSE) ${literal(sql)}`
      )
      if (!("rows" in result))
        throw new Error(`EXPLAIN failed: ${result.code} ${result.message}`)
      const { initPlans, quals } = planExpressions(
        result.rows[0]!["QUERY PLAN"]
      )
      const calls = (texts: string[]) =>
        texts.join(" ").match(/simetra\.\w+\(/g) ?? []
      expect
        .soft(calls(initPlans))
        .toEqual(
          expect.arrayContaining([
            "simetra.command_action(",
            "simetra.command_root(",
          ])
        )
      expect.soft(calls(quals)).toEqual([])
      expect.soft(JSON.stringify(result.rows)).not.toContain("SubPlan")
    }
  )

  // Механіка примушує `version` після запиту: тригер ефектів її зміни не
  // бачить (Р2b1-15), і значення запиту не доходить до рядка.
  it("forced-mechanics", async () => {
    const { rows } = await tx
      .client()
      .query<{ v: string }>(
        "SELECT version::text AS v FROM public.task WHERE id = $1",
        [key("T2")]
      )
    const result = await commandAs<{ version: string }>(
      tx.client(),
      claims("w1"),
      { action: "post", object: "task", root: key("T2") },
      "UPDATE public.task SET posted = true, version = 999 WHERE id = $1 RETURNING version::text",
      { params: [key("T2")] }
    )
    expect(result).toEqual({
      rows: [{ version: String(Number(rows[0]!.v) + 1) }],
    })
  })
})
