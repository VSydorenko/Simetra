import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { PLATFORM_ROLES, type CommandContext } from "simetra/model"
import { CATALOG_COMMAND_ERRORS } from "../../src/compiler/catalog-command/units"
import {
  COMMENT_TABLE,
  TICKET_TABLE,
  commandCoreLayer,
  compileRights,
  policyDomain,
  writeRoles,
} from "../../src/compiler/__tests__/fixtures/rights"
import { type Refusal, commandAs } from "./connection"
import {
  deploy,
  COMMAND_CORE_MEMBERS,
  type Seed,
  describeTransaction,
  seedCommandCore,
} from "./rights-seed"

/**
 * Перевірка права ядра ≡ RLS (спека П4 §6.7).
 * Предикати ядра рендерить той самий будівник, що й політики, але над
 * змінними рядка; чи дають вони те саме, що політики над рядком, вирішує
 * Postgres, тож доказ — лише DB-рівня. Кожна точка сітки — той самий стан
 * «після» двома шляхами під тим самим контекстом команди: ядро
 * (`<t>_save` / `<t>_mark_deletion`) і прямий `INSERT`/`UPDATE`. Роль команд
 * має повний DML-грант: базова лінія RLS не має впиратися в
 * колонкові гранти, бо порівнюється лише рядкове право.
 */

const E = CATALOG_COMMAND_ERRORS
/** Значення `description`, за яким власник бачить, що прямий `UPDATE` пройшов. */
const MARK = "rights-grid"

type Tenant = "A" | "B"
type Action = "create" | "update" | "markDeletion"

/** Стан «після»: колонка-носій → ключ засіву чи `NULL`; порожній — без зміни носія. */
interface State {
  label: string
  set: Record<string, string | null>
}

interface Point {
  user: string
  table: string
  row: string
  action: Action
  state: State
}

// Розкладка засіву, якої `seedCommandCore` не експортує: тенант кожного
// рядка й значення-цілі посилань. `beforeAll` звіряє її з базою, тож
// розбіжність із засівом валить опис, а не дає хибно зелену сітку.
const USERS = COMMAND_CORE_MEMBERS.map(([user, tenant]) => ({ user, tenant }))
const TENANT_OF_USER = new Map<string, Tenant>(
  USERS.map(({ user, tenant }) => [user, tenant])
)
const MEMBERS_OF = (tenant: Tenant) =>
  USERS.filter((u) => u.tenant === tenant).map((u) => `${u.user}@${tenant}`)
const REGIONS: Record<Tenant, string[]> = { A: ["r1", "r2"], B: [] }
const PROJECTS: Record<Tenant, string[]> = { A: ["P1", "P2"], B: ["PB"] }
const TASKS: Record<Tenant, string[]> = { A: ["TO", "TA"], B: [] }
/** Ключ засіву → таблиця й тенант: для звірки й для бази створення. */
type Placed = readonly [key: string, table: string, tenant: Tenant]
const VALUE_KEYS: Placed[] = [
  ...(["A", "B"] as const).flatMap((t) => [
    ...MEMBERS_OF(t).map((k) => [k, "org_member", t] as const),
    ...REGIONS[t].map((k) => [k, "region", t] as const),
    ...PROJECTS[t].map((k) => [k, "project", t] as const),
    ...TASKS[t].map((k) => [k, "task", t] as const),
  ]),
]

interface Target {
  table: string
  rows: Record<string, Tenant>
  users: string[]
  /** Колонки-носії, які несе база створення. */
  carriers: string[]
  /** Стани «після» з цілями, видимими користувачу (його тенант). */
  states: (user: string, tenant: Tenant) => State[]
}

/** Ціль, що підписана власним ключем засіву. */
const same = (k: string): [string, string] => [k, k]

const nullState = (columns: string[], label: string): State => ({
  label,
  set: Object.fromEntries(columns.map((c) => [c, null])),
})

/**
 * Стани з цілями лише тенанта користувача: `TicketTargetsReader` відкриває
 * йому саме їх, а невидима ціль дала б `command.invalid` раніше за перевірку
 * права — не точка порівняння.
 */
