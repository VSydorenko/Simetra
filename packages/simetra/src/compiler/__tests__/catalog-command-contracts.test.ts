import { beforeAll, describe, expect, it } from "vitest"
import type { CompileResult, CompiledModel } from "simetra/compiler"
import {
  authorColumns,
  markDeletionAction,
  predefinedNameColumn,
  serviceDateColumns,
  standardLogicalName,
  versionColumn,
  type PhysicalColumn,
} from "simetra/model"
import {
  catalogCommandContracts,
  type CatalogCommandContract,
  type CommandReference,
} from "../catalog-command/contracts"
import { loadSqlParser, type SqlParser } from "../sql/parse"
import { loadPlpgsqlParser, type PlpgsqlParser } from "../sql/plpgsql"
import { handlerAssigns } from "../stages/links"
import {
  TICKET_FILE,
  catalog,
  commandCoreLayer,
  compileRights,
  compiledPolicyDomain,
  adminRoles,
  objects,
  policyDomain,
  scopeRootCarrier,
  singleTenantRights,
  withAttributeCase,
  writeRoles,
  type Layer,
} from "./fixtures/rights"
import { uuid } from "./helpers"

const deletionMark = { logicalName: markDeletionAction.transition!.column }

let parse: SqlParser
let plpgsql: PlpgsqlParser
beforeAll(async () => {
  parse = await loadSqlParser()
  plpgsql = await loadPlpgsqlParser()
})

/** Контракти ядра скомпільованої моделі — з тих самих контрактів, що й гранти. */
function contractsOf(model: CompiledModel): CatalogCommandContract[] {
  return catalogCommandContracts({
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
    parse,
    plpgsql,
  })
}

async function compiled(
  result: CompileResult | Promise<CompileResult>
): Promise<CompiledModel> {
  const { model, diagnostics } = await result
  expect(diagnostics).toEqual([])
  return model!
}

const contractOf = (
  contracts: readonly CatalogCommandContract[],
  table: string
): CatalogCommandContract => {
  const found = contracts.find((c) => c.table.name === table)
  expect(found, table).toBeDefined()
  return found!
}

const grantOf = (model: CompiledModel, table: string) =>
  model.contracts.access.find((a) => a.table.name === table)!.command!

/** Посилання з іменами таблиць цілей замість знімків. */
const named = (references: readonly CommandReference[]) =>
  references.map((r) =>
    r.form === "single"
      ? { ...r, target: r.target.name }
      : { ...r, targets: r.targets.map((t) => ({ ...t, table: t.table.name })) }
  )

