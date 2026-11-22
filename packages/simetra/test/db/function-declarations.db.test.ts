import { randomUUID } from "node:crypto"
import pg from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  applyChanges,
  compile,
  fixFiles,
  type CompileResult,
} from "simetra/compiler"
import { RIGHTS_REQUIRE_ERROR, type ApiRolePurpose } from "simetra/model"
import { renderDesiredState } from "simetra/schema"
import {
  ADOPTED_LEAD_KEY,
  ADOPTED_SUPPORT_KEY,
  DIMENSION_SQL,
  ORG_MEMBER_ROLE_ID,
  ROLE_FILE,
  TASK_WRITER_ID,
  adoptedSourcesDomain,
  policyDomain,
  compiledPolicyDomain,
  dimensionFunction,
  grant,
  objects,
  PROJECT_FILE,
  membersSource,
  without,
  writeRoles,
} from "../../src/compiler/__tests__/fixtures/rights"
import {
  acceptDebt,
  catalog,
  metaFiles,
  project,
  uuid,
} from "../../src/compiler/__tests__/helpers"
import {
  asRole,
  asStackSuperuser,
  claimsFor,
  queryAs,
  testRoleName,
  withRollback,
} from "./connection"
import { testProvider } from "./profile"
import { signUp } from "./auth"
import {
  GUARDED_FILES,
  expectNoGuardExecute,
} from "./function-declarations.support"
import {
  type Seed,
  assignmentRow,
  deploy,
  describeTransaction,
  insert,
  profileLayer,
} from "./rights-seed"

/**
 * `EXECUTE` задекларованих функцій, функцій значень виміру й функцій модуля
 * виду на справжньому Postgres (спека декларацій функцій §5.1, інваріанти
 * 1–3 плану Д1): чи виконує роль функцію, вирішує ACL бази після
 * застосування, а не текст грантів. Модель розгортається в транзакції тесту,
 * тож відкат прибирає все, що вона створила.
 */

const closedFn = (name: string, args = "") =>
  `CREATE FUNCTION ${name}(${args}) RETURNS int LANGUAGE sql STABLE SET search_path = '' AS $$ SELECT 1 $$;\n`

async function deployed(
  client: pg.Client,
  result: CompileResult
): Promise<void> {
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
  await client.query(renderDesiredState(result.model!).sql)
}

/** Проєкт з каталогом `Item` і файлами `entries` під провайдера стека. */
const compiled = (entries: Record<string, unknown>) =>
  compile(
    metaFiles({
      "project.meta.json": project({ database: { provider: testProvider() } }),
      "catalogs/Item/Item.meta.json": catalog("Item", { scope: "none" }),
      ...entries,
    })
  )

const declaredF = (callers: string[]) =>
  compiled({
    "sql/public/fns.sql": closedFn("public.f"),
    "sql/public/fns.functions.json": JSON.stringify({
      functions: [{ id: uuid(9501), function: { name: "f" }, callers }],
    }),
  })

/**
 * Ролі API, які є на кожному стеку. Сервісна є лише на `supabase`: її кейси —
 * у `function-declarations.supabase.db.test.ts`, а не пропуск за профілем тут.
 */
const API_PURPOSES = ["user", "anonymous"] as const

/** Код відмови чи `ok` виклику `sql` від ролі API призначення `purpose`. */
async function callAs(
  client: pg.Client,
  purpose: ApiRolePurpose,
  sql: string
): Promise<string> {
  const result = await queryAs(
    client,
    purpose,
    claimsFor(purpose, purpose === "anonymous" ? undefined : randomUUID()),
    sql
  )
  return "code" in result ? result.code : "ok"
}

