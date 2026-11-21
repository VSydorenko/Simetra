import { randomUUID } from "node:crypto"
import pg from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { CompiledModel } from "simetra/compiler"
import {
  COMMAND_SETTING,
  PLATFORM_LOGIN_ROLES,
  PLATFORM_ROLES,
  PROVIDER_API_ROLES,
  SESSION_CLAIMS_SETTING,
  SIGNAL_MERGE_MODE,
  SIGNAL_MODE_SETTING,
  SIGNAL_OUTBOX,
  ZERO_UUID,
  channelTopic,
} from "simetra/model"
import {
  EVERYONE_ID,
  GLOBAL_ADMIN_ID,
  ORG_KIND_ID,
  PROJECT_WRITER_ID,
  ROLE_FILE,
  TASK_VIEWER_ID,
  adminRoles,
  compileRights,
  globalRightsAdmins,
  policyDomain,
  rightsFiles,
  role,
  unscopedDimension,
  writeRoles,
} from "../../src/compiler/__tests__/fixtures/rights"
import { signUp } from "./auth"
import {
  claimsFor,
  restoreOwnerRole,
  setLocalSetting,
  type Refusal,
} from "./connection"
import { testProvider } from "./profile"
import {
  deploy,
  describeTransaction,
  inMaintenance,
  insert,
  profileLayer,
  seedAdministration,
  type Seed,
} from "./rights-seed"

/**
 * Сигнали прав на справжньому Postgres (спека П4-B §8.2, Р8, Р9;
 * інваріанти І1–І3 плану B6-1): що пишуть у outbox тригери сигналу прав і
 * функції `signal_rights`/`signal_user_rights`, хто може їх кликати і що
 * відкат прибирає, — вирішує Postgres, компілятор бачить лише текст. Одне
 * розгортання на опис у транзакції опису; кожен кейс — у точці збереження.
 */

const OUTBOX = `${SIGNAL_OUTBOX.schema}.${SIGNAL_OUTBOX.name}`
const rightsChannel = (scopeKindId: string, scope: string) =>
  channelTopic({ kind: "rights", scopeKindId, scope })
const userChannel = (userId: string) => channelTopic({ kind: "user", userId })
const GLOBAL = rightsChannel(ZERO_UUID, ZERO_UUID)

