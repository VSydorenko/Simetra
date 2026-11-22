import { randomUUID } from "node:crypto"
import pg from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { PLATFORM_ROLES, ZERO_UUID } from "simetra/model"
import {
  ORG_KIND_ID,
  TICKET_OWN_WRITER_ID,
  TICKET_READER_ID,
  TICKET_REGION_WRITER_ID,
  TICKET_WRITER_ID,
  claimsFor,
  queryAs,
  signUp,
  superuserClient,
  testRoleFor,
} from "../../../simetra/test/support"
import {
  heldResource,
  seedRuntimeActor,
  seedUnderMaintenance,
  withModelTarget,
} from "./support/db"
import {
  BLOB_ID,
  DOC_ID,
  DOC_WRITER_ID,
  LIMIT,
  Session,
  TICKET_ID,
  attachIn,
  newId,
  refused,
  storageModel,
  storageRefusal,
} from "./storage-sql.support"

/**
 * Сховище файлів на справжньому Postgres (спека профілю postgres §8; плану
 * ПГ-5 А інваріанти І1–І6): права ролей на колонки й функції, запис вкладення,
 * облік і межа, попередня перевірка. Тригери й функції вирішує база — текст
 * згенерованого SQL перевіряють unit-тести генератора.
 */

const FILES = PLATFORM_ROLES.files
const COMMAND = PLATFORM_ROLES.command
const STORAGE_FUNCTIONS = [
  "file_attach(uuid, uuid, bigint, text)",
  "storage_rows_exist(uuid, uuid[])",
  "storage_row_page(uuid, uuid)",
  "storage_pending_left()",
  "storage_instance_id()",
]
const HEADROOM = "storage_headroom(uuid, uuid)"

interface Env {
  url: string
  owner: pg.Client
  session: Session
  /** Організація з правом `create` будь-якого обсягу. */
  any: { org: string; user: string }
  own: { org: string; user: string }
  region: { org: string; user: string }
  reader: { org: string; user: string }
  /** Користувач без жодної ролі в організації `any.org`. */
  bare: string
  /** Користувач з глобальною роллю `DocWriter`, і без неї. */
  docWriter: string
  docBare: string
}

const target = heldResource<Env>(async (use) => {
  const model = await storageModel()
  await withModelTarget(model, async (url) => {
    const owner = await superuserClient(new URL(url).pathname.slice(1))
    try {
      const actor = (archetype: string) =>
        seedRuntimeActor(owner, [archetype]).then(({ org, user }) => ({
          org,
          user,
        }))
      const any = await actor(TICKET_WRITER_ID)
      const own = await actor(TICKET_OWN_WRITER_ID)
      const region = await actor(TICKET_REGION_WRITER_ID)
      const reader = await actor(TICKET_READER_ID)
      let bare = ""
      let docWriter = ""
      let docBare = ""
      await seedUnderMaintenance(owner, async () => {
        bare = await signUp(owner)
        docWriter = await signUp(owner)
        docBare = await signUp(owner)
        await owner.query(
          "INSERT INTO public.global_role_assignments (id, subject, archetype) VALUES ($1, $2, $3)",
          [randomUUID(), docWriter, DOC_WRITER_ID]
        )
      })
      const session = await Session.open(url)
      await use({
        url,
        owner,
        session,
        any,
        own,
        region,
        reader,
        bare,
        docWriter,
        docBare,
      })
      await session.client.end()
    } finally {
      await owner.end()
    }
  })
})

let env: Env
beforeAll(async () => {
  env = await target.open()
}, 180_000)
afterAll(() => target.close(), 60_000)

const tx = <T>(fn: (s: Session) => Promise<T>): Promise<T> =>
  env.session.run(() => fn(env.session))

