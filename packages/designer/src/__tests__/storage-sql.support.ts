import { randomUUID } from "node:crypto"
import pg from "pg"
import { compile, type CompiledModel } from "simetra/compiler"
import { PLATFORM_ROLES, STORAGE_TABLES, ZERO_UUID } from "simetra/model"
import {
  adminRoles,
  commandCoreLayer,
  policyDomain,
  profileLayer,
  readQueryLayer,
  refAttribute,
  restoreOwnerRole,
  ROLE_FILE,
  superuserClient,
  testRoleFor,
  uuid,
  type Layer,
} from "../../../simetra/test/support"
import { expect } from "vitest"

/**
 * Модель сховища файлів для DB-тестів: довідник `Attachment` у скоупі `org`
 * (з носієм власності й виміром, тож усі три обсяги права `create`) зі
 * властивістю `storage` і нескоуплений довідник `Doc` з глобальною роллю.
 * `Attachment` свій, а не `Ticket` ядра команд: у `Ticket` є `containerBinding`,
 * з яким `storage` несумісне (`storage.incompatible`), а `Ticket` читають інші
 * тести прав. Спільне для файлів `storage-*.db.test.ts`.
 */

export const ATTACHMENT_FILE = "catalogs/Attachment/Attachment.meta.json"
export const DOC_FILE = "catalogs/Doc/Doc.meta.json"
export const DOC_ID = uuid(9802)
export const DOC_WRITER_ID = uuid(9803)
export const ATTACHMENT_ID = uuid(9805)
export const ATTACHMENT_WRITER_ID = uuid(9806)
export const ATTACHMENT_OWN_WRITER_ID = uuid(9807)
export const ATTACHMENT_REGION_WRITER_ID = uuid(9808)
export const ATTACHMENT_READER_ID = uuid(9809)
export const BLOB_FILE = "catalogs/Blob/Blob.meta.json"
export const BLOB_ID = uuid(9804)

export const LIMIT = 100
export const TYPES = ["image/png", "text/plain"]
export const STORAGE = { maxBytes: LIMIT, mediaTypes: TYPES }

const doc = (storage?: typeof STORAGE) => ({
  id: DOC_ID,
  kind: "Catalog",
  name: "Doc",
  physicalName: "doc",
  kindLabel: "doc",
  scope: "none",
  ...(storage === undefined ? {} : { storage }),
})

const ATTACHMENT_OBJECT = [{ kind: "Catalog", name: "Attachment" }]
const attachmentRole = (
  id: string,
  name: string,
  actions: string[],
  extent: unknown
) => ({
  id,
  kind: "Role",
  name,
  assignedOn: { scopeKind: "org" },
  grants: [{ grant: { objects: ATTACHMENT_OBJECT, actions, extent } }],
})
const WRITES = ["read", "create", "update", "markDeletion"]

/** Шар сховища: `Attachment` зі `storage` (без контейнерної прив'язки) і `Doc`, який пише глобальна роль. */
export function storageLayer(): Layer {
  return {
    [ATTACHMENT_FILE]: {
      id: ATTACHMENT_ID,
      kind: "Catalog",
      name: "Attachment",
      physicalName: "attachment",
      kindLabel: "attachment",
      scope: "org",
      trackAuthor: true,
      ownership: ["assignee"],
      access: [{ attribute: "region", dimension: "region" }],
      attributes: [
        refAttribute(9810, "assignee", "assignee_id", {
          kind: "Catalog",
          name: "OrgMember",
        }),
        refAttribute(9811, "region", "region_id", {
          kind: "Catalog",
          name: "Region",
        }),
      ],
      storage: STORAGE,
    },
    [ROLE_FILE("AttachmentWriter")]: attachmentRole(
      ATTACHMENT_WRITER_ID,
      "AttachmentWriter",
      WRITES,
      "any"
    ),
    [ROLE_FILE("AttachmentOwnWriter")]: attachmentRole(
      ATTACHMENT_OWN_WRITER_ID,
      "AttachmentOwnWriter",
      WRITES,
      "own"
    ),
    [ROLE_FILE("AttachmentRegionWriter")]: attachmentRole(
      ATTACHMENT_REGION_WRITER_ID,
      "AttachmentRegionWriter",
      WRITES,
      { dimension: "region" }
    ),
    [ROLE_FILE("AttachmentReader")]: attachmentRole(
      ATTACHMENT_READER_ID,
      "AttachmentReader",
      ["read"],
      "any"
    ),
    [DOC_FILE]: doc(STORAGE),
    "roles/DocWriter/DocWriter.meta.json": {
      id: DOC_WRITER_ID,
      kind: "Role",
      name: "DocWriter",
      assignedOn: "global",
      grants: [
        {
          grant: {
            objects: [{ kind: "Catalog", name: "Doc" }],
            actions: ["read", "create"],
            extent: "any",
          },
        },
      ],
    },
  }
}

export async function storageModel(...layers: Layer[]): Promise<CompiledModel> {
  const result = await compile(
    policyDomain(
      readQueryLayer(),
      profileLayer(),
      commandCoreLayer(),
      adminRoles(),
      storageLayer(),
      ...layers
    )
  )
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
  return result.model!
}

/** Роль, від якої сховище перевіряє виклики: платформна чи гостя профілю. */
export type Who = "files" | "command" | "anonymous"

/** Відмова запиту: код, повідомлення й `DETAIL` Postgres. */
export interface Failure {
  code: string
  message: string
  detail?: string
}

/**
 * Клієнт суперкористувача цілі `url` у транзакції, що завжди відкочується:
 * кожен тест лишає ціль як знайшов. Оператор — у точці збереження, тож
 * відмова не зриває транзакції; роль ставиться `SET LOCAL` і зникає з нею.
 */
