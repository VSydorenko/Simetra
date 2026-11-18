import pg from "pg"
import { beforeAll, describe, expect, it } from "vitest"
import { compile, type CompiledModel } from "simetra/compiler"
import {
  PLATFORM_ROLES,
  PROVIDER_API_ROLES,
  SIGNAL_NOTIFY_CHANNEL,
  SIGNAL_OUTBOX,
  SIGNAL_PAYLOAD_MAX_BYTES,
  channelTopic,
  quoteIdent,
} from "simetra/model"
import {
  catalog,
  metaFiles,
  project,
  testProvider,
} from "../../../simetra/test/support"
import { asSuperuser, query, withModelTarget } from "./support/db"

/**
 * Outbox сигналів (спека профілю `postgres` §5.1–§5.2, інваріанти 1–2 плану
 * ПГ-4/B2): форму `payload`, штамп `id`, `NOTIFY` і гранти вирішує Postgres,
 * тож DB-рівень. Вставка — від власника таблиці: політики `INSERT` для ролі
 * команд ще немає (її дає генератор сигналу), і від ролі команд перевіряється
 * лише відмова. Спільне тіло для профілів `postgres` і `supabase`.
 */

const TABLE = `${quoteIdent(SIGNAL_OUTBOX.schema)}.${quoteIdent(SIGNAL_OUTBOX.name)}`
const UUID = "0d6c7e1a-3f2b-4c5d-8e9f-a0b1c2d3e4f5"
const CHANNEL = channelTopic({
  kind: "changes",
  scopeKindId: UUID,
  scope: UUID,
  object: UUID,
})

async function compiled(): Promise<CompiledModel> {
  const result = await compile(
    metaFiles({
      "project.meta.json": project({ database: { provider: testProvider() } }),
      "catalogs/Currency/Currency.meta.json": catalog("Currency"),
    })
  )
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
  return result.model!
}

/** Payload сигналу; `id` і ключ ідемпотентності ставить тригер штампа. */
const signal = (data: Record<string, unknown> = {}, extra = {}) => ({
  channel: CHANNEL,
  data: { object: UUID, op: "update", ...data },
  ...extra,
})

/** Клієнт у транзакції, що завжди відкочується. */
async function inRollback<T>(
  url: string,
  fn: (client: pg.Client) => Promise<T>
): Promise<T> {
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    await client.query("BEGIN")
    return await fn(client)
  } finally {
    await client.query("ROLLBACK").catch(() => undefined)
    await client.end()
  }
}

/** SQLSTATE оператора в точці збереження; `null` — успіх. */
async function codeOf(
  client: pg.Client,
  sql: string,
  params: unknown[] = []
): Promise<string | null> {
  await client.query("SAVEPOINT probe")
  try {
    await client.query(sql, params)
    await client.query("RELEASE SAVEPOINT probe")
    return null
  } catch (error) {
    await client.query("ROLLBACK TO SAVEPOINT probe")
    return (error as { code?: string }).code ?? "unknown"
  }
}

const insert = (client: pg.Client, payload: unknown) =>
  codeOf(client, `INSERT INTO ${TABLE} (method, payload) VALUES ($1, $2)`, [
    "publish",
    JSON.stringify(payload),
  ])