describe("catalogCommandContracts", () => {
  let model: CompiledModel
  let contracts: CatalogCommandContract[]
  let global: CatalogCommandContract[]
  beforeAll(async () => {
    model = await compiled(
      compileRights(
        policyDomain(
          writeRoles(),
          adminRoles(),
          commandCoreLayer(),
          scopeRootCarrier()
        )
      )
    )
    contracts = contractsOf(model)
    global = contractsOf(await compiled(compileRights(singleTenantRights())))
  })

  // Різниця гранту й ключів — лише колонки переходів і позначка видалення:
  // на звичайному довіднику позначка — сама перехід `markDeletion`, у
  // системних довідниках прав переходу немає, тож вилучено саму позначку.
  it.each([
    ["ticket", "insert", []],
    ["ticket", "update", ["deletion_mark"]],
    ["org_roles", "insert", ["deletion_mark"]],
    ["org_roles", "update", ["deletion_mark"]],
    ["org_role_assignments", "insert", ["deletion_mark"]],
    ["org_role_assignments", "update", ["deletion_mark"]],
  ] as const)("ключі %s = грант %s мінус %j", (table, dml, removed) => {
    const contract = contractOf(contracts, table)
    const keys = dml === "insert" ? contract.createKeys : contract.updateKeys
    const grant = grantOf(model, table)[dml]
    expect(grant.filter((c) => !keys.includes(c))).toEqual(removed)
    expect(keys.filter((c) => !grant.includes(c))).toEqual([])
  })

  const style = "camelCase" as const
  const standardOf = (defs: { logicalName: string }[]) => {
    const names = new Set(defs.map((d) => standardLogicalName(d, style)))
    return (c: PhysicalColumn) => names.has(c.origin.standard ?? "")
  }
  // Кожен рядок спершу доводить, що така колонка в таблиці є: інакше
  // порожній перетин нічого б не доводив.
  it.each([
    ["механіка", standardOf([versionColumn(), ...serviceDateColumns()])],
    ["авторство", standardOf(authorColumns())],
    ["predefined_name", standardOf([predefinedNameColumn()])],
    ["позначка видалення", standardOf([deletionMark])],
    ["копії носіїв", (c: PhysicalColumn) => c.origin.copyOf !== undefined],
  ] as const)("ключі не містять колонок: %s", (_, matches) => {
    const keys = (c: CatalogCommandContract) => [
      ...c.createKeys,
      ...c.updateKeys,
    ]
    const tables = ["ticket", "task_comment"].map((t) =>
      contractOf(contracts, t)
    )
    const columns = tables.flatMap((c) => c.table.columns.filter(matches))
    expect(columns).not.toEqual([])
    expect(
      tables.flatMap(keys).filter((k) => columns.some((c) => c.name === k))
    ).toEqual([])
  })

  it.each([
    [
      "звичайний довідник",
      "ticket",
      { create: "create", update: "update", markDeletion: "markDeletion" },
    ],
    [
      "«Ролі»",
      "org_roles",
      {
        create: "administerRights",
        update: "administerRights",
        markDeletion: "administerRights",
      },
    ],
    [
      "«Призначення»",
      "org_role_assignments",
      {
        create: "administerRights",
        update: "administerRights",
        markDeletion: "administerRights",
        delete: "administerRights",
      },
    ],
    ["«Користувачі»", "users", { update: "update" }],
    [
      "корінь скоупу",
      "organization",
      { update: "update", markDeletion: "markDeletion" },
    ],
  ])("дії: %s", (_, table, actions) => {
    const contract = contractOf(contracts, table)
    expect(contract.actions).toEqual(actions)
    // Функція є рівно для тих дій, що мають гілку.
    expect(Object.keys(contract.functions).sort()).toEqual(
      [
        "save",
        ...("markDeletion" in actions ? ["markDeletion"] : []),
        ...("delete" in actions ? ["delete"] : []),
      ].sort()
    )
  })

  it("глобальні «Призначення» мають delete; імена — алгоритм імен Postgres", () => {
    expect(contractOf(global, "global_role_assignments").functions).toEqual({
      save: { schema: "public", name: "global_role_assignments_save" },
      markDeletion: {
        schema: "public",
        name: "global_role_assignments_mark_deletion",
      },
      delete: { schema: "public", name: "global_role_assignments_delete" },
    })
  })

  it("ТЧ кореня скоупу: scopeColumn немає, колонки INSERT ТЧ без повторів", () => {
    const [section] = contractOf(contracts, "organization").tabularSections
    expect(section).toBeDefined()
    const { table, references, ...rest } = section!
    expect({ table: table.name, references, ...rest }).toEqual({
      table: "organization_sites",
      key: "id",
      parent: "parent_id",
      lineNumber: "line_number",
      rowKeys: ["label"],
      updateColumns: ["label"],
      references: [],
    })
    const insert = [rest.key, rest.parent, rest.lineNumber, ...rest.rowKeys]
    expect([...new Set(insert)].sort()).toEqual(
      [...grantOf(model, "organization_sites").insert].sort()
    )
  })

  it("ТЧ: rowKeys без key, parent, lineNumber і колонки скоупу", () => {
    const [section] = contractOf(contracts, "ticket").tabularSections
    const { table, references, ...rest } = section!
    expect({ table: table.name, ...rest }).toEqual({
      table: "ticket_checklist",
      key: "id",
      parent: "parent_id",
      lineNumber: "line_number",
      scopeColumn: "org_id",
      rowKeys: ["line_region_id", "related_id"],
      updateColumns: ["line_region_id", "related_id"],
    })
    expect(named(references)).toEqual([
      {
        form: "single",
        column: "line_region_id",
        target: "region",
        targetKey: "id",
        array: false,
      },
      {
        form: "single",
        column: "related_id",
        target: "ticket",
        targetKey: "id",
        array: false,
      },
    ])
  })

  it("поліморфний Ref — pair з мітками цілей; масив і батько — single", () => {
    const single = (column: string, target: string, array = false) => ({
      form: "single",
      column,
      target,
      targetKey: "id",
      array,
    })
    expect(named(contractOf(contracts, "ticket").references)).toEqual([
      single("parent_id", "ticket"),
      single("assignee_id", "org_member"),
      single("region_id", "region"),
      single("project_id", "project"),
      {
        form: "pair",
        typeColumn: "subject_type",
        idColumn: "subject_id",
        array: false,
        targets: [
          {
            label: "project",
            table: "project",
            key: "id",
            scopeColumn: "org_id",
          },
          {
            label: "region",
            table: "region",
            key: "id",
            scopeColumn: "org_id",
          },
        ],
      },
      single("watchers", "org_member", true),
    ])
  })

  it("копії носіїв — зв'язки тригера носіїв основної таблиці", () => {
    const links = contractOf(contracts, "task_comment").carrierLinks
    expect(
      links.map((l) => ({
        table: l.table.name,
        source: l.source.name,
        through: l.through,
        copies: l.copies,
      }))
    ).toEqual([
      {
        table: "task_comment",
        source: "task",
        through: "task_id",
        copies: [{ name: expect.any(String), column: "assignee_id" }],
      },
    ])
  })

  it("версія, predefined_name, скоуп і ієрархія — за origin", () => {
    const ticket = contractOf(contracts, "ticket")
    expect({
      key: ticket.key,
      scopeColumn: ticket.scopeColumn,
      versionColumn: ticket.versionColumn,
      predefinedColumn: ticket.predefinedColumn,
      hierarchy: ticket.hierarchy,
      kindLabel: ticket.kindLabel,
    }).toEqual({
      key: "id",
      scopeColumn: "org_id",
      versionColumn: "version",
      predefinedColumn: "predefined_name",
      hierarchy: { parent: "parent_id", lockAlways: false },
      kindLabel: "ticket",
    })
    expect(contractOf(contracts, "region").hierarchy).toBeUndefined()
  })
})

