import { randomUUID } from "node:crypto"
import pg from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { CompiledModel } from "simetra/compiler"
import {
  PLATFORM_LOGIN_ROLES,
  PLATFORM_ROLES,
  RIGHTS_MAINTENANCE_SETTING,
  type CommandContext,
} from "simetra/model"
import { renderDesiredState } from "simetra/schema"
import {
  NOTE_LONG,
  NOTE_LONG_WRITER_ID,
  NOTE_WRITER_ID,
  authorCarrier,
  compileRights,
  singleTenantRights,
} from "../../src/compiler/__tests__/fixtures/rights"
import { signUp } from "./auth"
import {
  type Refusal,
  commandAs,
  testSuperuserUrl,
  withRollback,
} from "./connection"
import {
  type Seed,
  assignmentRow,
  deploy,
  describeTransaction,
  insert,
} from "./rights-seed"

/**
 * Згенеровані гранти ролі команд і примушене авторство на справжньому
 * Postgres (спека П4 §6.2, §6.8, §6.16 інваріанти 1, 8, 9). Чи відмовляє привілей колонки, у якому порядку спрацьовують
 * `BEFORE`-тригери однакового часу і що бачить RLS, вирішує Postgres:
 * компілятор бачить лише текст. Повного гранту таблиць фікстури тут немає —
 * діють лише згенеровані гранти; членство з `SET` у ролі команд опис дає
 * собі сам, бо його потребує `SET LOCAL ROLE` у `commandAs`.
 */

const NOTES_MODEL = () =>
  compileRights(
    singleTenantRights({ ...authorCarrier(), ...authorCarrier("long") })
  )

/** Відмова саме гранту: текст Postgres без деталі тригера чи політики. */
const GRANT_DENIAL = {
  code: "42501",
  message: expect.stringMatching(/^permission denied for (table|column) /),
} as unknown as Refusal