describe("І1: the platform writes the file columns, not the command role", () => {
  it("the command role has no INSERT or UPDATE grant on file_size and file_content_type", async () => {
    await tx(async (s) => {
      const privilege = async (column: string, kind: string) =>
        (
          await s.ok<{ v: boolean }>(
            "SELECT has_column_privilege($1, 'public.ticket', $2, $3) AS v",
            [COMMAND, column, kind]
          )
        )[0]!.v
      for (const column of ["file_size", "file_content_type"])
        for (const kind of ["INSERT", "UPDATE"])
          expect([column, kind, await privilege(column, kind)]).toEqual([
            column,
            kind,
            false,
          ])
      // Контроль: ім'я файлу — звичайний реквізит змісту, його пише команда
      expect(await privilege("file_name", "INSERT")).toBe(true)
      expect(await privilege("file_name", "UPDATE")).toBe(true)
    })
  })

  it.each(["file_size = 1", "file_content_type = 'text/plain'"])(
    "UPDATE of %s is refused even for the owner of the table",
    async (set) => {
      await tx(async (s) => {
        const id = newId()
        expect(await s.attach(TICKET_ID, id, 10, "image/png")).toEqual({
          rows: expect.anything(),
        })
        expect(refused(await s.insertTicket(id, env.any.org))).toBeUndefined()
        const result = await s.as(
          undefined,
          `UPDATE public.ticket SET ${set} WHERE id = $1`,
          [id]
        )
        expect(refused(result)).toMatchObject({
          code: "42501",
          message: "command.forbidden",
          detail: "effect",
        })
      })
    }
  )

  it("UPDATE of the file name passes: the immutability is for the size and the type only", async () => {
    await tx(async (s) => {
      const id = newId()
      await s.attach(TICKET_ID, id, 10, "image/png")
      await s.insertTicket(id, env.any.org)
      expect(
        refused(
          await s.as(
            undefined,
            "UPDATE public.ticket SET file_name = 'b.png' WHERE id = $1",
            [id]
          )
        )
      ).toBeUndefined()
    })
  })
})

describe("І2: file_attach refuses invalid files with storage.attach-invalid", () => {
  const object = TICKET_ID
  it.each([
    ["a type outside mediaTypes", object, 10, "application/pdf"],
    ["a size above maxBytes", object, LIMIT + 1, "image/png"],
    ["a negative size", object, -1, "image/png"],
    ["a null size", object, null, "image/png"],
    ["a null type", object, 10, null],
    ["an object without storage", BLOB_ID, 10, "image/png"],
    ["an unknown object", randomUUID(), 10, "image/png"],
    ["a null object", null, 10, "image/png"],
  ])("%s", async (_, objectId, size, type) => {
    await tx(async (s) => {
      expect(
        refused(await s.attach(objectId as string, newId(), size, type))
      ).toMatchObject(storageRefusal("attach-invalid"))
      expect(
        await s.ok("SELECT count(*)::int AS n FROM simetra.storage_pending")
      ).toEqual([{ n: 0 }])
    })
  })

  it("the same id twice in one transaction is refused, the first record stays", async () => {
    await tx(async (s) => {
      const id = newId()
      expect(refused(await s.attach(object, id, 10, "image/png"))).toBe(
        undefined
      )
      expect(
        refused(await s.attach(object, id, 20, "text/plain"))
      ).toMatchObject(storageRefusal("attach-invalid"))
      expect(
        await s.ok("SELECT size::int AS size FROM simetra.storage_pending")
      ).toEqual([{ size: 10 }])
    })
  })

  it("the size maxBytes and a listed type pass (the boundary)", async () => {
    await tx(async (s) => {
      expect(
        refused(await s.attach(object, newId(), LIMIT, "text/plain"))
      ).toBeUndefined()
    })
  })
})

describe("І3: a row appears only with the file_attach of its own transaction", () => {
  it("an insert with no record is refused with storage.attach-missing", async () => {
    await tx(async (s) => {
      expect(refused(await s.insertTicket(newId(), env.any.org))).toMatchObject(
        storageRefusal("attach-missing")
      )
    })
  })

  it("a record of another transaction does not fit", async () => {
    const id = newId()
    try {
      // Запис закомічено окремою транзакцією: цей `xact` уже не поточний
      await env.owner.query("BEGIN")
      await attachIn(env.owner, TICKET_ID, id, 10, "image/png")
      await env.owner.query("COMMIT")
      await tx(async (s) => {
        expect(refused(await s.insertTicket(id, env.any.org))).toMatchObject(
          storageRefusal("attach-missing")
        )
      })
    } finally {
      await env.owner.query(
        "DELETE FROM simetra.storage_pending WHERE object = $1 AND id = $2",
        [TICKET_ID, id]
      )
    }
  })

  it("the record is taken by the insert: the row gets the size and the type, one version tick, nothing is left", async () => {
    await tx(async (s) => {
      const id = newId()
      await s.attach(TICKET_ID, id, 42, "text/plain")
      const sequence = async () =>
        Number(
          (
            await s.ok<{ last: string }>(
              "SELECT last_value AS last FROM simetra.row_version"
            )
          )[0]!.last
        )
      const before = await sequence()
      expect(refused(await s.insertTicket(id, env.any.org))).toBeUndefined()
      // Версію видає послідовність: рівно одна — вставка, без `UPDATE` після неї
      // (він підняв би версію вдруге, Р4 ПГ-5)
      expect(await sequence()).toBe(before + 1)
      expect(
        await s.ok(
          "SELECT file_size::int AS size, file_content_type AS type, version::int AS version FROM public.ticket WHERE id = $1",
          [id]
        )
      ).toEqual([{ size: 42, type: "text/plain", version: before + 1 }])
      expect(
        await s.as("files", "SELECT simetra.storage_pending_left() AS left")
      ).toEqual({ rows: [{ left: false }] })
      // Запис одного рядка не годиться другому
      expect(refused(await s.insertTicket(newId(), env.any.org))).toMatchObject(
        storageRefusal("attach-missing")
      )
    })
  })

  it("a record that no row took is reported as left in this transaction", async () => {
    await tx(async (s) => {
      await s.attach(TICKET_ID, newId(), 5, "image/png")
      expect(
        await s.as("files", "SELECT simetra.storage_pending_left() AS left")
      ).toEqual({ rows: [{ left: true }] })
    })
  })

  it("a record of one object does not fit a row of another id", async () => {
    await tx(async (s) => {
      await s.attach(TICKET_ID, newId(), 5, "image/png")
      expect(refused(await s.insertTicket(newId(), env.any.org))).toMatchObject(
        storageRefusal("attach-missing")
      )
    })
  })
})

