import type { CompiledModel } from "simetra/compiler"
import {
  catalogCommandContracts,
  type CatalogCommandContract,
} from "../../catalog-command/contracts"
import type { SqlParser } from "../../sql/parse"
import type { PlpgsqlParser } from "../../sql/plpgsql"

/**
 * Контракт ядра команд таблиці скомпільованої моделі — тими самими входами, що
 * в конвеєрі: тести генераторів ядра звіряють SQL з переліками контракту.
 */
export function commandContractOf(
  model: CompiledModel,
  table: string,
  parsers: { parse: SqlParser; plpgsql: PlpgsqlParser }
): CatalogCommandContract {
  const found = catalogCommandContracts({
    access: model.contracts.access,
    rights: model.contracts.rights,
    physical: model.physical,
    objects: model.objects,
    attributeCase: model.project.naming.attributeCase,
    usersObjectId: model.contracts.users?.objectId,
    scopeRootIds: new Set(
      model.scopeKinds.flatMap((k) =>
        "objectId" in k.root ? [k.root.objectId] : []
      )
    ),
    subscriptions: model.contracts.eventSubscriptions,
    units: model.sqlUnits,
    ...parsers,
  }).find((c) => c.table.name === table)
  if (found === undefined) throw new Error(`no command contract for ${table}`)
  return found
}