const NOTE_FILE = "catalogs/TicketNote/TicketNote.meta.json"
const LINK_FILE = "catalogs/TicketLink/TicketLink.meta.json"

/** Підпорядковані довідники: з одним власником і з двома. */
function subordinates(): Layer {
  return {
    [NOTE_FILE]: catalog(uuid(6940), "TicketNote", "ticket_note", {
      owners: objects(["Catalog", "Ticket"]),
    }),
    [LINK_FILE]: catalog(uuid(6941), "TicketLink", "ticket_link", {
      owners: objects(["Catalog", "Ticket"], ["Catalog", "Project"]),
    }),
  }
}

describe("власник підпорядкованого довідника — посилання ядра", () => {
  it.each([
    [
      "один власник — single",
      "ticket_note",
      {
        form: "single",
        column: "owner_id",
        target: "ticket",
        targetKey: "id",
        array: false,
      },
    ],
    [
      "кілька — pair",
      "ticket_link",
      {
        form: "pair",
        typeColumn: "owner_type",
        idColumn: "owner_id",
        array: false,
        targets: [
          {
            label: "ticket",
            table: "ticket",
            key: "id",
            scopeColumn: "org_id",
          },
          {
            label: "project",
            table: "project",
            key: "id",
            scopeColumn: "org_id",
          },
        ],
      },
    ],
  ])("%s", async (_, table, owner) => {
    const model = await compiled(
      compileRights(policyDomain(commandCoreLayer(), subordinates()))
    )
    expect(named(contractOf(contractsOf(model), table).references)).toEqual([
      owner,
    ])
  })
})