describe("І4: usage and quota", () => {
  const upload = async (s: Session, org: string, size: number) => {
    const id = newId()
    await s.attach(TICKET_ID, id, size, "image/png")
    return { id, result: await s.insertTicket(id, org) }
  }
  const quota = (s: Session, org: string, max: number) =>
    s.ok(
      "INSERT INTO simetra.storage_quota (scope_kind, scope, max_bytes) VALUES ($1, $2, $3)",
      [ORG_KIND_ID, org, max]
    )

  it("an insert adds the size to the usage of its scope, a delete takes it away", async () => {
    await tx(async (s) => {
      const org = env.any.org
      expect(await s.usage(ORG_KIND_ID, org)).toBeNull()
      const first = await upload(s, org, 30)
      await upload(s, org, 12)
      expect(await s.usage(ORG_KIND_ID, org)).toBe(42)
      await s.ok("DELETE FROM public.ticket WHERE id = $1", [first.id])
      expect(await s.usage(ORG_KIND_ID, org)).toBe(12)
      // Ціль іншого скоупу не чіпає
      expect(await s.usage(ORG_KIND_ID, env.own.org)).toBeNull()
    })
  })

  it("an object without a scope keeps its usage under the zero uuids", async () => {
    await tx(async (s) => {
      const id = newId()
      await s.attach(DOC_ID, id, 7, "text/plain")
      expect(
        refused(
          await s.as(
            undefined,
            "INSERT INTO public.doc (id, file_name) VALUES ($1, 'd.txt')",
            [id]
          )
        )
      ).toBeUndefined()
      expect(await s.usage(ZERO_UUID, ZERO_UUID)).toBe(7)
      await s.ok("DELETE FROM public.doc WHERE id = $1", [id])
      expect(await s.usage(ZERO_UUID, ZERO_UUID)).toBe(0)
    })
  })

  it("over the quota is storage.quota-exceeded and the usage rolls back with the refused insert", async () => {
    await tx(async (s) => {
      const org = env.region.org
      await quota(s, org, 50)
      expect(refused((await upload(s, org, 30)).result)).toBeUndefined()
      expect(refused((await upload(s, org, 30)).result)).toMatchObject(
        storageRefusal("quota-exceeded")
      )
      expect(await s.usage(ORG_KIND_ID, org)).toBe(30)
      // До межі включно проходить
      expect(refused((await upload(s, org, 20)).result)).toBeUndefined()
      expect(await s.usage(ORG_KIND_ID, org)).toBe(50)
    })
  })

  it("a scope without a quota row has no limit", async () => {
    await tx(async (s) => {
      expect(refused((await upload(s, env.reader.org, LIMIT)).result)).toBe(
        undefined
      )
    })
  })

  it("two parallel uploads near the quota: one is refused, the usage is exact", async () => {
    const org = env.own.org
    const second = await superuserClient(new URL(env.url).pathname.slice(1))
    const done: string[] = []
    try {
      await env.owner.query(
        "INSERT INTO simetra.storage_quota (scope_kind, scope, max_bytes) VALUES ($1, $2, 150)",
        [ORG_KIND_ID, org]
      )
      const start = async (client: pg.Client) => {
        const id = randomUUID()
        await client.query("BEGIN")
        await attachIn(client, TICKET_ID, id, 100, "image/png")
        return id
      }
      const firstId = await start(env.owner)
      await env.owner.query(
        "INSERT INTO public.ticket (id, org_id, file_name) VALUES ($1, $2, 'a.png')",
        [firstId, org]
      )
      const secondId = await start(second)
      // Вставка другого чекає рядок обліку першого, поки той не закомітиться
      const pending = second
        .query(
          "INSERT INTO public.ticket (id, org_id, file_name) VALUES ($1, $2, 'b.png')",
          [secondId, org]
        )
        .then(
          () => "inserted",
          (error: pg.DatabaseError) => `${error.code}:${error.detail}`
        )
      await new Promise((resolve) => setTimeout(resolve, 300))
      await env.owner.query("COMMIT")
      done.push(firstId)
      expect(await pending).toBe("SF001:quota-exceeded")
      await second.query("ROLLBACK")
      expect(
        (
          await env.owner.query(
            "SELECT bytes::int AS bytes FROM simetra.storage_usage WHERE scope_kind = $1 AND scope = $2",
            [ORG_KIND_ID, org]
          )
        ).rows
      ).toEqual([{ bytes: 100 }])
    } finally {
      await env.owner.query("ROLLBACK").catch(() => undefined)
      await second.query("ROLLBACK").catch(() => undefined)
      await second.end()
      for (const id of done)
        await env.owner.query("DELETE FROM public.ticket WHERE id = $1", [id])
      await env.owner.query(
        "DELETE FROM simetra.storage_quota WHERE scope_kind = $1 AND scope = $2",
        [ORG_KIND_ID, org]
      )
    }
  })
})