describe("EXECUTE of a declared function in Postgres", () => {
  it("callers user: the user role executes, anon and a role without a grant get 42501", async () => {
    await withRollback(async (client) => {
      await deployed(client, await declaredF(["user"]))
      expect(await callAs(client, "user", "SELECT public.f()")).toBe("ok")
      expect(await callAs(client, "anonymous", "SELECT public.f()")).toBe(
        "42501"
      )
      const role = testRoleName("nodecl")
      // Роль створює суперкористувач стека: власник профілю ролей не створює.
      // Роль створено в транзакції тесту: відкат прибирає її на будь-якому шляху.
      await asStackSuperuser(client, () => client.query(`CREATE ROLE ${role}`))
      await client.query("SAVEPOINT probe")
      try {
        await client.query(`SET LOCAL ROLE ${role}`)
        await expect(client.query("SELECT public.f()")).rejects.toMatchObject({
          code: "42501",
        })
      } finally {
        await client.query("ROLLBACK TO SAVEPOINT probe")
      }
    })
  })

  it("no callers: no API role executes it", async () => {
    await withRollback(async (client) => {
      await deployed(client, await declaredF([]))
      for (const purpose of API_PURPOSES)
        expect([
          purpose,
          await callAs(client, purpose, "SELECT public.f()"),
        ]).toEqual([purpose, "42501"])
    })
  })
})

describe("EXECUTE of a dimension value function in Postgres", () => {
  it("the user role gets 42501 on a direct call", async () => {
    await withRollback(async (client) => {
      await deployed(
        client,
        await compiledPolicyDomain({ "sql/public/region.sql": DIMENSION_SQL }, [
          dimensionFunction(),
          profileLayer(),
        ])
      )
      expect(
        await callAs(client, "user", "SELECT * FROM public.region_ids()")
      ).toBe("42501")
    })
  })
})

describe("EXECUTE of an undeclared module function in Postgres", () => {
  it("a module function with a parameter is executable by no API role", async () => {
    await withRollback(async (client) => {
      await deployed(
        client,
        await compiled({
          "catalogs/Item/Item.sql": closedFn("public.item_total", "p_id uuid"),
        })
      )
      for (const purpose of API_PURPOSES)
        expect([
          purpose,
          await callAs(
            client,
            purpose,
            "SELECT public.item_total(gen_random_uuid())"
          ),
        ]).toEqual([purpose, "42501"])
    })
  })
})

describe("EXECUTE of the call guard functions in Postgres", () => {
  it("no application role holds EXECUTE on them", async () => {
    await withRollback(async (client) => {
      await deployed(
        client,
        await compiledPolicyDomain(GUARDED_FILES, [profileLayer()])
      )
      await expectNoGuardExecute(client, testProvider())
    })
  })
})

/** Відмова запобіжника: SQLSTATE, повідомлення й причина — коди, не текст для людини. */
interface Refusal {
  code: string
  message: string
  detail: string
}
const REFUSED: Refusal = {
  code: RIGHTS_REQUIRE_ERROR.errcode,
  message: RIGHTS_REQUIRE_ERROR.message,
  detail: RIGHTS_REQUIRE_ERROR.noRight,
}

/**
 * Виклик `sql` від ролі користувача з `sub` = `actor` у точці збереження:
 * `ok` або відмова (код, повідомлення, причина). `queryAs` віддає лише код, а
 * запобіжник — це код разом із `rights.forbidden` і `no-right`.
 */
async function asActor(
  client: pg.Client,
  actor: string,
  sql: string,
  params: unknown[] = []
): Promise<"ok" | Refusal> {
  await client.query("SAVEPOINT as_actor")
  try {
    await asRole(client, "user", claimsFor("user", actor))
    await client.query(sql, params)
    return "ok"
  } catch (error) {
    if (!(error instanceof pg.DatabaseError)) throw error
    return {
      code: error.code!,
      message: error.message,
      detail: error.detail!,
    }
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT as_actor")
  }
}

type GuardTarget = "row" | "scope"

/** Задекларовані definer-функції: ім'я, дія, об'єкт, ціль. */
const GUARDS: [string, string, string, string, GuardTarget][] = [
  ["g_bulletin_read", "read", "Catalog", "Bulletin", "row"],
  ["g_task_create", "create", "Document", "Task", "scope"],
  ["g_task_post", "post", "Document", "Task", "scope"],
  ["g_task_read", "read", "Document", "Task", "row"],
  ["g_users_read", "read", "Catalog", "Users", "row"],
  ["g_users_update", "update", "Catalog", "Users", "row"],
]
const LABELS: Record<string, string> = {
  Task: "task",
  Users: "users",
  Bulletin: "bulletin",
}