function variants(
  options: Record<string, [label: string, key: string][]>
): State[] {
  const columns = Object.keys(options)
  return [
    { label: "unchanged", set: {} },
    ...(columns.length > 1 ? [nullState(columns, "all NULL")] : []),
    ...columns.flatMap((column) => [
      ...options[column]!.map(([label, key]) => ({
        label: `${column}=${label}`,
        set: { [column]: key },
      })),
      { label: `${column}=NULL`, set: { [column]: null } },
    ]),
  ]
}

const TICKET: Target = {
  table: TICKET_TABLE,
  rows: { K1: "A", KR: "A", K2: "A", KB: "B" },
  users: USERS.map((u) => u.user),
  carriers: ["assignee_id", "region_id", "project_id"],
  states: (user, tenant) => {
    const self = `${user}@${tenant}`
    const other = MEMBERS_OF(tenant).find((m) => m !== self)
    return variants({
      // `self` — носій власності користувача, `other` — чужий
      assignee_id: [
        ["self", self],
        ...(other === undefined ? [] : [["other", other] as [string, string]]),
      ],
      region_id: REGIONS[tenant].map(same),
      project_id: PROJECTS[tenant].map(same),
    })
  },
}

// Носій коментаря — за шляхом `task.assignee`: стан «після» міняє `task`
// на задачу зі своїм (`TO`) чи чужим (`TA`) виконавцем.
const COMMENT: Target = {
  table: COMMENT_TABLE,
  rows: { "TO.c": "A", "TA.c": "A" },
  users: ["cw"],
  carriers: ["task_id"],
  states: (_, tenant) => variants({ task_id: TASKS[tenant].map(same) }),
}

const ACTIONS: Action[] = ["create", "update", "markDeletion"]

function grid(target: Target): [string, Point][] {
  return target.users.flatMap((user) => {
    const tenant = TENANT_OF_USER.get(user)!
    return Object.keys(target.rows).flatMap((row) =>
      ACTIONS.flatMap((action) =>
        // `mark_deletion` не приймає значень: стан «після» — лише без зміни
        (action === "markDeletion"
          ? [{ label: "unchanged", set: {} }]
          : target.states(user, tenant)
        ).map((state): [string, Point] => [
          `${target.table} ${user} ${action} ${row} ${state.label}`,
          { user, table: target.table, row, action, state },
        ])
      )
    )
  })
}

const POINTS = [...grid(TICKET), ...grid(COMMENT)]
const TARGETS = new Map([TICKET, COMMENT].map((t) => [t.table, t]))

type CoreOutcome = "ok" | "check" | "rls" | string
type RlsOutcome = "ok" | "refused" | string

/** Інший код — не точка порівняння, а дефект сітки: рядком він валить твердження. */
const unexpected = (r: Refusal) =>
  `${r.code} ${r.message} ${r.detail ?? ""}`.trim()

function coreOutcome(result: { rows: unknown[] } | Refusal): CoreOutcome {
  if ("rows" in result) return "ok"
  if (result.code !== E.forbidden.errcode) return unexpected(result)
  return result.message === E.forbidden.message ? "check" : "rls"
}

