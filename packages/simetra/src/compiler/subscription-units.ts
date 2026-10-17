import { quoteIdent, type SubscriptionEvent } from "simetra/model"
import type { EventSubscriptionContract } from "./contracts"
import { compareStrings, diagnostic, type Diagnostic } from "./diagnostics"
import type { SqlParser } from "./sql/parse"
import { generatedUnit, type SqlUnit } from "./sql/units"

/** Час і події тригера за подією підписки (спека промоції §9.3). */
const TIMING: Readonly<
  Record<SubscriptionEvent, { timing: "BEFORE" | "AFTER"; write: boolean }>
> = {
  beforeWrite: { timing: "BEFORE", write: true },
  onWrite: { timing: "AFTER", write: true },
  beforeDelete: { timing: "BEFORE", write: false },
  onDelete: { timing: "AFTER", write: false },
}

type Source = EventSubscriptionContract["sources"][number]

/**
 * Імена тригерів підписки на джерелі. З `whenChanged` вставка йде окремим
 * тригером: умова `OLD … IS DISTINCT FROM NEW …` на вставці не має `OLD`, а
 * вставка мусить спрацьовувати завжди. Простір імен тригерів у Postgres —
 * таблиця, тож кожне джерело дає ті самі імена.
 */
export function subscriptionTriggerNames(
  contract: EventSubscriptionContract,
  source: Source
): string[] {
  return source.whenChanged.length === 0
    ? [contract.name]
    : [contract.name, `${contract.name}_insert`]
}

/**
 * Тригери підписок на подію (спека промоції §9.3): `FOR EACH ROW` на кожне
 * джерело контракту, зокрема на таблицю провайдера. Одна одиниця на
 * оператор — ідентичність `trigger:<схема>.<таблиця>.<ім'я>` дає той самий
 * `classify`, що й дослівному SQL, тож дослівна копія стає дублікатом, а не
 * другим вузлом. `COMMENT ON TRIGGER` не генерується: опис живе в метаданих.
 */
export function buildSubscriptionUnits(
  subscriptions: readonly EventSubscriptionContract[],
  module: string,
  parse: SqlParser
): SqlUnit[] {
  const units = subscriptions.flatMap((contract) =>
    contract.sources.flatMap((source) =>
      triggers(contract, source).map((sql): SqlUnit => ({
        ...generatedUnit(sql, source.schema, parse),
        ownerObjectId: contract.subscriptionId,
        module,
        generator: "subscription",
      }))
    )
  )
  return units.sort((a, b) => compareStrings(a.identity, b.identity))
}

function triggers(contract: EventSubscriptionContract, source: Source) {
  const { timing, write } = TIMING[contract.event]
  const table = `${quoteIdent(source.schema)}.${quoteIdent(source.table)}`
  const execute = `EXECUTE FUNCTION ${quoteIdent(contract.handler.schema)}.${quoteIdent(contract.handler.name)}();`
  const trigger = (name: string, events: string, when?: string) =>
    `CREATE TRIGGER ${quoteIdent(name)} ${timing} ${events} ON ${table} FOR EACH ROW ` +
    (when === undefined ? "" : `WHEN (${when}) `) +
    execute
  if (!write) return [trigger(contract.name, "DELETE")]
  const [name, insert] = subscriptionTriggerNames(contract, source)
  if (insert === undefined) return [trigger(name!, "INSERT OR UPDATE")]
  // Кожне порівняння в дужках — та сама форма, що в `pg_get_triggerdef`:
  // текст одиниці читається так, як його покаже жива база.
  const changed = source.whenChanged
    .map((c) => `(OLD.${quoteIdent(c)} IS DISTINCT FROM NEW.${quoteIdent(c)})`)
    .join(" OR ")
  return [trigger(name!, "UPDATE", changed), trigger(insert, "INSERT")]
}

/**
 * Тригер підписки, чию ідентичність уже дає інша згенерована одиниця
 * (механіка, платформний шар, інша підписка). `namespaceConflicts` пари
 * згенерованих одиниць не звіряє, а граф створення перезаписав би вузол
 * мовчки, тож збіг — помилка на `/physicalName` підписки. Власник імені —
 * не-підписка, а між підписками — та, чий файл раніше за шляхом: помилку
 * отримує пізніший, як у `subscription.name-duplicate`.
 */
export function subscriptionTriggerConflicts(
  units: readonly SqlUnit[],
  fileOf: (objectId: string | undefined) => string,
  describe: (unit: SqlUnit) => string
): Diagnostic[] {
  const byIdentity = new Map<string, SqlUnit[]>()
  for (const unit of units) {
    if (unit.file !== undefined || unit.class !== "trigger") continue
    byIdentity.set(unit.identity, [
      ...(byIdentity.get(unit.identity) ?? []),
      unit,
    ])
  }
  const found: Diagnostic[] = []
  for (const group of byIdentity.values()) {
    if (group.length < 2) continue
    const rank = (unit: SqlUnit) => (unit.generator === "subscription" ? 1 : 0)
    const [holder, ...rest] = [...group].sort(
      (a, b) =>
        rank(a) - rank(b) ||
        compareStrings(fileOf(a.ownerObjectId), fileOf(b.ownerObjectId))
    )
    for (const unit of rest) {
      if (unit.generator !== "subscription") continue
      const target = unit.identity.slice("trigger:".length)
      found.push(
        diagnostic(
          "subscription.trigger-name-taken",
          fileOf(unit.ownerObjectId),
          "/physicalName",
          {
            name: unit.name,
            table: target.slice(0, target.length - unit.name.length - 1),
            holder: describe(holder!),
          }
        )
      )
    }
  }
  return found
}
