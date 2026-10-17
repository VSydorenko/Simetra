import { describe, expect, it } from "vitest"
import type pg from "pg"
import { compile } from "simetra/compiler"
import { renderDesiredState } from "simetra/schema"
import {
  attribute,
  catalog,
  customTable,
  metaFiles,
  project,
  uuid,
} from "../../src/compiler/__tests__/helpers"
import { testSuperuserUrl, withRollback } from "./connection"

/**
 * Тригери підписок на справжньому Postgres (спека промоції §9.3): подія
 * підписки — час і події тригера, `whenChanged` — умова на оновленні й
 * окремий тригер вставки, таблиця провайдера — джерело, як таблиця виду.
 * Кожен обробник пише в журнал `TG_OP`: запис журналу — доказ спрацювання.
 */

/**
 * Роль сервісу автентифікації локального стеку Supabase: від неї GoTrue
 * пише `auth.users`. Вставка від `postgres` нічого б не довела — у неї є
 * права на все.
 */
const AUTH_SERVICE_ROLE = "supabase_auth_admin"

/** Роль застосунку локального стеку: від неї застосовується схема. */
const APP_ROLE = "postgres"

const journalInsert = (source: string) =>
  `INSERT INTO public.journal (id, op, source) VALUES (pg_catalog.gen_random_uuid(), TG_OP, '${source}');`

const HANDLERS = [
  // Обробник `beforeWrite` бачить і міняє рядок до запису.
  `CREATE FUNCTION public.on_price() RETURNS trigger LANGUAGE plpgsql VOLATILE SET search_path = '' AS $$
BEGIN
  ${journalInsert("price")}
  NEW.name := pg_catalog.upper(NEW.name);
  RETURN NEW;
END $$;`,
  `CREATE FUNCTION public.on_item_delete() RETURNS trigger LANGUAGE plpgsql VOLATILE SET search_path = '' AS $$
BEGIN
  ${journalInsert("delete")}
  RETURN OLD;
END $$;`,
  // Роль автентифікації прав на схеми застосунку не має, тож обробник на
  // таблиці провайдера — `SECURITY DEFINER` з порожнім шляхом.
  `CREATE FUNCTION public.on_user() RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  ${journalInsert("user")}
  RETURN NEW;
END $$;`,
].join("\n")

function subscription(
  n: number,
  name: string,
  data: Record<string, unknown>
): [string, unknown] {
  return [
    `event-subscriptions/${name}/${name}.meta.json`,
    {
      id: uuid(n),
      kind: "EventSubscription",
      name,
      ...data,
    },
  ]
}

async function deploy(client: pg.Client): Promise<void> {
  const result = await compile(
    metaFiles({
      "project.meta.json": project(),
      "catalogs/Item/Item.meta.json": catalog("Item", {
        attributes: [
          attribute("name", { type: "String", length: 20 }),
          attribute("price", { type: "Integer" }),
        ],
      }),
      "custom-tables/Journal/Journal.meta.json": customTable("Journal", {
        columns: [
          {
            id: uuid(7201),
            name: "id",
            physicalName: "id",
            type: "UUID",
            notNull: true,
          },
          {
            id: uuid(7202),
            name: "op",
            physicalName: "op",
            type: "String",
            length: 10,
            notNull: true,
          },
          {
            id: uuid(7203),
            name: "source",
            physicalName: "source",
            type: "String",
            length: 10,
            notNull: true,
          },
        ],
      }),
      ...Object.fromEntries([
        subscription(7211, "OnPrice", {
          physicalName: "on_price",
          sources: [{ kind: "Catalog", name: "Item" }],
          event: "beforeWrite",
          whenChanged: ["price"],
          handler: { schema: "public", name: "on_price" },
        }),
        subscription(7212, "OnItemDelete", {
          physicalName: "on_item_delete",
          sources: [{ kind: "Catalog", name: "Item" }],
          event: "onDelete",
          handler: { schema: "public", name: "on_item_delete" },
        }),
        subscription(7213, "OnUser", {
          physicalName: "on_user",
          sources: [{ providerTable: "auth.users" }],
          event: "onWrite",
          handler: { schema: "public", name: "on_user" },
        }),
      ]),
      "sql/public/handlers.sql": HANDLERS,
    })
  )
  expect(result.diagnostics).toEqual([])
  await client.query(renderDesiredState(result.model!).sql)
}

async function journal(client: pg.Client): Promise<string[]> {
  const { rows } = await client.query<{ entry: string }>(
    "SELECT source || ':' || op AS entry FROM public.journal ORDER BY source, op"
  )
  return rows.map((r) => r.entry)
}

/** Журнал з чистого аркуша: кожна перевірка бачить лише свої спрацювання. */
async function freshJournal(client: pg.Client): Promise<void> {
  await client.query("DELETE FROM public.journal")
}

describe("event subscription triggers in Postgres", () => {
  it("whenChanged: an insert always fires, an update only on a real change of a listed column", async () => {
    await withRollback(async (client) => {
      await deploy(client)
      const inserted = await client.query<{ id: string; name: string }>(
        "INSERT INTO public.item (id, description, name, price) VALUES (gen_random_uuid(), 'd', 'a', 1) RETURNING id, name"
      )
      const { id } = inserted.rows[0]!
      expect(inserted.rows[0]!.name).toBe("A")
      expect(await journal(client)).toEqual(["price:INSERT"])

      await freshJournal(client)
      await client.query("UPDATE public.item SET name = 'b' WHERE id = $1", [
        id,
      ])
      expect(await journal(client)).toEqual([])

      // Та сама колонка тим самим значенням — не зміна.
      await client.query("UPDATE public.item SET price = price WHERE id = $1", [
        id,
      ])
      expect(await journal(client)).toEqual([])

      await client.query(
        "UPDATE public.item SET price = price + 1 WHERE id = $1",
        [id]
      )
      expect(await journal(client)).toEqual(["price:UPDATE"])
    })
  })

  it("onDelete fires after a delete", async () => {
    await withRollback(async (client) => {
      await deploy(client)
      const { rows } = await client.query<{ id: string }>(
        "INSERT INTO public.item (id, description, name, price) VALUES (gen_random_uuid(), 'd', 'a', 1) RETURNING id"
      )
      await freshJournal(client)
      await client.query("DELETE FROM public.item WHERE id = $1", [rows[0]!.id])
      expect(await journal(client)).toEqual(["delete:DELETE"])
    })
  })

  it("onWrite on auth.users fires for an insert by the auth service role", async () => {
    // Роль застосунку не є членом ролі автентифікації: перемкнутися на неї
    // може лише суперкористувач стеку. Застосування — від ролі застосунку, як
    // у споживача: обробник `SECURITY DEFINER` належить їй, а не
    // суперкористувачу, тож тест доводить правило закритої оболонки.
    await withRollback(async (client) => {
      await client.query(`SET LOCAL ROLE ${APP_ROLE}`)
      await deploy(client)
      await client.query("RESET ROLE")
      const owner = await client.query<{ owner: string }>(
        "SELECT pg_get_userbyid(proowner) AS owner FROM pg_proc WHERE oid = 'public.on_user()'::regprocedure"
      )
      expect(owner.rows).toEqual([{ owner: APP_ROLE }])
      await client.query(`SET LOCAL ROLE ${AUTH_SERVICE_ROLE}`)
      await client.query(
        "INSERT INTO auth.users (id, email) VALUES (gen_random_uuid(), $1)",
        [`${uuid(7299)}@example.test`]
      )
      await client.query("RESET ROLE")
      expect(await journal(client)).toEqual(["user:INSERT"])
    }, testSuperuserUrl())
  })
})