describe("catalog command core: rights check ≡ RLS", () => {
  const tx = describeTransaction()
  let ids: Seed = {}
  let keyOf = new Map<string, string>()

  beforeAll(async () => {
    const result = await compileRights(
      policyDomain(writeRoles(), commandCoreLayer())
    )
    expect(result.diagnostics).toEqual([])
    const client = await tx.open()
    await deploy(client, result.model!)
    // Повний DML ролі команд і членство з `SET` — лише в цій
    // транзакції; базова лінія RLS не впирається в колонкові гранти.
    await client.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${PLATFORM_ROLES.command}`
    )
    await client.query(
      `GRANT ${PLATFORM_ROLES.command} TO CURRENT_USER WITH SET TRUE`
    )
    ids = await seedCommandCore(client)
    keyOf = new Map(Object.entries(ids).map(([k, v]) => [v, k]))
    // Розкладка сітки ≡ засів: тенант кожного рядка й кожної цілі
    const placed: Placed[] = [
      ...VALUE_KEYS,
      ...[...TARGETS.values()].flatMap((t) =>
        Object.entries(t.rows).map(([row, tenant]): Placed => [
          row,
          t.table,
          tenant,
        ])
      ),
    ]
    for (const [k, table, tenant] of placed) {
      const { rows } = await client.query<{ org_id: string }>(
        `SELECT org_id FROM public.${table} WHERE id = $1`,
        [key(k)]
      )
      expect(rows, k).toEqual([{ org_id: key(tenant) }])
    }
  }, 120_000)

  afterAll(() => tx.close())

  const key = (name: string) => {
    // Невідомий ключ дав би `NULL` замість id — і зелений кейс без причини
    const id = ids[name]
    if (id === undefined) throw new Error(`unknown seed key ${name}`)
    return id
  }
  const claims = (user: string) => ({ sub: key(user), role: "authenticated" })
  const tenantOfValue = new Map(VALUE_KEYS.map(([k, , t]) => [k, t]))

  /** Колонки рядка, як їх бачить власник: RLS не ховає. */
  const ownerRow = async (table: string, id: string, columns: string[]) =>
    (
      await tx
        .client()
        .query<Record<string, string | null>>(
          `SELECT ${columns.join(", ")} FROM public.${table} WHERE id = $1`,
          [id]
        )
    ).rows[0]!

  /**
   * База створення — носії рядка-зразка, з яких лишаються лише цілі тенанта
   * користувача: чужа ціль невидима. Так рядок тенанта B дає точку «створення
   * в чужому тенанті» з видимими цілями (межа `scope_insert`, спека П4 §6.7).
   */
  async function createItem(point: Point, target: Target) {
    const sample = await ownerRow(point.table, key(point.row), target.carriers)
    const tenant = TENANT_OF_USER.get(point.user)!
    const item: Record<string, unknown> = {
      id: randomUUID(),
      org_id: key(target.rows[point.row]!),
    }
    for (const column of target.carriers) {
      const value = sample[column] ?? null
      if (value === null) {
        item[column] = null
        continue
      }
      const valueKey = keyOf.get(value)
      if (valueKey === undefined || !tenantOfValue.has(valueKey))
        throw new Error(`${point.row}.${column}: value outside the grid`)
      item[column] = tenantOfValue.get(valueKey) === tenant ? value : null
    }
    return item
  }

  const resolved = (state: State) =>
    Object.fromEntries(
      Object.entries(state.set).map(([c, k]) => [c, k === null ? null : key(k)])
    )

  const contextOf = (
    action: Action,
    table: string,
    root: string
  ): CommandContext => ({ action, object: table, root })

  /** Той самий стан «після» через ядро. */
  async function viaCore(point: Point, item: Record<string, unknown>) {
    const { table, action } = point
    const id = item.id as string
    const run = (sql: string, params: unknown[]) =>
      commandAs(
        tx.client(),
        claims(point.user),
        contextOf(action, table, id),
        sql,
        {
          params,
        }
      )
    if (action === "create")
      return run(`SELECT public.${table}_save($1::jsonb, NULL::bigint) AS r`, [
        JSON.stringify(item),
      ])
    const { version } = await ownerRow(table, id, ["version::text AS version"])
    if (action === "update")
      return run(`SELECT public.${table}_save($1::jsonb, $2::bigint) AS r`, [
        JSON.stringify(item),
        version,
      ])
    return run(
      `SELECT public.${table}_mark_deletion($1::uuid, $2::bigint, true) AS r`,
      [id, version]
    )
  }

  /**
   * Той самий стан прямим DML під тим самим контекстом. Без `RETURNING`:
   * він додав би перевірку політики читання, а сітка порівнює лише право
   * запису; видимість рядка після запису ядру гарантує замикання прав
   * (спека П4 §6.6). Чи пройшов
   * `UPDATE`, власник бачить за значенням після нього в тій самій точці
   * збереження: 0 рядків під `USING` — не помилка.
   */
  async function viaRls(
    point: Point,
    item: Record<string, unknown>
  ): Promise<RlsOutcome> {
    const { table, action } = point
    const id = item.id as string
    const columns = Object.keys(item)
    const values = Object.values(item)
    const write =
      action === "create"
        ? {
            sql: `INSERT INTO public.${table} (${columns.join(", ")}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(", ")})`,
            params: values,
            after: undefined,
          }
        : action === "update"
          ? {
              // `id` — перший ключ `item`, решта — присвоєння
              sql: `UPDATE public.${table} SET ${columns
                .slice(1)
                .map((c, i) => `${c} = $${i + 2}`)
                .join(", ")} WHERE id = $1`,
              params: values,
              after: `SELECT description IS NOT DISTINCT FROM '${MARK}' AS hit FROM public.${table} WHERE id = '${id}'`,
            }
          : {
              sql: `UPDATE public.${table} SET deletion_mark = true WHERE id = $1`,
              params: [id],
              after: `SELECT deletion_mark AS hit FROM public.${table} WHERE id = '${id}'`,
            }
    const result = await commandAs(
      tx.client(),
      claims(point.user),
      contextOf(action, table, id),
      write.sql,
      write.after === undefined
        ? { params: write.params }
        : { params: write.params, after: write.after }
    )
    if (!("rows" in result))
      return result.code === "42501" ? "refused" : unexpected(result)
    // `INSERT` без помилки вставив рядок; `UPDATE` — лише коли власник бачить зміну
    if (write.after === undefined) return "ok"
    return result.after?.[0]?.hit === true ? "ok" : "refused"
  }

  // Одна точка сітки: перевіряє пару (ядро, RLS) і повертає результат ядра.
  // Кожен виклик сам готує свій стан у точці збереження `commandAs`, тож
  // кейси не залежать від порядку виконання.
  const evaluate = async (point: Point): Promise<"ok" | "check"> => {
    const target = TARGETS.get(point.table)!
    const item =
      point.action === "create"
        ? { ...(await createItem(point, target)), ...resolved(point.state) }
        : point.action === "update"
          ? {
              id: key(point.row),
              description: MARK,
              ...resolved(point.state),
            }
          : { id: key(point.row) }
    const core = coreOutcome(await viaCore(point, item))
    const rls = await viaRls(point, item)
    // Дві допустимі пари: ядро пропускає ⇔ RLS пропускає, а відмова ядра —
    // завжди кодована `command.forbidden`, ніколи сирий `42501` RLS
    expect([core, rls]).toEqual(
      rls === "ok" ? ["ok", "ok"] : ["check", "refused"]
    )
    // Межа тенанта на створенні — у ядрі, не лише в RESTRICTIVE-політиці
    if (
      point.action === "create" &&
      target.rows[point.row] !== TENANT_OF_USER.get(point.user)
    )
      expect(core).toBe("check")
    return core as "ok" | "check"
  }

  it.each(POINTS)("%s", async (_, point) => {
    await evaluate(point)
  })

  // Сітка без жодного `ok` чи без жодної відмови нічого не порівнює: так
  // виглядав би збій засіву чи гранту, а не еквівалентність
  // Дві відомі точки проганяються тут же, а не читаються з попередніх кейсів:
  // лічильник між `it` залежав би від порядку (`--shuffle`, паралель).
  it("grid has both permitted and refused points", async () => {
    const find = (match: (p: Point) => boolean) => {
      const found = POINTS.find(([, p]) => match(p))
      if (found === undefined) throw new Error("grid lacks a reference point")
      return found[1]
    }
    const permitted = find(
      (p) =>
        p.user === "tw" &&
        p.row === "K1" &&
        p.action === "update" &&
        p.state.label === "unchanged"
    )
    const refused = find(
      (p) => p.user === "tp" && p.row === "KB" && p.action === "create"
    )
    expect(await evaluate(permitted)).toBe("ok")
    expect(await evaluate(refused)).toBe("check")
  })
})
