import { randomUUID } from "node:crypto"
import pg from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  COMMAND_SETTING,
  PLATFORM_ROLES,
  RIGHTS_MAINTENANCE_SETTING,
  SESSION_CLAIMS_SETTING,
} from "simetra/model"
import { renderDesiredState } from "simetra/schema"
import {
  CHECKLIST_TABLE,
  GLOBAL_ADMIN_ID,
  ORG_ADMIN_ID,
  PROJECT_READER_ID,
  PROJECT_WRITER_ID,
  REGION_DIMENSION_ID,
  TASK_EDITOR_ID,
  TASK_VIEWER_ID,
  adminRoles,
  compileRights,
  policyDomain,
  writeRoles,
} from "../../src/compiler/__tests__/fixtures/rights"
import { signUp } from "./auth"
import {
  commandAs,
  queryAs,
  testSuperuserUrl,
  withRollback,
  type Refusal,
} from "./connection"
import {
  assignmentRow,
  closureRights,
  describeTransaction,
  insert,
  orgDeltaRow,
  seedAdministration,
  type Seed,
} from "./rights-seed"

/**
 * Відкладені тригери прав, журнал і версії перевіряє Postgres на справжніх
 * рядках: SQL-компіляція не доводить ані порядок операторів, ані знімок на
 * COMMIT, ані поведінку при відмові. Усі кейси опису ділять одне розгортання.
 */

type Result = { rows?: pg.QueryResultRow[] } | Refusal
const isRefusal = (value: Result): value is Refusal => "code" in value
const refusal = (value: Result, detail: string) => {
  expect(value).toMatchObject({ code: "42501", detail })
}
const success = (value: Result) => {
  if (isRefusal(value))
    throw new Error(`${value.code}: ${value.detail ?? value.message}`)
}
/** Успіх, що справді змінив рядок: RLS, що сховала рядок, дала б «успіх» без запису. */
const changed = (value: Result) => {
  success(value)
  expect((value as { rows: pg.QueryResultRow[] }).rows).toHaveLength(1)
}
const ZERO = "00000000-0000-0000-0000-000000000000"
/** Відмова тригера ключа (Рб1-4): та сама форма, що в тригера ефектів. */
const KEY_REFUSAL = {
  code: "42501",
  message: "command.forbidden",
  detail: "effect",
  column: "id",
}
const PENDING_ROWS =
  "SELECT (SELECT count(*) FROM simetra.rights_tx_actor WHERE xid = txid_current())::int + (SELECT count(*) FROM simetra.rights_tx_pending WHERE xid = txid_current())::int AS n"