/** SQL і декларації `GUARDS`: кожна функція кличе запобіжник першим оператором. */
function guardFiles(
  only: readonly string[] = GUARDS.map(([name]) => name)
): Record<string, string> {
  const guards = GUARDS.filter(([name]) => only.includes(name))
  const sql = guards
    .map(([name, action, , object, target]) => {
      const guard = target === "row" ? "rights_require" : "rights_require_scope"
      return `CREATE FUNCTION public.${name}(p_${target} uuid) RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$BEGIN PERFORM simetra.${guard}('${action}', '${LABELS[object]}', p_${target}); END$$;\n`
    })
    .join("")
  const functions = guards.map(([name, action, kind, object, target], i) => ({
    id: uuid(9600 + i),
    function: { name },
    callers: ["user"],
    check: {
      action,
      object: { kind, name: object },
      [target]: `p_${target}`,
    },
  }))
  return {
    "sql/public/guards.sql": sql,
    "sql/public/guards.functions.json": JSON.stringify({ functions }),
  }
}

/**
 * Джерело членства без колонки активності: права бачать і неактивний рядок
 * членства, а функція множини виду `org` (`org_ids`) його не бачить — вона
 * вужча за джерело, як у знімка гостей. Предикат права тоді пропускає скоуп,
 * якого немає серед скоупів межі тенанта, тож лише ця межа відсікає рядок
 * чужого тенанта. Призначення контейнера цього не показує: воно враховується
 * лише в скоупі контейнера, а рядок контейнера чужого тенанта неможливий
 * (складений FK), тож предикат контейнера сам не пропускає чужий скоуп.
 */
const narrowTenantSet = () => ({
  [PROJECT_FILE]: {
    membershipSources: [
      membersSource({ columns: { scope: "orgId", user: "userId" } }),
    ],
  },
})

/**
 * Роль `Support` над прийнятим джерелом глобальних призначень: читання й
 * зміна «Користувачів» на глобальному рівні (поза скоупами).
 */
const supportUsers = () => ({
  [ROLE_FILE("Support")]: {
    sourceKeys: [{ source: "globalGrants", key: ADOPTED_SUPPORT_KEY }],
    grants: [grant(objects(["Catalog", "Users"]), ["read", "update"], "any")],
  },
})