/** Найбільший id outbox: кейс бачить лише рядки після нього. */
async function lastId(client: pg.Client): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT coalesce(max(id), 0)::text AS id FROM ${OUTBOX}`
  )
  return rows[0]!.id
}

/** Канали рядків outbox після `after`, відсортовані. */
async function channelsAfter(
  client: pg.Client,
  after: string
): Promise<string[]> {
  const { rows } = await client.query<{ channel: string }>(
    `SELECT payload ->> 'channel' AS channel FROM ${OUTBOX} WHERE id > $1::bigint ORDER BY 1`,
    [after]
  )
  return rows.map((r) => r.channel)
}

type Outcome = { channels: string[] } | Refusal

/**
 * Один оператор зміни прав у точці збереження, результат — канали рядків
 * outbox, які записав саме він. Тригер сигналу — definer, тож роль, що пише,
 * каналу не змінює: типово оператор пише власник у режимі обслуговування
 * прав (як засів, без перевірок команди), `asCommand` — роль команд у
 * контексті `administerRights` (лише стек postgres). `setup` — від власника
 * до відліку.
 */
async function signalsOf(
  client: pg.Client,
  statement: string,
  options: {
    setup?: string[]
    asCommand?: { claims: object; object: string; root: string }
  } = {}
): Promise<Outcome> {
  await client.query("SAVEPOINT rights_signal")
  try {
    for (const sql of options.setup ?? [])
      await inMaintenance(client, () => client.query(sql))
    const after = await lastId(client)
    const command = options.asCommand
    if (command !== undefined) {
      await setLocalSetting(
        client,
        SESSION_CLAIMS_SETTING,
        JSON.stringify(command.claims)
      )
      // Команда пише свій кореневий рядок (спека прав §4.6): контекст —
      // `administerRights` над об'єктом рядка з його id.
      await setLocalSetting(
        client,
        COMMAND_SETTING,
        JSON.stringify({
          action: "administerRights",
          object: command.object,
          root: command.root,
        })
      )
      await client.query(`SET LOCAL ROLE ${PLATFORM_ROLES.command}`)
      await client.query(statement)
      await restoreOwnerRole(client)
    } else await inMaintenance(client, () => client.query(statement))
    return { channels: await channelsAfter(client, after) }
  } catch (error) {
    if (!(error instanceof pg.DatabaseError)) throw error
    return {
      code: error.code ?? "",
      message: error.message,
      ...(error.detail === undefined ? {} : { detail: error.detail }),
    }
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT rights_signal")
  }
}

/** Опис з одним розгортанням моделі `build` і засівом `seed`. */
function deployed(
  build: () => Promise<CompiledModel>,
  seed: (client: pg.Client) => Promise<Seed>
) {
  const tx = describeTransaction()
  let ids: Seed = {}
  beforeAll(async () => {
    const model = await build()
    const client = await tx.open()
    await deploy(client, model)
    // Роль команд пише таблиці застосунку через гранти ядра; тут — прямо.
    await client.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${PLATFORM_ROLES.command}`
    )
    ids = await seed(client)
    await client.query("SET CONSTRAINTS ALL IMMEDIATE")
    await client.query("SET CONSTRAINTS ALL DEFERRED")
  }, 120_000)
  afterAll(() => tx.close())
  const key = (name: string) => {
    const id = ids[name]
    if (id === undefined) throw new Error(`unknown seed key ${name}`)
    return id
  }
  const sql = (source: string) =>
    source.replace(/\{([^}]+)\}/g, (_, name: string) => `'${key(name)}'`)
  return { tx, key, sql }
}

async function compiled(files: Map<string, string>): Promise<CompiledModel> {
  const result = await compileRights(files)
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
  return result.model!
}

/**
 * `platformRoles` — чи може з'єднання тестів стати роллю команд: на
 * Supabase вхід тестів (`postgres`) `SET ROLE simetra_command` не має, тож
 * там оператори пише власник із контекстом команди.
 */