export class Session {
  private constructor(readonly client: pg.Client) {}

  static async open(url: string): Promise<Session> {
    return new Session(await superuserClient(new URL(url).pathname.slice(1)))
  }

  /** Тіло тесту в транзакції; відкат — на кожному шляху. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.client.query("BEGIN")
    try {
      return await fn()
    } finally {
      await this.client.query("ROLLBACK")
    }
  }

  /**
   * Оператор від імені `who` (`undefined` — суперкористувач): рядки чи відмова.
   * Ролі — лише ті, що вживає сховище: перемикання роллю платформи чи профілю
   * іде в дозволених формах `role-switch.test.ts`.
   */
  async as<R extends pg.QueryResultRow = pg.QueryResultRow>(
    who: Who | undefined,
    sql: string,
    params: unknown[] = []
  ): Promise<{ rows: R[] } | Failure> {
    await this.client.query("SAVEPOINT attempt")
    try {
      if (who === "files")
        await this.client.query(`SET LOCAL ROLE ${PLATFORM_ROLES.files}`)
      else if (who === "command")
        await this.client.query(`SET LOCAL ROLE ${PLATFORM_ROLES.command}`)
      else if (who === "anonymous")
        await this.client.query(`SET LOCAL ROLE ${testRoleFor("anonymous")}`)
      const { rows } = await this.client.query<R>(sql, params)
      await restoreOwnerRole(this.client)
      await this.client.query("RELEASE SAVEPOINT attempt")
      return { rows }
    } catch (error) {
      if (!(error instanceof pg.DatabaseError)) throw error
      await this.client.query("ROLLBACK TO SAVEPOINT attempt")
      await restoreOwnerRole(this.client)
      return {
        code: error.code ?? "",
        message: error.message,
        ...(error.detail === undefined ? {} : { detail: error.detail }),
      }
    }
  }

  /** Оператор від суперкористувача, який має пройти. */
  async ok<R extends pg.QueryResultRow = pg.QueryResultRow>(
    sql: string,
    params: unknown[] = []
  ): Promise<R[]> {
    const result = await this.as<R>(undefined, sql, params)
    if ("code" in result) throw new Error(`${result.code}: ${result.message}`)
    return result.rows
  }

  /** `file_attach` від ролі сховища файлів. */
  attach(object: string, id: string, size: number | null, type: string | null) {
    return this.as("files", "SELECT simetra.file_attach($1, $2, $3, $4)", [
      object,
      id,
      size,
      type,
    ])
  }

  /** Вставка рядка довідника зі `storage` власником таблиці: тригери спрацьовують. */
  insertAttachment(id: string, org: string, name = "a.png") {
    return this.as(
      undefined,
      "INSERT INTO public.attachment (id, org_id, file_name) VALUES ($1, $2, $3)",
      [id, org, name]
    )
  }

  /** Облік обсягу `(kind, scope)`; без рядка — `null`. */
  async usage(kind: string, scope: string): Promise<number | null> {
    const [row] = await this.ok<{ bytes: string }>(
      `SELECT bytes FROM simetra.storage_usage WHERE scope_kind = $1 AND scope = $2`,
      [kind, scope]
    )
    return row === undefined ? null : Number(row.bytes)
  }
}

export const refused = (
  result: { rows: unknown[] } | Failure
): Failure | undefined => ("code" in result ? result : undefined)

/** Відмова сховища: `SF001`, повідомлення й причина в `DETAIL`. */
export const storageRefusal = (detail: string): Failure => ({
  code: "SF001",
  message: "storage.rejected",
  detail,
})

export const newId = (): string => randomUUID()
export const ZERO = ZERO_UUID
export const USAGE_TABLE = `${STORAGE_TABLES.usage.schema}.${STORAGE_TABLES.usage.name}`

const blob = (storage?: typeof STORAGE) => ({
  id: BLOB_ID,
  kind: "Catalog",
  name: "Blob",
  physicalName: "blob",
  kindLabel: "blob",
  scope: "none",
  ...(storage === undefined ? {} : { storage }),
})

/** Модель без жодного об'єкта зі `storage`: основа для проби видалення й додавання. */
export async function bareModel(...layers: Layer[]): Promise<CompiledModel> {
  const result = await compile(
    policyDomain(
      readQueryLayer(),
      profileLayer(),
      commandCoreLayer(),
      adminRoles(),
      ...layers
    )
  )
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
  return result.model!
}

/** `Blob` без `storage`, але зі звичайним реквізитом, чия колонка зветься `file_size`. */
export const blobWithPlainSizeLayer: Layer = {
  [BLOB_FILE]: {
    ...blob(),
    attributes: [
      {
        id: uuid(9811),
        name: "fileSize",
        physicalName: "file_size",
        type: "String",
        length: 20,
      },
    ],
  },
}

/** Довідник `Blob` — з властивістю `storage` чи без неї. */
export const blobLayer = (withStorage: boolean): Layer => ({
  [BLOB_FILE]: blob(withStorage ? STORAGE : undefined),
})

/**
 * `file_attach` від ролі сховища файлів на клієнті в **відкритій** транзакції:
 * `SET LOCAL ROLE` діє до її кінця, тож виклик — саме в ній. Для кейсів, що
 * коммітять запис чи тримають кілька з'єднань.
 */
export async function attachIn(
  client: pg.Client,
  object: string,
  id: string,
  size: number,
  type: string
): Promise<void> {
  await client.query(`SET LOCAL ROLE ${PLATFORM_ROLES.files}`)
  await client.query("SELECT simetra.file_attach($1, $2, $3, $4)", [
    object,
    id,
    size,
    type,
  ])
  await restoreOwnerRole(client)
}