describe("І5: storage_headroom is the necessary check of the upload", () => {
  const headroom = (user: string, object: string, scope: string | null) =>
    tx((s) =>
      queryAs<{ v: boolean | null }>(
        s.client,
        "user",
        claimsFor("user", user),
        "SELECT simetra.storage_headroom($1, $2) AS v",
        [object, scope]
      )
    )
  const answer = async (user: string, object: string, scope: string | null) =>
    (await headroom(user, object, scope)) as { rows: { v: boolean }[] }

  it.each([
    ["any", () => env.any],
    ["own", () => env.own],
    ["dimension", () => env.region],
  ])("a role with create at %s covers its scope", async (_, who) => {
    const { user, org } = who()
    expect(await answer(user, TICKET_ID, org)).toEqual({ rows: [{ v: true }] })
  })

  it.each([
    ["a role with read only", () => [env.reader.user, env.reader.org]],
    ["a member of the scope without a role", () => [env.bare, env.any.org]],
    [
      "a foreign scope (create@any elsewhere)",
      () => [env.any.user, env.own.org],
    ],
    ["no scope", () => [env.any.user, null]],
    ["an unknown scope", () => [env.any.user, randomUUID()]],
  ])("%s is false", async (_, args) => {
    const [user, scope] = args() as [string, string | null]
    expect(await answer(user, TICKET_ID, scope)).toEqual({
      rows: [{ v: false }],
    })
  })

  it("an object without storage and an unknown object are false", async () => {
    for (const object of [BLOB_ID, randomUUID()])
      expect(await answer(env.any.user, object, env.any.org)).toEqual({
        rows: [{ v: false }],
      })
  })

  it("a file of maxBytes that does not fit the quota is false, one that fits is true", async () => {
    await tx(async (s) => {
      const org = env.any.org
      await s.ok(
        "INSERT INTO simetra.storage_quota (scope_kind, scope, max_bytes) VALUES ($1, $2, $3)",
        [ORG_KIND_ID, org, LIMIT + 10]
      )
      const ask = () =>
        queryAs<{ v: boolean }>(
          s.client,
          "user",
          claimsFor("user", env.any.user),
          "SELECT simetra.storage_headroom($1, $2) AS v",
          [TICKET_ID, org]
        )
      expect(await ask()).toEqual({ rows: [{ v: true }] })
      const id = newId()
      await s.attach(TICKET_ID, id, 20, "image/png")
      await s.insertTicket(id, org)
      expect(await ask()).toEqual({ rows: [{ v: false }] })
    })
  })

  it("an object without a scope is judged by has_right", async () => {
    expect(await answer(env.docWriter, DOC_ID, null)).toEqual({
      rows: [{ v: true }],
    })
    expect(await answer(env.docBare, DOC_ID, null)).toEqual({
      rows: [{ v: false }],
    })
  })

  it("the request role reads neither the usage nor the quota", async () => {
    for (const table of [
      "storage_usage",
      "storage_quota",
      "storage_pending",
      "storage_instance",
    ]) {
      const result = await tx((s) =>
        queryAs(
          s.client,
          "user",
          claimsFor("user", env.any.user),
          `SELECT * FROM simetra.${table}`
        )
      )
      expect(result).toEqual({ code: "42501" })
    }
  })
})

