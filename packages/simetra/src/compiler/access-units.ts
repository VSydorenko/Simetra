import {
  PUBLIC_READ_PURPOSES,
  type PhysicalSnapshot,
  type PublicReadRole,
  type RequestRolePurpose,
} from "simetra/model"
import type { CompiledScopeKind } from "./compile"
import type { AccessContract } from "./contracts"
import { compareStrings } from "./diagnostics"
import { isDeclaredTable } from "./stages/model"
import type { ParsedObject } from "./stages/files"

/**
 * Контракт доступу кожної таблиці виду з RLS (платформна спека §6.7, §6.8):
 * основної, ТЧ і похідних таблиць регістра — бо кожна з них закрита RLS, і
 * без грантів і політик API її не прочитав би. Прийнята таблиця (`CustomTable`)
 * запису не має: її доступ описує файл, а не платформа. Викликається лише на
 * моделі без помилок.
 */
export function accessContracts(
  objects: readonly ParsedObject[],
  physical: PhysicalSnapshot,
  scopeKinds: readonly CompiledScopeKind[],
  scopeKindIdByFile: ReadonlyMap<string, string>
): AccessContract[] {
  const byId = new Map(objects.map((o) => [o.id ?? "", o]))
  return physical.tables
    .flatMap((table): AccessContract[] => {
      if (table.rowLevelSecurity === "off") return []
      const object = must(byId.get(table.origin.objectId))
      if (isDeclaredTable(object)) return []
      const kindId = scopeKindIdByFile.get(object.file)
      const scope =
        kindId === undefined
          ? undefined
          : {
              scopeKindId: kindId,
              // Носій — лише позначена моделлю колонка: ім'я не вгадується, бо
              // в кореня це `id`, у рядка ТЧ кореня — `parent_id`.
              carrier: must(
                table.columns.find((c) => c.origin.scopeKindId === kindId)
              ).name,
              setFunction: must(scopeKinds.find((k) => k.id === kindId))
                .setFunction,
            }
      return [
        {
          objectId: table.origin.objectId,
          table: { schema: table.schema, name: table.name },
          ...(scope === undefined ? {} : { scope }),
          publicRead: publicReadPurposes(
            (object.data as { publicRead?: PublicReadRole }).publicRead
          ),
        },
      ]
    })
    .sort(
      (a, b) =>
        compareStrings(a.table.schema, b.table.schema) ||
        compareStrings(a.table.name, b.table.name)
    )
}

/** Гість бачить не більше за користувача: `anon` відкриває обидві ролі запиту. */
function publicReadPurposes(
  role: PublicReadRole | undefined
): RequestRolePurpose[] {
  if (role === undefined) return []
  const purposes = new Set<RequestRolePurpose>([PUBLIC_READ_PURPOSES[role]])
  if (role === "anon") purposes.add("user")
  return [...purposes].sort(compareStrings)
}

/** Модель без помилок гарантує наявність; відсутність — дефект компілятора. */
function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("internal: missing access input")
  return value
}