describe("the call guard in Postgres", () => {
  const tx = describeTransaction()
  let ids: Seed = {}

  beforeAll(async () => {
    const files = adoptedSourcesDomain(
      profileLayer(),
      writeRoles(),
      supportUsers(),
      narrowTenantSet()
    )
    for (const [path, text] of Object.entries(guardFiles()))
      files.set(path, text)
    const result = await compile(await acceptDebt(files))
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
    const client = await tx.open()
    await deploy(client, result.model!)
    ids = await seedGuardGrid(client)
  })

  afterAll(() => tx.close())

  /** Виклик `fn` від актора `who` на цілі `key` (ключ засіву, `NULL` чи довільний uuid). */
  const call = (who: string, fn: string, key: string | null) =>
    asActor(tx.client(), ids[who]!, `SELECT public.${fn}($1)`, [
      key === null ? null : (ids[key] ?? key),
    ])

  // Postgres судить, чи пропускає умова гілки: рядки × актори. Відмова — та
  // сама для відсутності права, чужого тенанта, відсутнього рядка й `NULL`.
  // У `uf` право читання в B є (неактивне членство бачать лише права), а
  // межа тенанта B не бачить. Мутація: прибрати межу тенанта з гілки `row` —
  // `uf` на `tB` проходить. `u1` на `tB` (призначення контейнера PB) відмову
  // дає й без межі: див. коментар `narrowTenantSet`.
  it.each([
    ["u1", "t1", "ok"],
    ["u1", "t2", REFUSED],
    ["u1", "tB", REFUSED],
    ["u5", "t1", REFUSED],
    ["u3", "tB", "ok"],
    ["u3", "t1", REFUSED],
    ["u7", "t1", "ok"],
    ["u7", "t2", "ok"],
    ["u7", "tB", REFUSED],
    ["uf", "t1", "ok"],
    ["uf", "tB", REFUSED],
    ["u7", "00000000-0000-4000-8000-000000000000", REFUSED],
    ["u7", null, REFUSED],
  ] as const)("row target: %s on %s", async (who, key, expected) => {
    expect(await call(who, "g_task_read", key)).toEqual(expected)
  })

  // Та сама сітка: рядок, який політика читання показує ролі, проходить
  // запобіжник, а невидимий — ні (умова гілки — OR усіх предикатів, а не
  // перший з них: `u1` бачить `t1` лише через контейнер, `u7` — через `any`).
  // Мутація: замінити OR предикатів першим предикатом.
  it("the guard passes exactly the rows the read policy shows", async () => {
    const client = tx.client()
    const byKey = new Map(Object.entries(ids).map(([k, v]) => [v, k]))
    const literal: Record<string, (string | undefined)[]> = {}
    for (const who of ["u1", "u3", "u5", "u7", "uf"]) {
      await client.query("SAVEPOINT visible")
      let rows: { id: string }[]
      try {
        await asRole(client, "user", claimsFor("user", ids[who]))
        rows = (
          await client.query<{ id: string }>("SELECT id FROM public.task")
        ).rows
      } finally {
        await client.query("ROLLBACK TO SAVEPOINT visible")
      }
      const shown = rows.map((r) => r.id).sort()
      const passed: string[] = []
      for (const key of ["t1", "t2", "tB"])
        if ((await call(who, "g_task_read", key)) === "ok")
          passed.push(ids[key]!)
      expect([who, passed.sort()]).toEqual([who, shown])
      literal[who] = shown.map((id) => byKey.get(id)).sort()
    }
    expect(literal).toEqual({
      u1: ["t1"],
      u3: ["tB"],
      u5: [],
      u7: ["t1", "t2"],
      uf: ["t1", "t2"],
    })
  })

  // Ціль `scope`: `create` у своєму скоупі з правом `any` проходить; чужий
  // скоуп, скоуп без права, відсутній скоуп, `NULL` і право лише `own`
  // (`post` — `own` у `TaskWriter`) — відмова; так само `uf` з правом у B через
  // неактивне членство (його бачать лише права). Мутації: дозволити обсяг `own`
  // у гілці `scope`; прибрати межу тенанта з гілки `scope` — `uf` у B проходить.
  it.each([
    ["uw", "g_task_create", "A", "ok"],
    ["uw", "g_task_create", "B", REFUSED],
    ["uw", "g_task_create", "00000000-0000-4000-8000-000000000000", REFUSED],
    ["uw", "g_task_create", null, REFUSED],
    ["u7", "g_task_create", "A", REFUSED],
    ["u5", "g_task_create", "A", REFUSED],
    ["uw", "g_task_post", "A", REFUSED],
    ["uf", "g_task_create", "B", REFUSED],
  ] as const)("scope target: %s %s on %s", async (who, fn, key, expected) => {
    expect(await call(who, fn, key)).toEqual(expected)
  })

  // «Користувачі»: межа видимих користувачів. `u3` читає `Users` в обсязі
  // `any` свого скоупа, але `u1` йому невидимий. Мутація: прибрати межу
  // «Користувачів» з гілки читання.
  it.each([
    ["u7", "u1", "ok"],
    ["u3", "u3", "ok"],
    ["u3", "u1", REFUSED],
    ["u3", null, REFUSED],
  ] as const)("Users read: %s on %s", async (who, key, expected) => {
    expect(await call(who, "g_users_read", key)).toEqual(expected)
  })

  // `update` наявного рядка бере й межі читання: Postgres застосовує політики
  // `SELECT` до наявних рядків `UPDATE`. `us` має `update` «Користувачів»
  // глобально, але чужого скоупа користувача не бачить. Мутація: гілка
  // `update` без `readBoundaries`.
  it.each([
    ["us", "us", "ok"],
    ["us", "u1", REFUSED],
    ["u7", "u1", REFUSED],
  ] as const)("Users update: %s on %s", async (who, key, expected) => {
    expect(await call(who, "g_users_update", key)).toEqual(expected)
  })

  // Об'єкт з `publicRead` (пара лише з викликачем `user`): умова гілки читання
  // — RLS, без меж тенанта й предикатів. Мутація: додати межу тенанта до
  // `read` об'єкта з `publicRead`.
  it.each([
    ["u5", "ok"],
    ["u3", "ok"],
    ["us", "ok"],
  ] as const)(
    "publicRead read: %s sees the bulletin row",
    async (who, expected) => {
      const client = tx.client()
      await client.query("SAVEPOINT shown")
      let rows: unknown[]
      try {
        await asRole(client, "user", claimsFor("user", ids[who]))
        rows = (await client.query("SELECT 1 FROM public.bulletin")).rows
      } finally {
        await client.query("ROLLBACK TO SAVEPOINT shown")
      }
      expect(rows).toHaveLength(1)
      expect(await call(who, "g_bulletin_read", "b1")).toBe(expected)
      expect(await call(who, "g_bulletin_read", null)).toEqual(REFUSED)
    }
  )

  // Невідома пара (мітка, дія) — відмова, а не дозвіл «за замовчуванням»;
  // функцію запобіжника кличе лише власник. Мутація: гілка «за замовчуванням
  // дозволити».
  it("an unknown pair is refused", async () => {
    const client = tx.client()
    for (const [action, label] of [
      ["read", "nope"],
      ["delete", "task"],
      ["read", "role_grant"],
    ]) {
      await client.query("SAVEPOINT refused")
      await expect(
        client.query("SELECT simetra.rights_require($1, $2, $3)", [
          action,
          label,
          ids.t1,
        ])
      ).rejects.toMatchObject({
        code: REFUSED.code,
        message: REFUSED.message,
        detail: REFUSED.detail,
      })
      await client.query("ROLLBACK TO SAVEPOINT refused")
    }
  })
})

