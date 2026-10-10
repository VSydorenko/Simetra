import { promoteInput, type PromoteInput } from "simetra/compiler"
import { metaFiles, project, uuid } from "../helpers"

/**
 * Фікстура промоції (план «Промоція-4», задачі 7–9): прийнята таблиця
 * `Counterparty` з модулем боргу, спільною функцією, що її читає, таблицею
 * контактів (кандидат у ТЧ) і рахунком (кандидат у документ), що посилаються
 * на неї. Перемикачі вимикають частини, яких задача ще не вміє: без модуля
 * немає й спільної функції, бо обидва — SQL, що його класифікує й переписує
 * задача 9.
 */
export interface PromotionParts {
  module?: boolean
  contacts?: boolean
  invoice?: boolean
}

export const COUNTERPARTY_ID = uuid(7001)
export const COUNTERPARTY_COLUMNS = {
  id: uuid(7002),
  name: uuid(7003),
  inn: uuid(7004),
  isDeleted: uuid(7005),
  createdAt: uuid(7006),
}
export const INN_ID = COUNTERPARTY_COLUMNS.inn
export const CONTACT_ID = uuid(7101)
export const INVOICE_ID = uuid(7201)

export const COUNTERPARTY_FILE =
  "custom-tables/Counterparty/Counterparty.meta.json"
export const COUNTERPARTY_SQL = "custom-tables/Counterparty/Counterparty.sql"
export const CONTACT_FILE =
  "custom-tables/CounterpartyContact/CounterpartyContact.meta.json"
export const INVOICE_FILE = "custom-tables/Invoice/Invoice.meta.json"
export const SHARED_SQL = "sql/app/counterparty_names.sql"
export const CATALOG_FILE = "catalogs/Counterparty/Counterparty.meta.json"

/** Ідентичності одиниць модуля `Counterparty` — ключі `conversions`. */
export const COUNTERPARTY_UNITS = {
  trigger: "trigger:app.counterparties.counterparty_touch",
  policy: "policy:app.counterparties.counterparties_read",
  grant: "grant:grant:table:app.counterparties:authenticated:select",
}

const COUNTERPARTY_MODULE = `CREATE FUNCTION app.counterparty_touch() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $fn$
BEGIN
  NEW.name := btrim(NEW.name);
  RETURN NEW;
END
$fn$;

CREATE TRIGGER counterparty_touch BEFORE INSERT OR UPDATE ON app.counterparties
  FOR EACH ROW EXECUTE FUNCTION app.counterparty_touch();

CREATE POLICY counterparties_read ON app.counterparties FOR SELECT TO authenticated USING (true);

GRANT SELECT ON app.counterparties TO authenticated;
`

const COUNTERPARTY_NAMES = `CREATE FUNCTION app.counterparty_names() RETURNS TABLE (name text, inn text) LANGUAGE sql STABLE AS $fn$
  SELECT c.name, c.inn FROM app.counterparties c
$fn$;
`

const column = (
  id: string,
  name: string,
  physicalName: string,
  rest: Record<string, unknown>
) => ({ id, name, physicalName, ...rest })

function counterparty() {
  const c = COUNTERPARTY_COLUMNS
  return {
    id: COUNTERPARTY_ID,
    kind: "CustomTable",
    name: "Counterparty",
    physicalName: "counterparties",
    kindLabel: "counterparty",
    schema: "app",
    comment: "Counterparties of the company",
    columns: [
      column(c.id, "id", "id", { type: "UUID", notNull: true }),
      column(c.name, "name", "name", { type: "Text", notNull: true }),
      column(c.inn, "inn", "inn", { type: "Text" }),
      column(c.isDeleted, "isDeleted", "is_deleted", {
        type: "Boolean",
        notNull: true,
        default: "false",
      }),
      column(c.createdAt, "createdAt", "created_at", {
        type: "DateTime",
        default: "now()",
      }),
    ],
    primaryKey: { name: "counterparties_pkey", columns: ["id"] },
    uniques: [{ name: "counterparties_inn_key", columns: ["inn"] }],
    rowLevelSecurity: "enabled",
  }
}