describe("І6: the reconciliation functions and who may call what", () => {
  it("rows_exist sees the rows of another tenant, row_page lists them in order", async () => {
    await tx(async (s) => {
      const ids: string[] = []
      for (const org of [env.any.org, env.own.org]) {
        const id = newId()
        await s.attach(TICKET_ID, id, 1, "image/png")
        await s.insertTicket(id, org)
        ids.push(id)
      }
      const stranger = newId()
      const found = await s.as<{ id: string }>(
        "files",
        "SELECT * FROM simetra.storage_rows_exist($1, $2) AS id",
        [TICKET_ID, [...ids, stranger]]
      )
      expect(
        "rows" in found && found.rows.map((r) => Object.values(r)[0])
      ).toEqual(expect.arrayContaining(ids))
      expect("rows" in found && found.rows).toHaveLength(2)
      const page = await s.as(
        "files",
        "SELECT x AS id FROM simetra.storage_row_page($1, NULL) AS x",
        [TICKET_ID]
      )
      expect("rows" in page && page.rows.map((r) => r.id)).toEqual(
        [...ids].sort()
      )
      const after = await s.as(
        "files",
        "SELECT x AS id FROM simetra.storage_row_page($1, $2) AS x",
        [TICKET_ID, [...ids].sort()[0]]
      )
      expect("rows" in after && after.rows.map((r) => r.id)).toEqual(
        [...ids].sort().slice(1)
      )
    })
  })

  it.each([
    [
      "rows_exist",
      "SELECT * FROM simetra.storage_rows_exist($1, $2)",
      [BLOB_ID, [randomUUID()]],
    ],
    [
      "rows_exist (unknown)",
      "SELECT * FROM simetra.storage_rows_exist($1, $2)",
      [randomUUID(), [randomUUID()]],
    ],
    ["row_page", "SELECT * FROM simetra.storage_row_page($1, NULL)", [BLOB_ID]],
    [
      "rows_exist (1001 ids)",
      "SELECT * FROM simetra.storage_rows_exist($1, $2)",
      [TICKET_ID, Array.from({ length: 1001 }, () => randomUUID())],
    ],
  ])(
    "%s: an object without storage or too many ids are refused (22023)",
    async (_, sql, params) => {
      await tx(async (s) => {
        expect(refused(await s.as("files", sql, params))).toMatchObject({
          code: "22023",
        })
      })
    }
  )

  it("rows_exist takes exactly 1000 ids", async () => {
    await tx(async (s) => {
      expect(
        refused(
          await s.as(
            "files",
            "SELECT * FROM simetra.storage_rows_exist($1, $2)",
            [TICKET_ID, Array.from({ length: 1000 }, () => randomUUID())]
          )
        )
      ).toBeUndefined()
    })
  })

  it("only simetra_files executes the file functions; the request role executes only the headroom", async () => {
    await tx(async (s) => {
      const holders = async (signature: string) =>
        (
          await s.ok<{ grantee: string }>(
            `SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END AS grantee
               FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
              WHERE p.oid = ('simetra.' || $1)::regprocedure AND a.privilege_type = 'EXECUTE'
                AND a.grantee <> p.proowner
              ORDER BY 1`,
            [signature]
          )
        ).map((r) => r.grantee)
      for (const signature of STORAGE_FUNCTIONS)
        expect([signature, await holders(signature)]).toEqual([
          signature,
          [FILES],
        ])
      expect(await holders(HEADROOM)).toEqual([testRoleFor("user")])
      // Прямо: ні роль команд, ні роль гостя виклику не мають
      for (const role of ["command", "anonymous"] as const)
        for (const signature of [...STORAGE_FUNCTIONS, HEADROOM]) {
          const result = await s.as(
            role,
            `SELECT simetra.${signature.replace(/\(.*/, "")}(${signature
              .replace(/^[^(]*\(/, "")
              .replace(/\)$/, "")
              .split(",")
              .filter((t) => t.trim() !== "")
              .map(() => "NULL")
              .join(", ")})`
          )
          expect([role, signature, refused(result)?.code]).toEqual([
            role,
            signature,
            "42501",
          ])
        }
    })
  })

  it("under simetra_files the call passes: the role has USAGE of the schema", async () => {
    await tx(async (s) => {
      expect(
        refused(await s.attach(TICKET_ID, newId(), 1, "image/png"))
      ).toBeUndefined()
    })
  })
})