export function describeSignalOutbox(): void {
  describe("signal outbox", () => {
    let model: CompiledModel
    beforeAll(async () => {
      model = await compiled()
    })

    it("stamps the row id over a forged key and a forged data.id", async () => {
      await withModelTarget(model, (url) =>
        inRollback(url, async (client) => {
          const forged = signal({ id: "999999" }, { idempotency_key: "999999" })
          const [row] = (
            await client.query<{
              id: string
              payload: { idempotency_key: string; data: { id: string } }
            }>(
              `INSERT INTO ${TABLE} (method, payload) VALUES ('publish', $1) RETURNING id::text, payload`,
              [JSON.stringify(forged)]
            )
          ).rows
          expect(row!.payload.idempotency_key).toBe(row!.id)
          expect(row!.payload.data.id).toBe(row!.id)
          expect(row!.id).not.toBe("999999")
        })
      )
    })

    it("refuses every payload outside the shape with 23514", async () => {
      await withModelTarget(model, (url) =>
        inRollback(url, async (client) => {
          expect(await insert(client, signal())).toBeNull()
          const refused = {
            skipHistory: signal({}, { skip_history: true }),
            b64data: signal({}, { b64data: "AA==" }),
            tags: signal({}, { tags: { a: "b" } }),
            noChannel: { data: { object: UUID } },
            foreignChannel: { ...signal(), channel: `other:${UUID}` },
            upperChannel: { ...signal(), channel: CHANNEL.toUpperCase() },
            dataNotObject: { channel: CHANNEL, data: [1] },
            notObject: [CHANNEL],
          }
          for (const [label, payload] of Object.entries(refused))
            expect(await insert(client, payload), label).toBe("23514")
          expect(
            await codeOf(
              client,
              `INSERT INTO ${TABLE} (method, payload) VALUES ('broadcast', $1)`,
              [JSON.stringify(signal())]
            ),
            "method"
          ).toBe("23514")
          expect(
            await codeOf(
              client,
              `INSERT INTO ${TABLE} (method, payload, partition) VALUES ('publish', $1, 1)`,
              [JSON.stringify(signal())]
            ),
            "partition"
          ).toBe("23514")
        })
      )
    })

    it("without the stamp trigger a forged key or a forged data.id is refused with 23514", async () => {
      await withModelTarget(model, (url) =>
        inRollback(url, async (client) => {
          // Перший рядок — щоб `last_value` послідовності вже був виданим
          expect(await insert(client, signal())).toBeNull()
          await client.query(
            `ALTER TABLE ${TABLE} DISABLE TRIGGER simetra_signal_outbox_stamp`
          )
          // Відмовлена вставка теж бере значення послідовності: наступний `id`
          // читається перед кожною спробою
          const next = async () =>
            (
              await client.query<{ id: string }>(
                `SELECT (last_value + 1)::text AS id FROM ${quoteIdent(SIGNAL_OUTBOX.schema)}.${quoteIdent(`${SIGNAL_OUTBOX.name}_id_seq`)}`
              )
            ).rows[0]!.id
          // Кожна підробка вгадує наступний `id` для другого ключа, тож
          // відмова — саме від прив'язки підробленого ключа до `id` (Р13)
          let id = await next()
          expect(
            await insert(client, signal({ id: "1" }, { idempotency_key: id })),
            "forged data.id"
          ).toBe("23514")
          id = await next()
          expect(
            await insert(client, signal({ id }, { idempotency_key: "1" })),
            "forged idempotency_key"
          ).toBe("23514")
          // Контроль: обидва ключі = `id` — рядок проходить і без тригера
          id = await next()
          expect(
            await insert(client, signal({ id }, { idempotency_key: id })),
            "both keys are the id"
          ).toBeNull()
        })
      )
    })

    it("the largest lawful signal passes and the bound counts octets", async () => {
      await withModelTarget(model, (url) =>
        inRollback(url, async (client) => {
          // Найдовший `id` — 19 цифр, найдовший канал — канал змін, ключ —
          // ім'я колонки на межі Postgres у 63 байти з двобайтових літер
          await client.query(
            `ALTER SEQUENCE ${quoteIdent(SIGNAL_OUTBOX.schema)}.${quoteIdent(`${SIGNAL_OUTBOX.name}_id_seq`)} RESTART WITH 9223372036854775000`
          )
          const column = `${"ж".repeat(31)}x`
          expect(Buffer.byteLength(column)).toBe(63)
          const largest = {
            channel: CHANNEL,
            data: {
              object: UUID,
              op: "markDeletion",
              keys: { [column]: UUID },
              row_ver: 9223372036854775807n.toString(),
            },
          }
          // `row_ver` — число в JSON: підставляємо його текстом, щоб не
          // втратити точність у JS
          const text = JSON.stringify(largest).replace(
            '"row_ver":"9223372036854775807"',
            '"row_ver":9223372036854775807'
          )
          const rows = (
            await client.query<{ octets: number }>(
              `INSERT INTO ${TABLE} (method, payload) VALUES ('publish', $1::jsonb) RETURNING octet_length(payload::text) AS octets`,
              [text]
            )
          ).rows
          expect(rows[0]!.octets).toBeLessThanOrEqual(SIGNAL_PAYLOAD_MAX_BYTES)
          // Символів не більше межі, а октетів — більше: межа рахує октети
          const pad = signal({ pad: "ж".repeat(600) })
          const [lengths] = (
            await client.query<{ chars: number; octets: number }>(
              "SELECT length($1::jsonb::text) AS chars, octet_length($1::jsonb::text) AS octets",
              [JSON.stringify(pad)]
            )
          ).rows
          expect(lengths!.chars).toBeLessThanOrEqual(SIGNAL_PAYLOAD_MAX_BYTES)
          expect(lengths!.octets).toBeGreaterThan(SIGNAL_PAYLOAD_MAX_BYTES)
          expect(await insert(client, pad)).toBe("23514")
        })
      )
    })

    it("one notification per transaction of three inserts, none after ROLLBACK", async () => {
      await withModelTarget(model, async (url) => {
        // Postgres зводить однакові сповіщення транзакції в одне, тож рівень
        // тригера видно лише з каталогу: AFTER INSERT рівня оператора
        // (`tgtype`: біт 0 — ROW, біт 1 — BEFORE, біт 2 — INSERT)
        const [trigger] = await query<{ tgtype: number }>(
          url,
          "SELECT tgtype FROM pg_catalog.pg_trigger WHERE tgrelid = $1::regclass AND tgname = 'simetra_signal_outbox_notify'",
          [`${SIGNAL_OUTBOX.schema}.${SIGNAL_OUTBOX.name}`]
        )
        expect(trigger!.tgtype & 0b111).toBe(0b100)
        const listener = new pg.Client({ connectionString: url })
        const writer = new pg.Client({ connectionString: url })
        await listener.connect()
        await writer.connect()
        try {
          const received: string[] = []
          listener.on("notification", (n) => received.push(n.channel))
          await listener.query(`LISTEN ${quoteIdent(SIGNAL_NOTIFY_CHANNEL)}`)
          const three = async (end: "COMMIT" | "ROLLBACK") => {
            await writer.query("BEGIN")
            for (let i = 0; i < 3; i++)
              await writer.query(
                `INSERT INTO ${TABLE} (method, payload) VALUES ('publish', $1)`,
                [JSON.stringify(signal())]
              )
            await writer.query(end)
            // Сповіщення доходить після коміту; запит на тому самому
            // з'єднанні гарантує, що вже надіслане прочитано
            await new Promise((resolve) => setTimeout(resolve, 300))
            await listener.query("SELECT 1")
          }
          await three("ROLLBACK")
          expect(received).toEqual([])
          const [{ count }] = (
            await writer.query<{ count: string }>(
              `SELECT count(*) FROM ${TABLE}`
            )
          ).rows as [{ count: string }]
          expect(count).toBe("0")
          await three("COMMIT")
          expect(received).toEqual([SIGNAL_NOTIFY_CHANNEL])
        } finally {
          await listener.end()
          await writer.end()
        }
      })
    })

    it("prune removes only older rows; the command role may not call it", async () => {
      await withModelTarget(model, (url) =>
        inRollback(url, async (client) => {
          const ids = (
            await client.query<{ id: string }>(
              `INSERT INTO ${TABLE} (method, payload) VALUES ('publish', $1), ('publish', $1) RETURNING id::text`,
              [JSON.stringify(signal())]
            )
          ).rows.map((r) => r.id)
          await client.query(
            `UPDATE ${TABLE} SET created_at = now() - interval '2 hours' WHERE id = $1`,
            [ids[0]]
          )
          const [{ pruned }] = (
            await client.query<{ pruned: string }>(
              `SELECT ${quoteIdent(SIGNAL_OUTBOX.schema)}.signal_outbox_prune(interval '1 hour')::text AS pruned`
            )
          ).rows as [{ pruned: string }]
          expect(pruned).toBe("1")
          expect(
            (
              await client.query<{ id: string }>(
                `SELECT id::text FROM ${TABLE} ORDER BY id`
              )
            ).rows.map((r) => r.id)
          ).toEqual([ids[1]])
        })
      )
    })

    it("the command role inserts nothing without its policy, reads nothing, deletes nothing", async () => {
      await withModelTarget(model, (url) =>
        inRollback(asSuperuser(url), async (client) => {
          await client.query(`SET LOCAL ROLE ${PLATFORM_ROLES.command}`)
          expect(await insert(client, signal()), "insert").toBe("42501")
          expect(
            await codeOf(
              client,
              `INSERT INTO ${TABLE} (id, method, payload) OVERRIDING SYSTEM VALUE VALUES (1, 'publish', $1)`,
              [JSON.stringify(signal())]
            ),
            "own id"
          ).toBe("42501")
          expect(await codeOf(client, `SELECT 1 FROM ${TABLE}`)).toBe("42501")
          expect(await codeOf(client, `DELETE FROM ${TABLE}`)).toBe("42501")
          expect(
            await codeOf(
              client,
              `SELECT ${quoteIdent(SIGNAL_OUTBOX.schema)}.signal_outbox_prune(interval '1 hour')`
            ),
            "prune"
          ).toBe("42501")
        })
      )
    })

    it("the consumer reads and deletes the outbox and nothing else", async () => {
      await withModelTarget(model, (url) =>
        inRollback(asSuperuser(url), async (client) => {
          await client.query(
            `INSERT INTO ${TABLE} (method, payload) VALUES ('publish', $1)`,
            [JSON.stringify(signal())]
          )
          const kind = model.physical.tables.find(
            (t) => t.schema !== SIGNAL_OUTBOX.schema
          )!
          await client.query(`SET LOCAL ROLE ${PLATFORM_ROLES.signalConsumer}`)
          const rows = await client.query(
            `SELECT id, method, payload, partition FROM ${TABLE} WHERE partition = 0 ORDER BY id LIMIT 100`
          )
          expect(rows.rowCount).toBe(1)
          expect(
            await codeOf(client, `DELETE FROM ${TABLE} WHERE id = ANY($1)`, [
              [rows.rows[0].id],
            ])
          ).toBeNull()
          expect(await insert(client, signal()), "insert").toBe("42501")
          expect(
            await codeOf(client, `UPDATE ${TABLE} SET partition = 0`),
            "update"
          ).toBe("42501")
          expect(
            await codeOf(
              client,
              `SELECT 1 FROM ${quoteIdent(SIGNAL_OUTBOX.schema)}.ledger`
            ),
            "ledger"
          ).toBe("42501")
          expect(
            await codeOf(
              client,
              `SELECT 1 FROM ${quoteIdent(kind.schema)}.${quoteIdent(kind.name)}`
            ),
            "kind table"
          ).toBe("42501")
          const executable = (
            await client.query<{ fn: string }>(
              `SELECT p.oid::regprocedure::text AS fn FROM pg_catalog.pg_proc p
                WHERE p.pronamespace = $1::regnamespace
                  AND has_function_privilege($2, p.oid, 'EXECUTE')`,
              [SIGNAL_OUTBOX.schema, PLATFORM_ROLES.signalConsumer]
            )
          ).rows.map((r) => r.fn)
          expect(executable).toEqual([])
        })
      )
    })

    it("the request roles get nothing on the outbox", async () => {
      await withModelTarget(model, (url) =>
        inRollback(asSuperuser(url), async (client) => {
          await client.query(
            `SET LOCAL ROLE ${PROVIDER_API_ROLES[testProvider()].user}`
          )
          expect(await codeOf(client, `SELECT 1 FROM ${TABLE}`)).toBe("42501")
          expect(await insert(client, signal())).toBe("42501")
        })
      )
    })
  })
}