function contact() {
  return {
    id: CONTACT_ID,
    kind: "CustomTable",
    name: "CounterpartyContact",
    physicalName: "counterparty_contacts",
    kindLabel: "counterparty_contact",
    schema: "app",
    columns: [
      column(uuid(7102), "id", "id", { type: "UUID", notNull: true }),
      column(uuid(7103), "counterpartyId", "counterparty_id", {
        type: "UUID",
        notNull: true,
      }),
      column(uuid(7104), "phone", "phone", { type: "Text" }),
    ],
    primaryKey: { name: "counterparty_contacts_pkey", columns: ["id"] },
    foreignKeys: [
      {
        name: "counterparty_contacts_counterparty_id_fkey",
        columns: ["counterpartyId"],
        references: {
          object: { kind: "CustomTable", name: "Counterparty" },
          columns: ["id"],
        },
        onDelete: "cascade",
      },
    ],
  }
}

function invoice() {
  return {
    id: INVOICE_ID,
    kind: "CustomTable",
    name: "Invoice",
    physicalName: "invoices",
    kindLabel: "invoice",
    schema: "app",
    columns: [
      column(uuid(7202), "id", "id", { type: "UUID", notNull: true }),
      column(uuid(7203), "number", "number", { type: "Text" }),
      column(uuid(7204), "docDate", "doc_date", { type: "Date" }),
      column(uuid(7205), "status", "status", { type: "Text", notNull: true }),
      column(uuid(7206), "amount", "amount", {
        type: "Numeric",
        precision: 15,
        scale: 2,
      }),
      column(uuid(7207), "counterpartyId", "counterparty_id", {
        type: "UUID",
      }),
    ],
    primaryKey: { name: "invoices_pkey", columns: ["id"] },
    checks: [
      {
        name: "invoices_status_check",
        expression: "status IN ('draft', 'posted')",
      },
    ],
    foreignKeys: [
      {
        name: "invoices_counterparty_id_fkey",
        columns: ["counterpartyId"],
        references: {
          object: { kind: "CustomTable", name: "Counterparty" },
          columns: ["id"],
        },
      },
    ],
  }
}

/** Тека фікстури; усі частини типово ввімкнено. */
export function promotionProject(o: PromotionParts = {}): Map<string, string> {
  const { module = true, contacts = true, invoice: withInvoice = true } = o
  return metaFiles({
    "project.meta.json": project(),
    [COUNTERPARTY_FILE]: counterparty(),
    ...(module
      ? {
          [COUNTERPARTY_SQL]: COUNTERPARTY_MODULE,
          [SHARED_SQL]: COUNTERPARTY_NAMES,
          "sql-debt.json": {
            units: Object.values(COUNTERPARTY_UNITS).sort(),
          },
        }
      : {}),
    ...(contacts ? { [CONTACT_FILE]: contact() } : {}),
    ...(withInvoice ? { [INVOICE_FILE]: invoice() } : {}),
  })
}

/**
 * Мапінг-зразок: `Counterparty` → довідник без коду. Без модуля вхід не
 * класифікує його одиниць: ключ, що нічого не називає, — відмова. Колонка
 * `createdAt` допускає `NULL`, а стандартна `createdAt` — ні, тож крок
 * ремонту заповнює наявні `NULL` (рішення 15); ремонт детермінований, тож
 * без `now()`.
 */
export const CREATED_AT_REPAIR =
  "coalesce(created_at, '2000-01-01 00:00:00+00'::timestamptz)"

export function counterpartyMapping(o: PromotionParts = {}): PromoteInput {
  const { module = true } = o
  return promoteInput.parse({
    target: { name: "Counterparty" },
    into: {
      kind: "Catalog",
      name: "Counterparty",
      data: { codeLength: 0, descriptionLength: 150 },
    },
    columns: {
      id: { to: "standard", name: "ref" },
      name: { to: "standard", name: "description" },
      inn: { to: "attribute", element: { name: "taxId" } },
      isDeleted: { to: "standard", name: "deletionMark" },
      createdAt: { to: "standard", name: "createdAt" },
    },
    fill: [
      {
        target: { to: "standard", name: "createdAt" },
        expression: CREATED_AT_REPAIR,
      },
    ],
    conversions: {
      "Counterparty#uniques/counterparties_inn_key": "property",
      ...(module
        ? {
            [COUNTERPARTY_UNITS.trigger]: "platform",
            [COUNTERPARTY_UNITS.policy]: "platform",
            [COUNTERPARTY_UNITS.grant]: "platform",
          }
        : {}),
    },
  })
}