export function defineRightsSignalCases(options: {
  platformRoles: boolean
}): void {
  describe("rights signals of the facts tables", () => {
    const { tx, key, sql } = deployed(
      () =>
        compiled(
          policyDomain(
            writeRoles(),
            adminRoles(),
            globalRightsAdmins(),
            profileLayer()
          )
        ),
      seedAdministration
    )
    const signals = (
      statement: string,
      extra: {
        setup?: string[]
        asCommand?: { claims: object; object: string; root: string }
      } = {}
    ) =>
      signalsOf(tx.client(), sql(statement), {
        ...extra,
        setup: extra.setup?.map(sql),
      })
    const asAdmin = (object: string, root: string) => ({
      claims: claimsFor("user", key("admin")),
      object,
      root,
    })
    const scope = (name: string) => rightsChannel(ORG_KIND_ID, key(name))
    const user = (name: string) => userChannel(key(name))
    const sorted = (...channels: string[]) => ({
      channels: [...channels].sort(),
    })

    // І3: канал за зміною (Р9). Рядок — один на канал оператора.
    it.each<[string, string, () => Outcome]>([
      [
        "a scope-level custom role signals its scope channel",
        "UPDATE public.org_roles SET deletion_mark = true WHERE id = {unusedCustom}",
        () => sorted(scope("A")),
      ],
      [
        "a delta of a scope-level role signals its scope channel",
        `INSERT INTO public.org_roles_delta (id, org_id, parent_id, line_number, object, action, extent, effect) VALUES (gen_random_uuid(), {A}, {unusedCustom}, 1, 'task', 'read', 'any', 'allow')`,
        () => sorted(scope("A")),
      ],
      [
        "a global custom role signals the global channel",
        `INSERT INTO public.global_roles (id, archetype) VALUES (gen_random_uuid(), '${GLOBAL_ADMIN_ID}')`,
        () => sorted(GLOBAL),
      ],
      [
        "an assignment signals the user of its member, not the scope",
        `INSERT INTO public.org_role_assignments (id, org_id, subject, archetype) VALUES (gen_random_uuid(), {A}, {target@A}, '${TASK_VIEWER_ID}')`,
        () => sorted(user("target")),
      ],
      [
        "moving an assignment between scopes signals both users",
        "UPDATE public.org_role_assignments SET org_id = {B}, subject = {bAdmin@B} WHERE id = {targetRole}",
        () => sorted(user("target"), user("bAdmin")),
      ],
      [
        "a global assignment signals its subject",
        `INSERT INTO public.global_role_assignments (id, subject, archetype) VALUES (gen_random_uuid(), {viewer}, '${GLOBAL_ADMIN_ID}')`,
        () => sorted(user("viewer")),
      ],
      [
        "a member added to a new scope learns of it on the user channel",
        "INSERT INTO public.org_member (id, org_id, user_id) VALUES (gen_random_uuid(), {B}, {outsider})",
        () => sorted(user("outsider")),
      ],
      [
        "deactivating a member signals its user",
        "UPDATE public.org_member SET deletion_mark = true WHERE id = {viewer@A}",
        () => sorted(user("viewer")),
      ],
      [
        "an invitation without a user succeeds without a signal",
        "INSERT INTO public.org_member (id, org_id, user_id) VALUES (gen_random_uuid(), {B}, NULL)",
        () => sorted(),
      ],
      [
        "deleting a member with its assignments in one statement signals its user",
        "WITH gone AS (DELETE FROM public.org_role_assignments WHERE subject = {target@A} RETURNING 1) DELETE FROM public.org_member WHERE id = {target@A}",
        () => sorted(user("target")),
      ],
      [
        "a relation row signals the user of its member, not the global channel",
        "INSERT INTO public.member_region (member_id, region_id, org_id) VALUES ({viewer@A}, {R1}, {A})",
        () => sorted(user("viewer")),
      ],
      [
        "invalidating a user signals that user",
        "UPDATE public.users SET invalid = true WHERE id = {viewer}",
        () => sorted(user("viewer")),
      ],
      [
        "an update of Users that changes nothing of rights signals nothing",
        "UPDATE public.users SET invalid = invalid WHERE id = {viewer}",
        () => sorted(),
      ],
    ])("%s", async (_, statement, expected) => {
      expect(await signals(statement)).toEqual(expected())
    })

    // Т1: контейнер — суб'єктам призначень рівня контейнера, раз на
    // користувача за оператор, хоч би скільки контейнерів він зачепив.
    it("deleting several containers in one statement signals each assigned user once", async () => {
      expect(
        await signals("DELETE FROM public.project WHERE id IN ({P1}, {P2})", {
          setup: [
            `INSERT INTO public.org_role_assignments (id, org_id, subject, archetype, container) VALUES (gen_random_uuid(), {A}, {target@A}, '${PROJECT_WRITER_ID}', {P2}), (gen_random_uuid(), {A}, {other@A}, '${PROJECT_WRITER_ID}', {P2})`,
          ],
        })
      ).toEqual(sorted(user("target"), user("other")))
    })

    // Р9: `DISTINCT` на оператор — масове членство одного користувача дає
    // один рядок, а не тисячу.
    it("a thousand memberships of one user in one statement give one signal", async () => {
      expect(
        await signals(
          "INSERT INTO public.org_member (id, org_id, user_id) SELECT gen_random_uuid(), o.id, {outsider} FROM public.organization o WHERE o.id NOT IN ({A}, {B}, {C})",
          {
            setup: [
              "INSERT INTO public.organization (id) SELECT gen_random_uuid() FROM generate_series(1, 1000)",
            ],
          }
        )
      ).toEqual(sorted(user("outsider")))
    })

    // Сигнал транзакційний (§8.2): відкат прибирає рядок outbox.
    it("a rolled back change leaves no outbox row", async () => {
      const client = tx.client()
      const after = await lastId(client)
      const inside = await signals(
        `INSERT INTO public.org_role_assignments (id, org_id, subject, archetype) VALUES (gen_random_uuid(), {A}, {target@A}, '${TASK_VIEWER_ID}')`
      )
      expect(inside).toEqual(sorted(user("target")))
      expect(await channelsAfter(client, after)).toEqual([])
    })

    if (options.platformRoles) {
      // Тригер — definer від власника: роль команд політикою outbox у канал
      // прав не пройшла б, а рядок пише власник.
      it("an admin assigns a role as the command role", async () => {
        const id = randomUUID()
        expect(
          await signals(
            `INSERT INTO public.org_role_assignments (id, org_id, subject, archetype) VALUES ('${id}', {A}, {target@A}, '${TASK_VIEWER_ID}')`,
            { asCommand: asAdmin("org_role_assignments", id) }
          )
        ).toEqual(sorted(user("target")))
      })

      it("an admin changes a delta of a custom role as the command role", async () => {
        expect(
          await signals(
            `INSERT INTO public.org_roles_delta (id, org_id, parent_id, line_number, object, action, extent, effect) VALUES (gen_random_uuid(), {A}, {unusedCustom}, 1, 'task', 'read', 'any', 'allow')`,
            { asCommand: asAdmin("org_roles", key("unusedCustom")) }
          )
        ).toEqual(sorted(scope("A")))
      })

      // І1: прямий рядок каналу прав від ролі команд судить політика outbox.
      it.each([
        ["a scope rights channel", () => scope("A")],
        ["the global rights channel", () => GLOBAL],
        ["a user channel", () => user("admin")],
      ])("the command role cannot insert a row of %s", async (_, channel) => {
        const outcome = await signals(
          `INSERT INTO ${OUTBOX} (method, payload) VALUES ('publish', jsonb_build_object('channel', '${channel()}', 'data', jsonb_build_object('op', 'rights')))`,
          { asCommand: asAdmin("org_role_assignments", randomUUID()) }
        )
        expect(outcome).toEqual({
          code: "42501",
          message: `new row violates row-level security policy for table "${SIGNAL_OUTBOX.name}"`,
        })
      })
    }

    // І1: функции сигналів прав не кличе жодна роль, крім власника.
    it("no platform or API role may execute the rights senders", async () => {
      const roles = [
        PLATFORM_ROLES.command,
        PLATFORM_ROLES.signalConsumer,
        ...Object.values(PLATFORM_LOGIN_ROLES),
        ...Object.values(PROVIDER_API_ROLES[testProvider()]).filter(
          (r): r is string => typeof r === "string"
        ),
      ]
      const { rows } = await tx
        .client()
        .query<{ role: string; fn: string; granted: boolean }>(
          "SELECT r AS role, f AS fn, has_function_privilege(r, f, 'EXECUTE') AS granted FROM unnest($1::text[]) r, unnest($2::text[]) f ORDER BY 1, 2",
          [
            roles,
            [
              "simetra.signal_rights(uuid, uuid)",
              "simetra.signal_user_rights(uuid)",
            ],
          ]
        )
      expect(rows.length).toBe(roles.length * 2)
      expect(rows.filter((r) => r.granted)).toEqual([])
    })

    // І2: форму рядка судить сама функція — кожне правило окремо, до вставки.
    const call = (fn: string, args: string) => `SELECT simetra.${fn}(${args})`
    const ZERO = `'${ZERO_UUID}'::uuid`
    it.each<[string, () => string]>([
      ["a null scope kind", () => call("signal_rights", `NULL, '${key("A")}'`)],
      ["a null scope", () => call("signal_rights", `'${ORG_KIND_ID}', NULL`)],
      [
        "a zero scope kind with a scope",
        () => call("signal_rights", `${ZERO}, '${key("A")}'`),
      ],
      [
        "a scope kind with a zero scope",
        () => call("signal_rights", `'${ORG_KIND_ID}', ${ZERO}`),
      ],
      ["a null user", () => call("signal_user_rights", "NULL")],
      ["the zero user", () => call("signal_user_rights", ZERO)],
    ])("the rights senders refuse %s with 22023", async (_, statement) => {
      const outcome = await signalsOf(tx.client(), statement())
      expect(outcome).toMatchObject({ code: "22023" })
    })

    it.each<[string, () => string, () => string]>([
      [
        "signal_rights of a scope",
        () => call("signal_rights", `'${ORG_KIND_ID}', '${key("A")}'`),
        () => scope("A"),
      ],
      [
        "signal_rights of the global channel",
        () => call("signal_rights", `${ZERO}, ${ZERO}`),
        () => GLOBAL,
      ],
      [
        "signal_user_rights",
        () => call("signal_user_rights", `'${key("admin")}'`),
        () => user("admin"),
      ],
    ])(
      "%s writes one row with data exactly { id, op }, also in merge mode",
      async (_, statement, channel) => {
        const client = tx.client()
        await client.query("SAVEPOINT rights_sender")
        try {
          // Режим злиття сигналів прав не гасить (Р8).
          await setLocalSetting(client, SIGNAL_MODE_SETTING, SIGNAL_MERGE_MODE)
          const after = await lastId(client)
          await client.query(statement())
          const { rows } = await client.query<{
            channel: string
            data: Record<string, unknown>
            id: string
            key: string
          }>(
            `SELECT payload ->> 'channel' AS channel, payload -> 'data' AS data, id::text AS id, payload ->> 'idempotency_key' AS key FROM ${OUTBOX} WHERE id > $1::bigint`,
            [after]
          )
          expect(rows).toHaveLength(1)
          const [row] = rows
          expect(row!.channel).toBe(channel())
          expect(row!.data).toEqual({ id: row!.id, op: "rights" })
          expect(row!.key).toBe(row!.id)
        } finally {
          await client.query("ROLLBACK TO SAVEPOINT rights_sender")
        }
      }
    )
  })

  // Р9: сигнали прав є в кожному проєкті з функціями прав, зокрема без
  // жодного довідника прав — членство виду без довідника прав скоупу.
  describe("rights signals without rights catalogs", () => {
    const { tx, key, sql } = deployed(
      () =>
        compiled(
          rightsFiles(
            {
              [ROLE_FILE("Everyone")]: role(
                EVERYONE_ID,
                "Everyone",
                "everyUser"
              ),
            },
            testProvider()
          )
        ),
      async (client) => {
        const ids: Seed = { A: randomUUID(), u: await signUp(client) }
        await insert(client, "organization", { id: ids.A })
        return ids
      }
    )
    it("a membership signals its user", async () => {
      expect(
        await signalsOf(
          tx.client(),
          sql(
            "INSERT INTO public.org_member (id, org_id, user_id) VALUES (gen_random_uuid(), {A}, {u})"
          )
        )
      ).toEqual({ channels: [userChannel(key("u"))] })
    })
  })

  // Зв'язок без скоупу: канал суб'єкта, не глобальний.
  describe("rights signals of an unscoped relation", () => {
    const { tx, key, sql } = deployed(
      () => compiled(unscopedDimension(testProvider())),
      async (client) => {
        const ids: Seed = { R: randomUUID(), u: await signUp(client) }
        await insert(client, "region", { id: ids.R })
        return ids
      }
    )
    it("a relation row signals its subject and not the global channel", async () => {
      expect(
        await signalsOf(
          tx.client(),
          sql(
            "INSERT INTO public.user_region (user_id, region_id) VALUES ({u}, {R})"
          )
        )
      ).toEqual({ channels: [userChannel(key("u"))] })
    })
  })
}