/**
 * Сітка запобіжника над прийнятими джерелами. Тенанти A і B; проєкти P1, P2 в
 * A і PB в B; задачі t1 (A, P1), t2 (A, P2), tB (B, PB). Учасники: u1 і u5 —
 * лише A (u1 — `ProjectLead` на P1 і на PB рядками `RoleGrant`: контейнер
 * чужого тенанта), u7 — A з `OrgMember`, uw — A з `TaskWriter`, u3 — лише B з
 * `OrgMember`; us — без членства, глобальний `Support`. Об'єкт `Bulletin` має
 * `publicRead`: b1 в A.
 */
async function seedGuardGrid(client: pg.Client): Promise<Seed> {
  const ids: Seed = {}
  const make = async (
    key: string,
    table: string,
    values: Record<string, unknown> = {}
  ) => {
    ids[key] = randomUUID()
    await insert(client, table, { id: ids[key], ...values })
  }
  for (const user of ["u1", "u3", "u5", "u7", "uw", "us", "uf"])
    ids[user] = await signUp(client)
  await make("A", "organization")
  await make("B", "organization")
  for (const [user, org] of [
    ["u1", "A"],
    ["u5", "A"],
    ["u7", "A"],
    ["uw", "A"],
    ["uf", "A"],
    ["u3", "B"],
  ] as const)
    await make(`${user}@${org}`, "membership", {
      org_id: ids[org],
      user_id: ids[user],
      is_active: true,
    })
  // Неактивне членство в B: права його бачать, межа тенанта — ні
  await make("uf@B", "membership", {
    org_id: ids.B,
    user_id: ids.uf,
    is_active: false,
  })
  await make("P1", "project", { org_id: ids.A })
  await make("P2", "project", { org_id: ids.A })
  await make("PB", "project", { org_id: ids.B })
  for (const [key, org, project] of [
    ["t1", "A", "P1"],
    ["t2", "A", "P2"],
    ["tB", "B", "PB"],
  ] as const)
    await make(key, "task", {
      org_id: ids[org],
      date: new Date(),
      project_id: ids[project],
    })
  await make("b1", "bulletin", { org_id: ids.A, text: "x" })
  for (const project of ["P1", "PB"])
    await insert(client, "role_grant", {
      id: randomUUID(),
      member_id: ids["u1@A"],
      role_key: ADOPTED_LEAD_KEY,
      project_id: ids[project],
    })
  await insert(client, "global_grant", {
    id: randomUUID(),
    member_id: ids.us,
    role_key: ADOPTED_SUPPORT_KEY,
  })
  for (const [member, org, archetype] of [
    ["u7@A", "A", ORG_MEMBER_ROLE_ID],
    ["uw@A", "A", TASK_WRITER_ID],
    ["uf@A", "A", ORG_MEMBER_ROLE_ID],
    ["uf@B", "B", ORG_MEMBER_ROLE_ID],
    ["uf@B", "B", TASK_WRITER_ID],
    ["u3@B", "B", ORG_MEMBER_ROLE_ID],
  ] as const)
    await insert(client, "org_role_assignments", {
      org_id: ids[org],
      ...assignmentRow(ids[member]!, { archetype }),
    })
  return ids
}