describe("generated grants of the command role", () => {
  const tx = describeTransaction()
  let ids: Seed = {}

  beforeAll(async () => {
    const result = await NOTES_MODEL()
    expect(result.diagnostics).toEqual([])
    const client = await tx.open()
    await deploy(client, result.model!)
    await client.query(
      `GRANT ${PLATFORM_ROLES.command} TO CURRENT_USER WITH SET TRUE`
    )
    // U і V — автори з різними наставниками (M1, M2): копія носія
    // `createdBy.mentor` розрізняє, чий автор у рядку. H — історичний автор.
    ids = {}
    for (const user of ["U", "V", "H", "M1", "M2"])
      ids[user] = await signUp(client)
    for (const [user, mentor] of [
      ["U", "M1"],
      ["V", "M2"],
    ] as const)
      await client.query(
        "UPDATE public.users SET mentor_id = $1 WHERE id = $2",
        [ids[mentor], ids[user]]
      )
    for (const user of ["U", "V"])
      for (const archetype of [NOTE_WRITER_ID, NOTE_LONG_WRITER_ID])
        await insert(
          client,
          "global_role_assignments",
          assignmentRow(ids[user]!, { archetype })
        )
    // N1 пише власник без контексту: автор лишається тим, кого вказано
    ids.N1 = randomUUID()
    await insert(client, "note", {
      id: ids.N1,
      text: "n",
      created_by_id: ids.U,
      updated_by_id: ids.U,
    })
    ids.L1 = randomUUID()
    await insert(client, "note_lines", {
      id: ids.L1,
      parent_id: ids.N1,
      line_number: 1,
      text: "l",
    })
  })

  afterAll(() => tx.close())

  const key = (name: string) => {
    // Невідомий ключ дав би `NULL` замість id — і зелений кейс без причини
    const id = ids[name]
    if (id === undefined) throw new Error(`unknown seed key ${name}`)
    return id
  }
  const claims = (user: string) => ({ sub: key(user), role: "authenticated" })
  const ctx = (
    action: string,
    object: string,
    root: string
  ): CommandContext => ({
    action,
    object,
    root,
  })

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

  // Інваріант 8 (§6.16): колонки поза грантом прямий запис не змінює.
  // Деталь відсутня — відмова не від RLS чи тригера (`command.*`), а від
  // привілею, який перевіряє Postgres до політик і тригерів.
  it.each([
    [
      "update version",
      "update",
      "N1",
      "UPDATE public.note SET version = 5 WHERE id = {N1}",
    ],
    [
      "update created_by_id",
      "update",
      "N1",
      "UPDATE public.note SET created_by_id = {V} WHERE id = {N1}",
    ],
    [
      "insert created_by_id",
      "create",
      "new",
      "INSERT INTO public.note (id, text, created_by_id) VALUES ({new}, 'x', {U})",
    ],
    [
      "insert users",
      "create",
      "new",
      "INSERT INTO public.users (id) VALUES ({new})",
    ],
    [
      "delete catalog",
      "markDeletion",
      "N1",
      "DELETE FROM public.note WHERE id = {N1}",
    ],
    ["truncate", "update", "N1", "TRUNCATE public.note_lines"],
  ])("grant-denials: %s", async (_, action, root, sql) => {
    const fresh = randomUUID()
    const fill = (text: string) =>
      text.replace(
        /\{([^}]+)\}/g,
        (_, name: string) => `'${name === "new" ? fresh : key(name)}'`
      )
    const object = sql.includes("public.users") ? "users" : "note"
    const result = await commandAs(
      tx.client(),
      claims("U"),
      ctx(action, object, root === "new" ? fresh : key(root)),
      fill(sql)
    )
    expect(result).toEqual(GRANT_DENIAL)
  })

  // Рядок ТЧ видаляє команда власника: `DELETE` ТЧ є в гранті (§6.2)
  it("grant-denials: a tabular row delete is granted", async () => {
    const result = await commandAs(
      tx.client(),
      claims("U"),
      ctx("update", "note", key("N1")),
      "DELETE FROM public.note_lines WHERE id = $1 RETURNING id",
      { params: [key("L1")] }
    )
    expect(result).toEqual({ rows: [{ id: key("L1") }] })
  })

  // Інваріант 9: під командою автор — поточний користувач. Явний
  // `created_by_id` грант не пропускає, тож вставка без нього.
  it("author-forced", async () => {
    const fresh = randomUUID()
    const created = await commandAs(
      tx.client(),
      claims("U"),
      ctx("create", "note", fresh),
      "INSERT INTO public.note (id, text) VALUES ($1, 'x') RETURNING created_by_id, updated_by_id",
      { params: [fresh] }
    )
    expect(created).toEqual({
      rows: [{ created_by_id: key("U"), updated_by_id: key("U") }],
    })
    const updated = await commandAs(
      tx.client(),
      claims("V"),
      ctx("update", "note", key("N1")),
      "UPDATE public.note SET text = 'y' WHERE id = $1 RETURNING created_by_id, updated_by_id",
      { params: [key("N1")] }
    )
    expect(updated).toEqual({
      rows: [{ created_by_id: key("U"), updated_by_id: key("V") }],
    })
  })

  // Значення за замовчуванням і чужий `BEFORE`-тригер, що сортується раніше
  // за тригер авторства, не перебивають автора: тригер авторства — пізніший
  // за них, і порядок за іменем вирішує Postgres.
  it("author-not-overridden", async () => {
    const written = await probe(async (client) => {
      await client.query(
        "ALTER TABLE public.note ALTER COLUMN created_by_id SET DEFAULT $$" +
          key("H") +
          "$$::uuid"
      )
      await client.query(
        `CREATE FUNCTION public.probe_forge_author() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN
           NEW.created_by_id := '${key("H")}';
           NEW.updated_by_id := '${key("H")}';
           RETURN NEW;
         END $$`
      )
      await client.query(
        "CREATE TRIGGER note_a_forge BEFORE INSERT ON public.note FOR EACH ROW EXECUTE FUNCTION public.probe_forge_author()"
      )
      const fresh = randomUUID()
      return commandAs(
        client,
        claims("U"),
        ctx("create", "note", fresh),
        "INSERT INTO public.note (id, text) VALUES ($1, 'x') RETURNING created_by_id, updated_by_id",
        { params: [fresh] }
      )
    })
    expect(written).toEqual({
      rows: [{ created_by_id: key("U"), updated_by_id: key("U") }],
    })
  })

  // Без контексту (імпорт, мігратор) авторів пише той, хто пише рядок
  it("author-no-context", async () => {
    const written = await probe(async (client) => {
      const { rows } = await client.query<{ created_by_id: string }>(
        "INSERT INTO public.note (id, text, created_by_id) VALUES ($1, 'x', $2) RETURNING created_by_id",
        [randomUUID(), key("H")]
      )
      return rows
    })
    expect(written).toEqual([{ created_by_id: key("H") }])
  })

  // Копія носія `createdBy.mentor` виводиться з примушеного
  // автора лише тоді, коли тригер авторства спрацьовує раніше за тригер
  // носіїв — на 60-байтній назві теж (порядок за іменем вирішує Postgres).
  it.each([
    ["note", "note"],
    [NOTE_LONG, "note_long"],
  ])("author-carrier: %s", async (table, object) => {
    const fresh = randomUUID()
    const result = await commandAs(
      tx.client(),
      claims("U"),
      ctx("create", object, fresh),
      `INSERT INTO public.${table} (id, text) VALUES ($1, 'x') RETURNING created_by_id_mentor_id`,
      { params: [fresh] }
    )
    expect(result).toEqual({ rows: [{ created_by_id_mentor_id: key("M1") }] })
  })

  // Зміна лише `created_by_id` змінює й копію носія (у U і V
  // різні наставники), тож без колонок авторства в умові `WHEN` тригер
  // ефектів не спрацював би. Грант колонки — лише в цьому кейсі: інакше
  // відмовив би привілей, а не тригер.
  it("author-immutable", async () => {
    const result = await probe(async (client) => {
      await client.query(
        `GRANT UPDATE (created_by_id) ON public.note TO ${PLATFORM_ROLES.command}`
      )
      return commandAs(
        client,
        claims("U"),
        ctx("update", "note", key("N1")),
        "UPDATE public.note SET created_by_id = $1 WHERE id = $2",
        { params: [key("V"), key("N1")] }
      )
    })
    expect(result).toEqual({
      code: "42501",
      message: "command.forbidden",
      detail: "effect",
      column: "created_by_id",
    })
  })
})