describe("rights administration guards", () => {
  const tx = describeTransaction()
  let ids: Seed = {}
  const key = (name: string) => {
    // Невідомий ключ дав би `NULL` замість id — і зелений кейс без причини
    const id = ids[name]
    if (id === undefined) throw new Error(`unknown seed key ${name}`)
    return id
  }
  /** Ключ засіву або вже готовий uuid (id нового рядка). */
  const idOf = (name: string) =>
    /^[0-9a-f-]{36}$/.test(name) ? name : key(name)
  const sql = (source: string) =>
    source.replace(/\{([^}]+)\}/g, (_, name: string) => `'${key(name)}'`)
  const claims = (user: string) => ({ sub: key(user), role: "authenticated" })
  /**
   * Команда пише лише свій кореневий рядок і його ТЧ (Р2c2-1), тож корінь
   * контексту — id рядка, а не скоуп; `after` завершує її відкладену
   * перевірку в межах транзакції опису.
   */
  const command = (
    user: string,
    [action, object, root]: [string, string, string],
    statement: string,
    after = "SET CONSTRAINTS ALL IMMEDIATE"
  ) =>
    commandAs(
      tx.client(),
      claims(user),
      { action, object, root: idOf(root) },
      sql(statement),
      { after: sql(after) }
    )
  const admin = (object: string, root: string): [string, string, string] => [
    "administerRights",
    object,
    root,
  ]
  const owner = async (
    statement: string,
    maintenance = false
  ): Promise<Result> => {
    const client = tx.client()
    await client.query("SAVEPOINT owner_probe")
    try {
      if (maintenance)
        await client.query("SELECT set_config($1, 'on', true)", [
          RIGHTS_MAINTENANCE_SETTING,
        ])
      const result: pg.QueryResult | pg.QueryResult[] = await client.query(
        sql(statement)
      )
      await client.query("SET CONSTRAINTS ALL IMMEDIATE")
      // Кілька операторів одним запитом дають масив: рядки — останнього.
      return { rows: Array.isArray(result) ? result.at(-1)!.rows : result.rows }
    } catch (error) {
      if (!(error instanceof pg.DatabaseError)) throw error
      return {
        code: error.code ?? "",
        message: error.message,
        detail: error.detail,
        column: error.column,
      }
    } finally {
      await client.query("ROLLBACK TO SAVEPOINT owner_probe")
    }
  }
  /** Контекст команди для наступних операторів кроку. */
  const context = (client: pg.Client, [action, object, root]: string[]) =>
    client.query("SELECT set_config($1, $2, true)", [
      COMMAND_SETTING,
      JSON.stringify({ action, object, root: idOf(root!) }),
    ])
  /**
   * Кроки однієї команди. `asOwner` лишає власника таблиць: RLS його не
   * обмежує, а тригери прав і ефектів судять оператор так само — для
   * конфігурацій, яких політики не відкривають (захист у глибину).
   */
  const inCommand = async (
    user: string,
    first: [string, string, string],
    steps: (client: pg.Client) => Promise<void>,
    asOwner = false
  ): Promise<Result> => {
    const client = tx.client()
    await client.query("SAVEPOINT guard_command")
    try {
      await client.query("SELECT set_config($1, $2, true)", [
        SESSION_CLAIMS_SETTING,
        JSON.stringify(claims(user)),
      ])
      await context(client, first)
      if (!asOwner)
        await client.query(`SET LOCAL ROLE ${PLATFORM_ROLES.command}`)
      await steps(client)
      return { rows: [] }
    } catch (error) {
      if (!(error instanceof pg.DatabaseError)) throw error
      return {
        code: error.code ?? "",
        message: error.message,
        detail: error.detail,
        column: error.column,
      }
    } finally {
      await client.query("ROLLBACK TO SAVEPOINT guard_command")
    }
  }
  const assignSql = (id: string, archetype: string, subject = "target@A") =>
    `INSERT INTO public.org_role_assignments (id, org_id, subject, archetype) VALUES ('${id}', {A}, {${subject}}, '${archetype}')`

  beforeAll(async () => {
    const result = await compileRights(policyDomain(writeRoles(), adminRoles()))
    expect(result.diagnostics).toEqual([])
    const client = await tx.open()
    await client.query(renderDesiredState(result.model!).sql)
    await client.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${PLATFORM_ROLES.command}`
    )
    await client.query(
      `GRANT ${PLATFORM_ROLES.command} TO CURRENT_USER WITH SET TRUE`
    )
    ids = await seedAdministration(client)
    // Відкладені ключі засіву перевіряються зараз: кейси починають з порожньої черги
    await client.query("SET CONSTRAINTS ALL IMMEDIATE")
    await client.query("SET CONSTRAINTS ALL DEFERRED")
  }, 120_000)
  afterAll(() => tx.close())

  // Той самий результат звіряє snake_case-опис (`snake-case.db.test.ts`).
  it("rights_mine reads custom roles and their deltas", async () => {
    expect(await closureRights(tx.client(), ids)).toEqual([
      "task|read|dimension",
      "task|read|own",
    ])
  })

  // Призначення собі, чужому й у контейнер судить той самий ⊆; контейнерна
  // гілка покриття окрема, тож кожна форма має свій кейс.
  it.each([
    ["self-assign", "admin@A", ORG_ADMIN_ID, null],
    ["escalation-assign", "target@A", TASK_EDITOR_ID, null],
    ["container-assign", "target@A", PROJECT_WRITER_ID, "P1"],
  ])(
    "%s refuses uncovered grants on COMMIT",
    async (_, subject, archetype, container) => {
      const id = randomUUID()
      refusal(
        await command(
          "admin",
          admin("org_role_assignments", id),
          container === null
            ? assignSql(id, archetype, subject)
            : `INSERT INTO public.org_role_assignments (id, org_id, subject, archetype, container) VALUES ('${id}', {A}, {${subject}}, '${archetype}', {${container}})`
        ),
        "escalation"
      )
    }
  )

  it.each([
    ["assign-covered", TASK_VIEWER_ID, null],
    ["container-covered", PROJECT_READER_ID, "P1"],
  ])("%s accepts covered rights", async (_, archetype, container) => {
    const id = randomUUID()
    const columns = container === null ? "" : ", container"
    const value = container === null ? "" : `, {${container}}`
    success(
      await command(
        "admin",
        admin("org_role_assignments", id),
        `INSERT INTO public.org_role_assignments (id, org_id, subject, archetype${columns}) VALUES ('${id}', {A}, {target@A}, '${archetype}'${value})`
      )
    )
  })

  it.each([
    [
      "self-held-role-delta",
      "admin",
      admin("org_roles", "heldCustom"),
      "INSERT INTO public.org_roles_delta (id, org_id, parent_id, line_number, object, action, extent, effect) VALUES (gen_random_uuid(), {A}, {heldCustom}, 1, 'task', 'update', 'any', 'allow')",
      "escalation",
    ],
    [
      "escalation-closure",
      "admin",
      admin("org_roles", "closureCustom"),
      "DELETE FROM public.org_roles_delta WHERE parent_id = {closureCustom} AND effect = 'deny'",
      "escalation",
    ],
    [
      "container-move",
      "admin",
      admin("org_role_assignments", "moveRole"),
      "UPDATE public.org_role_assignments SET container = {P2} WHERE id = {moveRole}",
      "escalation",
    ],
    [
      "role-in-use",
      "root",
      admin("org_roles", "inUseCustom"),
      "UPDATE public.org_roles SET deletion_mark = true WHERE id = {inUseCustom}",
      "role-in-use",
    ],
    [
      "last-single",
      "bAdmin",
      admin("org_role_assignments", "bRole"),
      "UPDATE public.org_role_assignments SET deletion_mark = true WHERE id = {bRole}",
      "last-full-access",
    ],
  ] as const)(
    "%s enforces deferred guard",
    async (_, actor, context, statement, detail) => {
      refusal(await command(actor, [...context], statement), detail)
    }
  )

  it("cross-scope: fullAccess in another tenant does not cover a grant here", async () => {
    const here = randomUUID()
    refusal(
      await command(
        "bAdmin",
        admin("org_role_assignments", here),
        assignSql(here, ORG_ADMIN_ID, "bAdmin@A")
      ),
      "escalation"
    )
    // Контроль: той самий знімок покриває приріст у тенанті повного доступу.
    const there = randomUUID()
    changed(
      await command(
        "bAdmin",
        admin("org_role_assignments", there),
        `INSERT INTO public.org_role_assignments (id, org_id, subject, archetype) VALUES ('${there}', {B}, {bAdmin@B}, '${TASK_EDITOR_ID}') RETURNING id`
      )
    )
  })
  it.each([
    [
      "restore-marked-assignment",
      "admin",
      "org_role_assignments",
      "markedRole",
    ],
    ["restore-marked-role", "viewer", "org_roles", "markedCustom"],
  ])(
    "%s: un-marking is a full increment, covered only by fullAccess",
    async (_, actor, table, row) => {
      const restore = `UPDATE public.${table} SET deletion_mark = false WHERE id = {${row}} RETURNING id`
      refusal(await command(actor, admin(table, row), restore), "escalation")
      changed(await command("root", admin(table, row), restore))
    }
  )
  it("the same closure is covered by TaskEditor", async () => {
    changed(
      await command(
        "editor",
        admin("org_roles", "closureCustom"),
        "DELETE FROM public.org_roles_delta WHERE parent_id = {closureCustom} AND effect = 'deny' RETURNING id"
      )
    )
  })
  it("fullAccess exempts an actor and removing one of two carriers succeeds", async () => {
    const id = randomUUID()
    success(
      await command(
        "root",
        admin("org_role_assignments", id),
        assignSql(id, TASK_EDITOR_ID)
      )
    )
    changed(
      await command(
        "root",
        admin("org_role_assignments", "root2Role"),
        "UPDATE public.org_role_assignments SET deletion_mark = true WHERE id = {root2Role} RETURNING id"
      )
    )
  })
  it("a marked unused custom role is accepted", async () => {
    changed(
      await command(
        "root",
        admin("org_roles", "unusedCustom"),
        "UPDATE public.org_roles SET deletion_mark = true WHERE id = {unusedCustom} RETURNING id"
      )
    )
  })
  it("no-context refuses the owner but maintenance writes and journals", async () => {
    refusal(
      await owner(assignSql(randomUUID(), TASK_VIEWER_ID)),
      "rights-context"
    )
    const client = tx.client()
    await client.query("SAVEPOINT maintenance_journal")
    try {
      await client.query("SELECT set_config($1, 'on', true)", [
        RIGHTS_MAINTENANCE_SETTING,
      ])
      const id = randomUUID()
      await client.query(sql(assignSql(id, TASK_VIEWER_ID)))
      await client.query("SET CONSTRAINTS ALL IMMEDIATE")
      const { rows } = await client.query<{
        actor: string | null
        reason: string
      }>(
        "SELECT actor, reason FROM simetra.rights_journal WHERE row_id = $1 ORDER BY seq DESC LIMIT 1",
        [id]
      )
      expect(rows).toEqual([{ actor: null, reason: "maintenance" }])
    } finally {
      await client.query("ROLLBACK TO SAVEPOINT maintenance_journal")
    }
    refusal(
      await owner(
        "UPDATE public.org_role_assignments SET deletion_mark = true WHERE id = {bRole}",
        true
      ),
      "last-full-access"
    )
  })
  it("the maintenance seed is part of the baseline", async () => {
    changed(
      await command(
        "viewer",
        admin("org_roles", "baselineCustom"),
        'UPDATE public.org_roles SET "order" = 5 WHERE id = {baselineCustom} RETURNING id'
      )
    )
  })
  // Команда пише роль і її `deny` окремими операторами: проміжний стан дав би
  // хибну ескалацію, тож судиться результат транзакції.
  it("creating a role and a deny in separate statements is judged on the final state", async () => {
    const role = randomUUID()
    const denied =
      ["any", "own"]
        .map(
          (extent, i) =>
            `INSERT INTO public.org_roles_delta (id, org_id, parent_id, line_number, object, action, extent, effect) VALUES (gen_random_uuid(), {A}, '${role}', ${i + 1}, 'task', 'update', '${extent}', 'deny')`
        )
        .join("; ") +
      `; INSERT INTO public.org_roles_delta (id, org_id, parent_id, line_number, object, action, extent, effect, dimension) VALUES (gen_random_uuid(), {A}, '${role}', 3, 'task', 'update', 'dimension', 'deny', '${REGION_DIMENSION_ID}')`
    const statement = `INSERT INTO public.org_roles (id, org_id, archetype) VALUES ('${role}', {A}, '${TASK_EDITOR_ID}'); ${denied}`
    success(await command("viewer", admin("org_roles", role), statement))
    const bare = randomUUID()
    refusal(
      await command(
        "viewer",
        admin("org_roles", bare),
        `INSERT INTO public.org_roles (id, org_id, archetype) VALUES ('${bare}', {A}, '${TASK_EDITOR_ID}')`
      ),
      "escalation"
    )
  })
  // Видалення кореня тенанта знімає й останнього носія: скоупу вже немає, і
  // відмова `last-full-access` була б хибною.
  it("deleting the tenant root removes its last carrier without a false alarm", async () => {
    success(
      await owner(
        "DELETE FROM public.org_role_assignments WHERE id = {cRole}; DELETE FROM public.org_member WHERE id = {cAdmin@C}; DELETE FROM public.organization WHERE id = {C}",
        true
      )
    )
  })
  // Р2c2-23: один оператор режиму обслуговування переносить призначення між
  // скоупами — старий і новий образи дають той самий ключ `assignment`, а два
  // старі рядки — по ключу `holders` свого скоупу; без зведення ключів
  // `ON CONFLICT` зачепив би рядок черги двічі (`21000`).
  it("a maintenance move across scopes checks the holders of every old scope", async () => {
    const swap =
      "UPDATE public.org_role_assignments SET org_id = CASE id WHEN {bRole} THEN {A}::uuid ELSE {B}::uuid END, subject = CASE id WHEN {bRole} THEN {bAdmin@A}::uuid ELSE {bAdmin@B}::uuid END WHERE id IN ({bRole}, {root2Role})"
    const client = tx.client()
    await client.query("SAVEPOINT scope_move")
    try {
      await client.query("SELECT set_config($1, 'on', true)", [
        RIGHTS_MAINTENANCE_SETTING,
      ])
      await client.query(sql(swap))
      const { rows } = await client.query<{ key: string }>(
        "SELECT key::text FROM simetra.rights_tx_pending WHERE xid = txid_current() AND kind = 'holders'"
      )
      expect(rows.map((row) => row.key).sort()).toEqual(
        [key("A"), key("B")].sort()
      )
      // Обидва скоупи лишаються з носієм — перевірка на COMMIT проходить
      await client.query("SET CONSTRAINTS ALL IMMEDIATE")
    } finally {
      await client.query("ROLLBACK TO SAVEPOINT scope_move")
    }
    // Перенесення єдиного носія B лишає B без носія — ключ старого скоупу
    refusal(
      await owner(
        "UPDATE public.org_role_assignments SET org_id = {A}, subject = {bAdmin@A} WHERE id = {bRole}",
        true
      ),
      "last-full-access"
    )
  })
  // Підміна користувача в членстві з призначенням підробила б носія прав.
  it.each([
    ["member-repoint", "target@A", "outsider"],
    ["member-repoint-invite", "invite@A", "outsider"],
  ])("%s cannot forge an assigned member", async (_, row, user) => {
    refusal(
      await command(
        "memberEditor",
        ["update", "org_member", row],
        `UPDATE public.org_member SET user_id = {${user}} WHERE id = {${row}}`
      ),
      "effect"
    )
  })
  // Чинний учасник уже має рядок у скоупі: самоприйняття запрошеного рядка
  // Postgres відхиляє ключем UNIQUE (скоуп, користувач) членства ще до
  // тригера ефектів — умова «ще не учасник» тут другий рубіж.
  it("member-claim: an active member cannot take an invited row", async () => {
    expect(
      await command(
        "memberEditor",
        ["update", "org_member", "invite@A"],
        "UPDATE public.org_member SET user_id = {memberEditor} WHERE id = {invite@A}"
      )
    ).toMatchObject({ code: "23505" })
  })
  // Р2c2-26: самоприйняття рядка з призначеннями дає актору права без ключа
  // `assignment`; їх судить ключ `actor`. Політики не-учаснику скоупу
  // `update` на членстві не відкривають (права скоупу — лише в учасника, а в
  // учасника самоприйняття спиняє UNIQUE), тож кейс іде від власника таблиць.
  it.each([
    ["member-claim-assigned", "invite@A", "escalation"],
    ["member-claim-unassigned", "bareInvite@A", undefined],
  ] as const)("%s judges the actor's own increment", async (_, row, detail) => {
    const result = await inCommand(
      "outsider",
      ["update", "org_member", row],
      async (client) => {
        const { rowCount } = await client.query(
          sql(
            `UPDATE public.org_member SET user_id = {outsider} WHERE id = {${row}}`
          )
        )
        expect(rowCount).toBe(1)
        await client.query("SET CONSTRAINTS ALL IMMEDIATE")
      },
      true
    )
    if (detail === undefined) success(result)
    else refusal(result, detail)
  })
  // rights_mine() на COMMIT рахує права за поточними claims: інший актор
  // дав би чужий приріст, тож відмова, як у знімку.
  it("the actor check refuses claims changed before COMMIT", async () => {
    const id = randomUUID()
    refusal(
      await inCommand(
        "root",
        admin("org_role_assignments", id),
        async (client) => {
          await client.query(sql(assignSql(id, TASK_VIEWER_ID)))
          await client.query("SELECT set_config($1, $2, true)", [
            SESSION_CLAIMS_SETTING,
            JSON.stringify(claims("target")),
          ])
          await client.query("SET CONSTRAINTS ALL IMMEDIATE")
        }
      ),
      "rights-context"
    )
  })
  // Членство без призначень прав не несе — запобіжник його видалення не спиняє.
  it("deleting an unassigned member is allowed", async () => {
    changed(
      await command(
        "root",
        ["delete", "org_member", "other@A"],
        "DELETE FROM public.org_member WHERE id = {other@A} RETURNING id"
      )
    )
  })
  it.each([false, true])(
    "member-id-swap and users-id-swap refuse even in maintenance=%s",
    async (maintenance) => {
      const memberSwap =
        "UPDATE public.org_member SET id = CASE id WHEN {root@A} THEN {target@A}::uuid ELSE {root@A}::uuid END WHERE id IN ({root@A}, {target@A})"
      const usersSwap =
        "UPDATE public.users SET id = CASE id WHEN {root} THEN {target}::uuid ELSE {root}::uuid END WHERE id IN ({root}, {target})"
      // Незмінність ключа — тригер ключа таблиці виду (Рб1-4), той самий
      // для членства, «Користувачів» і будь-якого довідника чи документа.
      expect(await owner(memberSwap, maintenance)).toEqual(KEY_REFUSAL)
      expect(await owner(usersSwap, maintenance)).toEqual(KEY_REFUSAL)
    }
  )

  describe("the key of a kind table is immutable for any author", () => {
    // Рядки кейсів — без залежних: FK `NO ACTION` на змінений ключ відмовив
    // би `23503` раніше за тригер `AFTER` і сховав би, хто відмовляє. Задача
    // `K3` має рядки ТЧ, але її ключ не змінюється — лише ключі рядків ТЧ.
    const K1 = randomUUID()
    const K2 = randomUUID()
    const K3 = randomUUID()
    const L1 = randomUUID()
    const L2 = randomUUID()
    const rows = [
      `INSERT INTO public.task (id, org_id, project_id, date) VALUES ('${K1}', {A}, {P1}, now()), ('${K2}', {A}, {P1}, now()), ('${K3}', {A}, {P1}, now())`,
      `INSERT INTO public.${CHECKLIST_TABLE} (id, org_id, parent_id, line_number) VALUES ('${L1}', {A}, '${K3}', 1), ('${L2}', {A}, '${K3}', 2)`,
    ]
    const swap = (table: string, a: string, b: string) =>
      `UPDATE public.${table} SET id = CASE id WHEN '${a}'::uuid THEN '${b}'::uuid ELSE '${a}'::uuid END WHERE id IN ('${a}', '${b}')`
    const rekey = (table: string, a: string) =>
      `UPDATE public.${table} SET id = '${randomUUID()}' WHERE id = '${a}'`
    const cases: [string, string][] = [
      ["task-rekey", rekey("task", K1)],
      // Обмін одним `UPDATE`: PK не відкладений, тож без `BEFORE`-тригера
      // перший рядок дав би `23505`, а не названу відмову.
      ["task-swap", swap("task", K1, K2)],
      ["section-rekey", rekey(CHECKLIST_TABLE, L1)],
      ["section-swap", swap(CHECKLIST_TABLE, L1, L2)],
    ]
    /** Рядки кейсів і оператор — одним запитом власника. */
    const withRows = (statement: string) => [...rows, statement].join(";\n")

    it.each(
      cases.flatMap(([name, statement]) =>
        [false, true].map((m) => [name, m, statement] as const)
      )
    )(
      "%s refuses the owner outside a command, maintenance=%s",
      async (_, maintenance, statement) => {
        expect(await owner(withRows(statement), maintenance)).toEqual(
          KEY_REFUSAL
        )
      }
    )

    it.each(cases)("%s refuses under a command too", async (_, statement) => {
      // Рядки кейсу — до контексту: вставка під контекстом іншого кореня —
      // відмова ефектів, а не предмет кейсу. Далі власник таблиць під
      // контекстом: RLS і поколонковий грант (ключа в гранті `UPDATE` немає)
      // не заступають тригера — відмовляє саме ключ.
      const client = tx.client()
      await client.query("SAVEPOINT key_command")
      try {
        await client.query(sql(rows.join(";\n")))
        await client.query("SELECT set_config($1, $2, true)", [
          SESSION_CLAIMS_SETTING,
          JSON.stringify(claims("root")),
        ])
        await context(client, ["update", "task", K3])
        await expect(client.query(sql(statement))).rejects.toMatchObject(
          KEY_REFUSAL
        )
      } finally {
        await client.query("ROLLBACK TO SAVEPOINT key_command")
      }
    })

    it("a handler that rewrites NEW.id after the key trigger is refused", async () => {
      // Обробник `beforeWrite` сортується після `simetra_key` (`zz_…`), тож
      // `BEFORE`-тригер ключа бачить незмінений `id`; відмовляє `AFTER`.
      const handler = [
        "CREATE FUNCTION public.zz_rekey() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.id := gen_random_uuid(); RETURN NEW; END $$",
        "CREATE TRIGGER task_zz_rekey BEFORE UPDATE ON public.task FOR EACH ROW EXECUTE FUNCTION public.zz_rekey()",
        `UPDATE public.task SET date = now() WHERE id = '${K1}'`,
      ]
      expect(await owner(withRows(handler.join(";\n")))).toEqual(KEY_REFUSAL)
    })

    it("a row without a key change passes", async () => {
      changed(
        await owner(
          withRows(
            `UPDATE public.task SET date = now() WHERE id = '${K1}' RETURNING id`
          )
        )
      )
    })
  })
  it.each([false, true])(
    "member-reinsert refuses user substitution in maintenance=%s",
    async (maintenance) => {
      refusal(
        await owner(
          "WITH d AS (DELETE FROM public.org_member WHERE id = {root2@A} RETURNING id, org_id) INSERT INTO public.org_member (id, org_id, user_id) SELECT id, org_id, {outsider} FROM d",
          maintenance
        ),
        "rights-context"
      )
    }
  )
  it("TRUNCATE is guarded, including maintenance", async () => {
    refusal(
      await owner("TRUNCATE public.org_role_assignments"),
      "rights-context"
    )
    refusal(
      await owner("TRUNCATE public.org_role_assignments", true),
      "rights-context"
    )
    expect(await owner("TRUNCATE public.org_member")).toMatchObject({
      code: "0A000",
    })
    refusal(
      await owner("TRUNCATE public.org_member CASCADE", true),
      "rights-context"
    )
  })
  it("owner cannot repoint members or reactivate users without context", async () => {
    refusal(
      await owner(
        "UPDATE public.org_member SET user_id = {outsider} WHERE id = {target@A}"
      ),
      "rights-context"
    )
    refusal(
      await owner(
        "UPDATE public.org_member SET user_id = {outsider} WHERE id = {invite@A}"
      ),
      "rights-context"
    )
    await tx.client().query("SAVEPOINT owner_invalid")
    try {
      await tx
        .client()
        .query("UPDATE public.users SET invalid = true WHERE id = $1", [
          key("other"),
        ])
      refusal(
        await owner(
          "UPDATE public.users SET invalid = false WHERE id = {other}"
        ),
        "rights-context"
      )
      success(
        await owner(
          "UPDATE public.users SET invalid = false WHERE id = {other}",
          true
        )
      )
    } finally {
      await tx.client().query("ROLLBACK TO SAVEPOINT owner_invalid")
    }
    success(
      await owner("UPDATE public.users SET invalid = true WHERE id = {target}")
    )
    success(
      await owner(
        "UPDATE public.org_member SET user_id = {outsider} WHERE id = {target@A}",
        true
      )
    )
    success(
      await owner(
        "UPDATE public.org_member SET user_id = {outsider} WHERE id = {invite@A}",
        true
      )
    )
  })
  // `invalid` вимикає людину для прав, тож звичайна команда оновлення
  // «Користувачів» його не змінює.
  it("a Users update command cannot change invalid", async () => {
    refusal(
      await command(
        "gAdmin",
        ["update", "users", "target"],
        "UPDATE public.users SET invalid = true WHERE id = {target}"
      ),
      "effect"
    )
  })
  it("the role check is rearmed when an assignment changes later", async () => {
    const id = randomUUID()
    refusal(
      await inCommand(
        "root",
        admin("org_roles", "unusedCustom"),
        async (client) => {
          await client.query(
            sql(
              "UPDATE public.org_roles SET deletion_mark = true WHERE id = {unusedCustom}"
            )
          )
          await client.query("SET CONSTRAINTS ALL IMMEDIATE")
          await client.query("SET CONSTRAINTS ALL DEFERRED")
          await context(client, admin("org_role_assignments", id))
          await client.query(
            sql(
              `INSERT INTO public.org_role_assignments (id, org_id, subject, custom_role) VALUES ('${id}', {A}, {target@A}, {unusedCustom})`
            )
          )
          await client.query("SET CONSTRAINTS ALL IMMEDIATE")
        }
      ),
      "role-in-use"
    )
  })

  it("the first of two assignment images is the comparison baseline", async () => {
    refusal(
      await inCommand(
        "admin",
        admin("org_role_assignments", "targetRole"),
        async (client) => {
          await client.query(
            sql(
              `UPDATE public.org_role_assignments SET archetype = '${TASK_EDITOR_ID}' WHERE id = {targetRole}`
            )
          )
          await client.query(
            sql(
              "UPDATE public.org_role_assignments SET deletion_mark = false WHERE id = {targetRole}"
            )
          )
          await client.query("SET CONSTRAINTS ALL IMMEDIATE")
        }
      ),
      "escalation"
    )
  })

  it("journal records the actor, relation, transaction and row images", async () => {
    const result = await commandAs<{ id: string }>(
      tx.client(),
      claims("root"),
      {
        action: "administerRights",
        object: "org_roles",
        root: key("unusedCustom"),
      },
      sql(
        'UPDATE public.org_roles SET "order" = 11 WHERE id = {unusedCustom} RETURNING id'
      ),
      {
        after: sql(
          "SELECT actor, reason, action, object, relation, xid::text, before, after FROM simetra.rights_journal WHERE row_id = {unusedCustom} AND xid = txid_current() ORDER BY seq DESC LIMIT 1"
        ),
      }
    )
    success(result)
    if (!("after" in result)) throw new Error("journal probe missing")
    expect(result.rows).toHaveLength(1)
    expect(result.after).toEqual([
      expect.objectContaining({
        actor: key("root"),
        reason: "command",
        action: "administerRights",
        object: "org_roles",
        relation: "public.org_roles",
        before: expect.objectContaining({ id: key("unusedCustom") }),
        after: expect.objectContaining({ id: key("unusedCustom"), order: 11 }),
      }),
    ])
    expect((result.after?.[0] as { xid?: string })?.xid).toMatch(/^\d+$/)
    const delta = randomUUID()
    const deltaJournal = await commandAs(
      tx.client(),
      claims("root"),
      {
        action: "administerRights",
        object: "org_roles",
        root: key("unusedCustom"),
      },
      sql(
        `INSERT INTO public.org_roles_delta (id, org_id, parent_id, line_number, object, action, extent, effect) VALUES ('${delta}', {A}, {unusedCustom}, 1, 'task', 'update', 'any', 'deny')`
      ),
      {
        after: `SELECT relation, parent_id, before, after FROM simetra.rights_journal WHERE row_id = '${delta}' ORDER BY seq DESC LIMIT 1`,
      }
    )
    success(deltaJournal)
    if (!("after" in deltaJournal))
      throw new Error("delta journal probe missing")
    expect(deltaJournal.after).toEqual([
      expect.objectContaining({
        relation: "public.org_roles_delta",
        parent_id: key("unusedCustom"),
        before: null,
        after: expect.objectContaining({ id: delta }),
      }),
    ])
  })

  it("a journal check failure rolls the rights write back", async () => {
    const client = tx.client()
    await client.query("SAVEPOINT journal_failure")
    try {
      await client.query(
        "ALTER TABLE simetra.rights_journal ADD CONSTRAINT journal_reject_test CHECK (false) NOT VALID"
      )
      const id = randomUUID()
      const result = await command(
        "root",
        admin("org_role_assignments", id),
        assignSql(id, TASK_VIEWER_ID)
      )
      expect(result).toMatchObject({ code: "23514" })
      const { rows } = await client.query<{ n: number }>(
        "SELECT (SELECT count(*) FROM public.org_role_assignments WHERE id = $1)::int + (SELECT count(*) FROM simetra.rights_journal WHERE row_id = $1)::int AS n",
        [id]
      )
      expect(rows[0]?.n).toBe(0)
    } finally {
      await client.query("ROLLBACK TO SAVEPOINT journal_failure")
    }
  })

  it("versions advance once per statement and the API exposes only a member's scopes", async () => {
    const client = tx.client()
    await client.query("SAVEPOINT version_probe")
    try {
      const version = async (scope: string) => {
        const { rows } = await client.query<{ version: string }>(
          "SELECT version::text FROM simetra.rights_versions WHERE scope = $1",
          [scope]
        )
        return Number(rows[0]?.version ?? 0)
      }
      let previous = await version(key("A"))
      const untouched = await version(key("B"))
      await insert(client, "org_role_assignments", {
        org_id: key("A"),
        ...assignmentRow(key("target@A"), { archetype: TASK_VIEWER_ID }),
      })
      expect(await version(key("A"))).toBe(++previous)
      expect(await version(key("B"))).toBe(untouched)
      await insert(
        client,
        "org_roles_delta",
        orgDeltaRow(key("A"), key("unusedCustom"), 1, [
          "deny",
          "task",
          "update",
          "dimension",
          REGION_DIMENSION_ID,
        ])
      )
      expect(await version(key("A"))).toBe(++previous)
      await insert(client, "org_member", {
        id: randomUUID(),
        org_id: key("A"),
        user_id: null,
      })
      expect(await version(key("A"))).toBe(++previous)
      await insert(client, "member_region", {
        org_id: key("A"),
        member_id: key("root@A"),
        region_id: key("R1"),
      })
      expect(await version(key("A"))).toBe(++previous)
      const api = await queryAs<{ scope: string; version: string }>(
        client,
        "authenticated",
        claims("root"),
        "SELECT scope, version::text FROM simetra.rights_versions()"
      )
      expect(api).toMatchObject({
        rows: expect.arrayContaining([
          { scope: key("A"), version: String(previous) },
        ]),
      })
      if (!("rows" in api)) throw new Error("rights_versions API refused")
      expect(api.rows.map((row) => row.scope).sort()).toEqual(
        [key("A"), ZERO].sort()
      )
      const beforeGlobal = await version(ZERO)
      await insert(
        client,
        "global_role_assignments",
        assignmentRow(key("other"), { archetype: GLOBAL_ADMIN_ID })
      )
      expect(await version(ZERO)).toBe(beforeGlobal + 1)
      const ownerView = await client.query<{ scope: string }>(
        "SELECT scope FROM simetra.rights_versions()"
      )
      expect(ownerView.rows.map((r) => r.scope)).toEqual([ZERO])
    } finally {
      await client.query("ROLLBACK TO SAVEPOINT version_probe")
    }
  })

  it("the actor snapshot and pending keys are cleaned after two commands", async () => {
    const [first, second] = [randomUUID(), randomUUID()]
    success(
      await inCommand(
        "root",
        admin("org_role_assignments", first),
        async (client) => {
          await client.query(sql(assignSql(first, TASK_VIEWER_ID)))
          await context(client, admin("org_role_assignments", second))
          await client.query(sql(assignSql(second, TASK_VIEWER_ID, "other@A")))
          // Оператор обслуговування — поза командою: з контекстом його судив
          // би тригер ефектів як некореневий запис команди
          await client.query("RESET ROLE")
          await client.query("SELECT set_config($1, '', true)", [
            COMMAND_SETTING,
          ])
          await client.query("SELECT set_config($1, 'on', true)", [
            RIGHTS_MAINTENANCE_SETTING,
          ])
          await client.query(
            sql(
              'UPDATE public.org_roles SET "order" = 9 WHERE id = {unusedCustom}'
            )
          )
          await client.query("SELECT set_config($1, 'off', true)", [
            RIGHTS_MAINTENANCE_SETTING,
          ])
          await client.query("SET CONSTRAINTS ALL IMMEDIATE")
          const { rows } = await client.query<{ n: number }>(PENDING_ROWS)
          expect(rows[0]?.n).toBe(0)
        }
      )
    )
  })

  it("IMMEDIATE mode does not lose the actor snapshot", async () => {
    const id = randomUUID()
    success(
      await inCommand(
        "admin",
        admin("org_role_assignments", id),
        async (client) => {
          await client.query("SET CONSTRAINTS ALL IMMEDIATE")
          await client.query(sql(assignSql(id, TASK_VIEWER_ID)))
          await client.query("RESET ROLE")
          const { rows } = await client.query<{ n: number }>(PENDING_ROWS)
          expect(rows[0]?.n).toBe(0)
        }
      )
    )
  })

  it("membership-only transactions release their actor snapshot", async () => {
    success(
      await inCommand(
        "memberEditor",
        ["update", "org_member", "other@A"],
        async (client) => {
          // Рядок справді змінено: інакше тригери оператора без рядків нічого б не довели
          const { rowCount } = await client.query(
            sql(
              "UPDATE public.org_member SET user_id = user_id WHERE id = {other@A}"
            )
          )
          expect(rowCount).toBe(1)
          await client.query("SET CONSTRAINTS ALL IMMEDIATE")
          await client.query("RESET ROLE")
          const { rows } = await client.query<{ n: number }>(PENDING_ROWS)
          expect(rows[0]?.n).toBe(0)
        }
      )
    )
  })
})

describe("maintenance from provider API logins", () => {
  it("a postgres-owned definer cannot enable maintenance through API sessions", async () => {
    const compiled = await compileRights(
      policyDomain(writeRoles(), adminRoles())
    )
    expect(compiled.diagnostics).toEqual([])
    await withRollback(async (client) => {
      await client.query("SET ROLE postgres")
      await client.query(renderDesiredState(compiled.model!).sql)
      const org = randomUUID()
      const member = randomUUID()
      const user = await signUp(client)
      await insert(client, "organization", { id: org })
      await insert(client, "org_member", {
        id: member,
        org_id: org,
        user_id: user,
      })
      await client.query(`CREATE FUNCTION public.debt_grant(p_subject uuid) RETURNS void
        LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
        BEGIN
          PERFORM set_config('${RIGHTS_MAINTENANCE_SETTING}', 'on', true);
          INSERT INTO public.org_role_assignments (id, org_id, subject, archetype)
          VALUES (gen_random_uuid(), '${org}', p_subject, '${TASK_VIEWER_ID}');
        END $$`)
      await client.query(
        "GRANT EXECUTE ON FUNCTION public.debt_grant(uuid) TO authenticated"
      )
      await client.query("RESET ROLE")
      const probe = async (login: string, expected?: string) => {
        await client.query("SAVEPOINT api_login")
        try {
          await client.query(`SET SESSION AUTHORIZATION ${login}`)
          if (login !== "postgres") await client.query("SET ROLE authenticated")
          const identity = await client.query<{ login: string; role: string }>(
            "SELECT session_user AS login, current_user AS role"
          )
          expect(identity.rows[0]).toEqual({
            login,
            role: login === "postgres" ? "postgres" : "authenticated",
          })
          let failure: pg.DatabaseError | undefined
          try {
            await client.query("SELECT public.debt_grant($1)", [member])
            await client.query("SET CONSTRAINTS ALL IMMEDIATE")
          } catch (error) {
            if (!(error instanceof pg.DatabaseError)) throw error
            failure = error
          }
          if (expected === undefined) expect(failure).toBeUndefined()
          else
            expect(failure).toMatchObject({ code: "42501", detail: expected })
        } finally {
          await client.query("ROLLBACK TO SAVEPOINT api_login")
        }
      }
      await probe("postgres")
      await probe("authenticator", "rights-context")
      await probe("supabase_admin", "rights-context")
    }, testSuperuserUrl())
  }, 120_000)
})