// Запобіжник, який вставляє `fix` (Д4, Р3), а не написаний рукою: RPC без
// запобіжника й декларація з `check.row` → `fixFiles` вставляє виклик → модель
// розгортається → Postgres судить виклики. Мутація: `check.row` ігнорується
// (ціль `NULL`) — (б) і (в) червоні: будь-який рядок відмовляє.
describe("the call guard inserted by fix, in Postgres", () => {
  const tx = describeTransaction()
  let ids: Seed = {}

  beforeAll(async () => {
    const files = adoptedSourcesDomain(
      profileLayer(),
      writeRoles(),
      supportUsers(),
      narrowTenantSet()
    )
    files.set(
      "sql/public/g_task_read.sql",
      "CREATE FUNCTION public.g_task_read(p_row uuid) RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$BEGIN RETURN p_row; END$$;\n"
    )
    files.set(
      "sql/public/g_task_read.functions.json",
      JSON.stringify({
        functions: [
          {
            id: uuid(9610),
            function: { name: "g_task_read" },
            callers: ["user"],
            check: {
              action: "read",
              object: { kind: "Document", name: "Task" },
              row: "p_row",
            },
          },
        ],
      })
    )
    let n = 9700
    const fixed = await fixFiles(await acceptDebt(files), {
      schemaPath: (file, schemaFile) => `schemas-of/${file}/${schemaFile}`,
      newId: () => uuid(++n),
    })
    // Запобіжник з'явився в тексті від самого `fix`
    const repaired = applyChanges(await acceptDebt(files), fixed.changes)
    expect(repaired.get("sql/public/g_task_read.sql")).toContain(
      "PERFORM simetra.rights_require('read', 'task', p_row);"
    )
    const result = await compile(repaired)
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
    const client = await tx.open()
    await deploy(client, result.model!)
    ids = await seedGuardGrid(client)
  })

  afterAll(() => tx.close())

  const call = (who: string, key: string | null) =>
    asActor(tx.client(), ids[who]!, "SELECT public.g_task_read($1)", [
      key === null ? null : ids[key],
    ])

  it("(a) an actor without the right on the row is refused with rights.forbidden", async () => {
    expect(await call("u5", "t1")).toEqual(REFUSED)
  })

  it("(b) an actor with the right on the row gets the result", async () => {
    expect(await call("u7", "t1")).toBe("ok")
    const client = tx.client()
    await client.query("SAVEPOINT result")
    try {
      await asRole(client, "user", claimsFor("user", ids.u7))
      const { rows } = await client.query<{ v: string }>(
        "SELECT public.g_task_read($1) AS v",
        [ids.t1]
      )
      expect(rows[0]!.v).toBe(ids.t1)
    } finally {
      await client.query("ROLLBACK TO SAVEPOINT result")
    }
  })

  it("(c) the right in another tenant only is refused", async () => {
    expect(await call("u3", "t1")).toEqual(REFUSED)
    expect(await call("u7", "tB")).toEqual(REFUSED)
  })
})

// Проєкт без ролей: функцій прав немає, тож гілка кликала б неіснуючу
// `simetra.rights_any` (`42883`). Запобіжник без гілок відмовляє `42501`.
// Мутація: будувати гілки й без функцій прав.
describe("the call guard in a project without roles", () => {
  it("refuses with 42501 rights.forbidden, not 42883", async () => {
    await withRollback(async (client) => {
      const noRoles = without(
        ...["OrgAdmin", "OrgMember", "ProjectLead", "Support", "Everyone"].map(
          ROLE_FILE
        )
      )
      const files = policyDomain(profileLayer(), noRoles)
      for (const [path, text] of Object.entries(guardFiles(["g_task_read"])))
        files.set(path, text)
      const result = await compile(await acceptDebt(files))
      await deployed(client, result)
      expect(
        await asActor(client, randomUUID(), "SELECT public.g_task_read($1)", [
          randomUUID(),
        ])
      ).toEqual(REFUSED)
    })
  })
})