describe("замок ієрархії від обробника beforeWrite (Р-A2-17)", () => {
  const SUBSCRIPTION_FILE =
    "event-subscriptions/TicketParent/TicketParent.meta.json"
  const handler = (body: string) =>
    `CREATE FUNCTION public.ticket_parent() RETURNS trigger LANGUAGE plpgsql VOLATILE SET search_path = '' AS $$ BEGIN ${body} RETURN NEW; END $$;`
  const subscription: Layer = {
    [SUBSCRIPTION_FILE]: {
      id: uuid(6945),
      kind: "EventSubscription",
      name: "TicketParent",
      physicalName: "ticket_parent",
      sources: objects(["Catalog", "Ticket"]),
      event: "beforeWrite",
      handler: { schema: "public", name: "ticket_parent" },
    },
  }

  it.each([
    ["присвоює parent_id", "NEW.parent_id := NULL;", true],
    ["не присвоює", "NEW.description := 'x';", false],
  ])("обробник %s → lockAlways %s", async (_, body, lockAlways) => {
    const model = await compiled(
      compiledPolicyDomain({ "sql/public/ticket-parent.sql": handler(body) }, [
        commandCoreLayer(),
        subscription,
      ])
    )
    expect(contractOf(contractsOf(model), "ticket").hierarchy).toEqual({
      parent: "parent_id",
      lockAlways,
    })
  })

  // Через `compile` нерозбірний обробник недосяжний
  // (`subscription.handler-not-closed`), тож fail-closed — тут.
  it("нерозбірний обробник — «присвоює»", () => {
    const failing: PlpgsqlParser = () => ({ ok: false, message: "stub" })
    expect(
      handlerAssigns(handler(""), new Set(["parent_id"]), parse, failing)
    ).toBe(true)
  })
})

// Контракт за `origin`, не за іменем: та сама модель в обох стилях дає ті
// самі фізичні колонки ключів, позначки й ТЧ.
for (const attributeCase of ["camelCase", "snake_case"] as const) {
  const name = `${attributeCase}: контракт за origin, не за іменем`
  if (attributeCase === "snake_case") {
    // snake_case-проєкт із довідниками прав ще не компілюється: борг прав §1
    // (docs/superpowers/plans/2026-10-26-rights-residual-debt.md). Увімкнути
    // разом із виправленням боргу.
    it.todo(name)
    continue
  }
  it(name, async () => {
    const model = await compiled(
      compileRights(
        policyDomain(
          writeRoles(),
          commandCoreLayer(),
          withAttributeCase(attributeCase)
        )
      )
    )
    const ticket = contractOf(contractsOf(model), "ticket")
    const [section] = ticket.tabularSections
    expect({
      grant: grantOf(model, "ticket"),
      createKeys: ticket.createKeys,
      updateKeys: ticket.updateKeys,
      deletionMark: ticket.table.columns.find(
        (c) =>
          c.origin.standard === standardLogicalName(deletionMark, attributeCase)
      )?.name,
      section: [section!.parent, section!.lineNumber, ...section!.rowKeys],
    }).toEqual({
      grant: {
        insert: [
          "id",
          "org_id",
          "code",
          "description",
          "parent_id",
          "is_folder",
          "assignee_id",
          "region_id",
          "project_id",
          "subject_type",
          "subject_id",
          "watchers",
        ],
        update: [
          "code",
          "description",
          "deletion_mark",
          "parent_id",
          "is_folder",
          "assignee_id",
          "region_id",
          "project_id",
          "subject_type",
          "subject_id",
          "watchers",
        ],
        delete: false,
      },
      createKeys: [
        "id",
        "org_id",
        "code",
        "description",
        "parent_id",
        "is_folder",
        "assignee_id",
        "region_id",
        "project_id",
        "subject_type",
        "subject_id",
        "watchers",
      ],
      updateKeys: [
        "code",
        "description",
        "parent_id",
        "is_folder",
        "assignee_id",
        "region_id",
        "project_id",
        "subject_type",
        "subject_id",
        "watchers",
      ],
      deletionMark: "deletion_mark",
      section: ["parent_id", "line_number", "line_region_id", "related_id"],
    })
  })
}

it("ім'я save довідника, зайняте дослівною функцією, — physical.function-duplicate", async () => {
  const { diagnostics } = await compiledPolicyDomain(
    {
      "sql/public/clash.sql":
        "CREATE FUNCTION public.ticket_save() RETURNS integer LANGUAGE sql STABLE SET search_path = '' AS $$ SELECT 1 $$;",
    },
    [commandCoreLayer()]
  )
  expect(
    diagnostics
      .filter((d) => d.code === "physical.function-duplicate")
      .map((d) => ({ file: d.file, name: d.params?.name }))
  ).toEqual([{ file: TICKET_FILE, name: "ticket_save" }])
})