/**
 * Справжня роль входу рантайму (спека П4 §7.2): режим обслуговування судить
 * `session_user`, тож тегована роль нічого не доводить — сесія тут іде від
 * кластерної `simetra_runtime` локального стеку (`supabase/roles.sql`).
 * `SET SESSION AUTHORIZATION` можливий лише від суперкористувача, тож
 * з'єднання — `supabase_admin`, а модель розгортається під `SET ROLE postgres`.
 */
describe("runtime login role", () => {
  const RUNTIME = PLATFORM_LOGIN_ROLES.runtime
  let model: CompiledModel

  beforeAll(async () => {
    const result = await NOTES_MODEL()
    expect(result.diagnostics).toEqual([])
    model = result.model!
  })

  it("has no direct rights and cannot enable maintenance", async () => {
    await withRollback(async (client) => {
      const { rows: present } = await client.query(
        "SELECT 1 FROM pg_roles WHERE rolname = $1",
        [RUNTIME]
      )
      if (present.length === 0)
        throw new Error(
          `role ${RUNTIME} is missing: it comes from supabase/roles.sql; apply it to the running stack as the header of that file says`
        )
      await client.query("SET ROLE postgres")
      await client.query(renderDesiredState(model).sql)
      const subject = await signUp(client)
      await client.query(`CREATE FUNCTION public.probe_maintenance_grant() RETURNS void
        LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
        BEGIN
          PERFORM set_config('${RIGHTS_MAINTENANCE_SETTING}', 'on', true);
          INSERT INTO public.global_role_assignments (id, subject, archetype)
          VALUES (gen_random_uuid(), '${subject}', '${NOTE_WRITER_ID}');
        END $$`)
      await client.query(
        `GRANT EXECUTE ON FUNCTION public.probe_maintenance_grant() TO ${PLATFORM_ROLES.command}`
      )
      await client.query("RESET ROLE")
      const tables = model.physical.tables.map((t) => `${t.schema}.${t.name}`)

      // (a) Інваріант 1 (§6.16) — каталогом, а не пробою: відмова `USAGE`
      // схеми маскувала б прямі гранти таблиць.
      await client.query("SAVEPOINT runtime_rights")
      try {
        await client.query(`SET SESSION AUTHORIZATION ${RUNTIME}`)
        const { rows } = await client.query<{ object: string }>(
          `SELECT n.nspname || '.' || c.relname AS object
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE (n.nspname || '.' || c.relname = ANY ($1::text[]) OR n.nspname = 'simetra')
              AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
              AND has_table_privilege($2, c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
           UNION ALL
           SELECT 'function ' || p.proname
             FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'simetra' AND has_function_privilege($2, p.oid, 'EXECUTE')
           UNION ALL
           SELECT 'schema simetra' WHERE has_schema_privilege($2, 'simetra', 'USAGE')`,
          [tables, RUNTIME]
        )
        expect(rows).toEqual([])
        // Перелік таблиць справді непорожній: інакше «жодного права» нічого б не довело
        expect(tables).toContain("public.note")
        let failure: unknown
        try {
          await client.query("SELECT id FROM public.note")
        } catch (error) {
          failure = error
        }
        expect(failure).toBeInstanceOf(pg.DatabaseError)
        expect(failure).toMatchObject({
          code: "42501",
          message: expect.stringMatching(/^permission denied for /),
        })
      } finally {
        await client.query("ROLLBACK TO SAVEPOINT runtime_rights")
      }

      // (b) Режим обслуговування не вмикається для сесії ролі входу
      // платформи; той самий зонд із сесії `postgres` проходить. `RESET` тут
      // не годиться: він повернув би `supabase_admin`, роль входу провайдера.
      const probe = async (login: string, expected?: string) => {
        await client.query("SAVEPOINT maintenance_login")
        try {
          await client.query(`SET SESSION AUTHORIZATION ${login}`)
          if (login === RUNTIME)
            await client.query(`SET ROLE ${PLATFORM_ROLES.command}`)
          const identity = await client.query<{ login: string }>(
            "SELECT session_user AS login"
          )
          expect(identity.rows[0]?.login).toBe(login)
          let failure: pg.DatabaseError | undefined
          try {
            await client.query("SELECT public.probe_maintenance_grant()")
            await client.query("SET CONSTRAINTS ALL IMMEDIATE")
          } catch (error) {
            if (!(error instanceof pg.DatabaseError)) throw error
            failure = error
          }
          if (expected === undefined) expect(failure).toBeUndefined()
          else
            expect(failure).toMatchObject({
              code: "42501",
              message: "command.forbidden",
              detail: expected,
            })
        } finally {
          await client.query("ROLLBACK TO SAVEPOINT maintenance_login")
        }
      }
      await probe(RUNTIME, "rights-context")
      await probe("postgres")
    }, testSuperuserUrl())
  }, 120_000)
})
