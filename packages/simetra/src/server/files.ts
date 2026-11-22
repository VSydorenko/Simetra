import {
  CommandFailure,
  isPlainObject,
  type CommandError,
  type MetadataRef,
  type Operation,
  type RuntimeCatalog,
  type RuntimeObject,
} from "simetra/model"
import { z } from "zod"
import { refOf, withObject } from "./errors"
import type { AttachStep } from "./transaction"

/** The input of {@link CommandRuntime.checkUpload}. */
export interface CheckUploadInput {
  object: MetadataRef
  /** The scope the file row would be created in; `null`/absent for an unscoped object. */
  scope?: string | null
}

/** What a user may upload to an object: the limits of its `storage`. */
export interface UploadLimits {
  maxBytes: number
  mediaTypes: string[]
  /**
   * The database binding string read in the same transaction as the check
   * (`FileStore.put` option `instance`, see `parseBinding`).
   */
  instance: string
}

/** The input of {@link CommandRuntime.attachFile}. */
export interface AttachFileInput {
  object: MetadataRef
  /** The scope of the row; required for a scoped object, absent otherwise. */
  scope?: string | null
  /** The row id the server generated and wrote the bytes under (`fileObjectKey`). */
  id: string
  /** The file name; stored in the `file_name` attribute. */
  name: string
  /** Other attributes of the row, by logical names. */
  fields?: Record<string, unknown>
  /** The byte count `FileStore.put` counted itself. */
  size: number
  /** The content type of the bytes. */
  contentType: string
}

const FILE_NAME_COLUMN = "file_name"
const uuid = z.guid()

/** Об'єкт зі `storage` за посиланням; `undefined` — немає такого чи без сховища. */
export function storageObjectOf(
  catalog: RuntimeCatalog,
  ref: unknown
): RuntimeObject | undefined {
  let found: RuntimeObject | undefined
  try {
    const parsed = z
      .strictObject({ kind: z.string(), name: z.string() })
      .safeParse(ref)
    if (!parsed.success) return undefined
    found = catalog.objects.find(
      (o) => o.kind === parsed.data.kind && o.name === parsed.data.name
    )
  } catch {
    // Геттер, що кидає, чи відкликаний `Proxy` у вході.
    return undefined
  }
  return found?.storage === undefined ? undefined : found
}

/**
 * Скоуп для `storage_headroom` і `create`: `undefined` — скоуп не відповідає
 * об'єкту (немає чи зайвий, чи не UUID).
 */
export function scopeOf(
  object: RuntimeObject,
  scope: unknown
): string | null | undefined {
  if (object.scopeColumn === undefined) {
    return scope === undefined || scope === null ? null : undefined
  }
  return typeof scope === "string" && uuid.safeParse(scope).success
    ? scope
    : undefined
}

/**
 * Вхід `attachFile` → операція `create` і крок вкладення. Перевірка — до бази:
 * ім'я, розмір, тип, скоуп і `fields` (їх значення ще судить `prepareInput`).
 * Ім'я йде в реквізит `file_name` каталогу під його стильованим логічним
 * іменем; розміру й типу в операції немає — їх ставить лише `file_attach`.
 */
export function prepareAttach(
  catalog: RuntimeCatalog,
  input: AttachFileInput
): { operation: Operation; attach: AttachStep } {
  const object = storageObjectOf(catalog, input?.object)
  if (object === undefined) {
    throw new CommandFailure({ code: "command.invalid", path: "object" })
  }
  const refuse = (path: string): never => {
    const error: CommandError = withObject(
      { code: "command.invalid", path },
      object
    )
    throw new CommandFailure(error)
  }
  if (typeof input.name !== "string") refuse("name")
  if (typeof input.contentType !== "string") refuse("contentType")
  if (!Number.isSafeInteger(input.size) || input.size < 0) refuse("size")
  if (typeof input.id !== "string" || !uuid.safeParse(input.id).success) {
    refuse(object.keyName)
  }
  if (input.fields !== undefined && !isPlainObject(input.fields)) {
    refuse("fields")
  }
  const scope = scopeOf(object, input.scope)
  if (scope === undefined) refuse("scope")
  const nameAttribute = object.attributes.find(
    (a) => a.column === FILE_NAME_COLUMN
  )
  // Каталог зі `storage` без реквізиту імені — дефект компіляції, не вхід.
  if (nameAttribute === undefined) {
    throw new CommandFailure({ code: "command.internal" })
  }
  const scopeAttribute =
    object.scopeColumn === undefined
      ? undefined
      : object.attributes.find((a) => a.column === object.scopeColumn)
  let values: Record<string, unknown>
  try {
    values = {
      ...input.fields,
      [nameAttribute.name]: input.name,
      ...(scopeAttribute === undefined || scope === null
        ? {}
        : { [scopeAttribute.name]: scope }),
    }
  } catch {
    // Геттер, що кидає, чи відкликаний `Proxy` у `fields`.
    return refuse("fields")
  }
  return {
    operation: {
      action: "create",
      object: refOf(object),
      id: input.id,
      values,
    },
    attach: {
      object: object.id,
      id: input.id,
      size: input.size,
      type: input.contentType,
    },
  }
}
