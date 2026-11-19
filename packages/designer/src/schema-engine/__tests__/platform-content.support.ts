import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import {
  PLATFORM_ROLES,
  PROVIDER_API_ROLES,
  SIGNAL_OUTBOX,
} from "simetra/model"
import { compile } from "simetra/compiler"
import {
  engineScope,
  renderDesiredState,
  reverseGenerate,
} from "simetra/schema"
import {
  catalog,
  FIXTURES,
  metaFiles,
  superuserClient,
  testProvider,
  testRoleName,
} from "../../../../simetra/test/support"
import { dropRoles } from "../../__tests__/support/db"
import {
  deployedRoundTrip,
  engine,
  errors,
  inTarget,
  kindsOf,
  parser,
  schemaPath,
  tableKeys,
  unscoped,
  withClient,
} from "./round-trip.support"

/**
 * Живі інваріанти «платформне — лише за вмістом» (план #286) на шляху
 * моделі: ціль — бажаний стан скомпільованої теки (установка й шар
 * платформи в `simetra`), за потреби змінений одним SQL, → `engine.extract`
 * з межею моделі (має `simetra`) → `reverseGenerate` з нуля. Тести
 * реєструються з файлу кожного профілю (`round-trip.db.test.ts`,
 * `round-trip.supabase.db.test.ts`), бо проєкт `db-supabase` читає лише свої
 * файли; хуки тіней — `useRoundTrip` того файлу.
 */

/** Помилка прийому: код і файл теки, куди лягла одиниця. */
type Refusal = { code: string; file: string }

/**
 * Прийом з нуля бази з бажаного стану `files`, після якого виконано
 * `mutation`. Повертає помилки зворотної генерації (з компіляцією теки).
 */
async function adoptedFromScratch(
  files: Map<string, string>,
  mutation: string
): Promise<Refusal[]> {
  const compiled = await compile(files)
  expect(errors(compiled.diagnostics)).toEqual([])
  const model = compiled.model!
  const { scope } = await engineScope(model)
  // Межа моделі — з `simetra`: інакше тест ішов би межею `introspect`, де
  // об'єкти платформи ховає політика двигуна, а не розпізнавач
  expect(scope.schemas).toContain(SIGNAL_OUTBOX.schema)
  return inTarget(renderDesiredState(model).sql, scope, async (target) => {
    if (mutation !== "") await withClient(target, (c) => c.query(mutation))
    const extracted = await engine.extract(target, scope)
    expect(errors(extracted.diagnostics)).toEqual([])
    const reversed = await reverseGenerate(extracted.model, {
      project: {
        name: model.project.name,
        defaultSchema: model.project.defaultSchema,
        attributeCase: model.project.naming.attributeCase,
        databaseProvider: model.project.database.provider,
      },
      existing: new Map(),
      newId: () => randomUUID(),
      schemaPath,
      parse: parser(),
    })
    return errors(reversed.diagnostics).map((d) => ({
      code: d.code,
      file: d.file,
    }))
  })
}

/** Порожній проєкт профілю прогону: лише установка платформи. */
const emptyProject = () =>
  metaFiles({
    "project.meta.json": {
      name: "PlatformContent",
      defaultSchema: "app",
      database: { provider: testProvider() },
    },
  })

/** Проєкт з видом: таблиця виду несе механіку, тож база має `simetra.touch()`. */
const projectWithKind = () =>
  metaFiles({
    "project.meta.json": {
      name: "PlatformContent",
      defaultSchema: "app",
      database: { provider: testProvider() },
    },
    "catalogs/Currency/Currency.meta.json": catalog("Currency"),
  })

/** Кластерна роль з тегом прогону на час `fn`; її створює суперкористувач стека. */
async function withTaggedRole<T>(fn: (role: string) => Promise<T>): Promise<T> {
  const role = testRoleName("platform_content")
  const client = await superuserClient()
  try {
    await client.query(`CREATE ROLE ${role} NOLOGIN`)
  } finally {
    await client.end()
  }
  try {
    return await fn(role)
  } finally {
    await dropRoles(role)
  }
}

const OUTBOX = `${SIGNAL_OUTBOX.schema}.${SIGNAL_OUTBOX.name}`

/** И1–И4: чужий вміст під платформною ціллю чи ім'ям — гучна помилка теки. */
export function describeModelPathInvariants(): void {
  describe("from scratch over the model scope only the platform's content is the platform's", () => {
    // Контроль: та сама ціль без зміни приймається чисто, тож помилки нижче
    // дає саме зміна, а не форма каталогу
    it.each([
      ["an empty project", emptyProject],
      ["a project with a kind", projectWithKind],
    ])("%s is adopted without errors", async (_name, files) => {
      expect(await adoptedFromScratch(files(), "")).toEqual([])
    })

    it("a grant with the grant option under an install grant is refused (И1)", async () => {
      expect(
        await adoptedFromScratch(
          emptyProject(),
          `GRANT SELECT ON ${OUTBOX} TO ${PLATFORM_ROLES.signalConsumer} WITH GRANT OPTION`
        )
      ).toEqual([
        {
          code: "schema.reserved",
          file: `sql/simetra/grant__table__simetra_signal_outbox__${PLATFORM_ROLES.signalConsumer}__select.sql`,
        },
      ])
    })

    it("a grant on the outbox prune function to another role is refused (И2)", async () => {
      await withTaggedRole(async (role) => {
        expect(
          await adoptedFromScratch(
            emptyProject(),
            `GRANT EXECUTE ON FUNCTION simetra.signal_outbox_prune(interval) TO ${role}`
          )
        ).toEqual([
          {
            code: "schema.reserved",
            file: `sql/simetra/grant__function__simetra_signal_outbox_prune_interval__${role}__execute.sql`,
          },
        ])
      })
    })

    it("a grant on a shared mechanics function to another role is refused (И3)", async () => {
      await withTaggedRole(async (role) => {
        expect(
          await adoptedFromScratch(
            projectWithKind(),
            `GRANT EXECUTE ON FUNCTION simetra.touch() TO ${role}`
          )
        ).toEqual([
          {
            code: "schema.reserved",
            file: `sql/simetra/grant__function__simetra_touch__${role}__execute.sql`,
          },
        ])
      })
    })

    it("an outbox policy given to another role is refused (И4)", async () => {
      await withTaggedRole(async (role) => {
        expect(
          await adoptedFromScratch(
            emptyProject(),
            `ALTER POLICY signal_outbox_consumer_select ON ${OUTBOX} TO ${role}`
          )
        ).toEqual([
          {
            code: "schema.reserved",
            file: "sql/simetra/signal_outbox__signal_outbox_consumer_select.sql",
          },
        ])
      })
    })
  })
}

const COMMAND = PLATFORM_ROLES.command
const USER = PROVIDER_API_ROLES[testProvider()].user

/** Гранти читання таблиці виду ролям команд і користувача API. */
const readGrants = (table: string) =>
  [COMMAND, USER].map((role) => `grant:grant:table:app.${table}:${role}:select`)

/**
 * Гранти довідника за контрактом доступу: читання, вставка й зміна колонок
 * команд (`code`, `description` і `columns`), позначка вилучення.
 */
const catalogGrants = (table: string, columns: string[] = []) => [
  ...readGrants(table),
  `grant:grant:table:app.${table}:${COMMAND}:insert(id)`,
  `grant:grant:table:app.${table}:${COMMAND}:update(deletion_mark)`,
  ...["code", "description", ...columns].map(
    (c) => `grant:grant:table:app.${table}:${COMMAND}:insert(${c}),update(${c})`
  ),
]

const schemaUsage = [COMMAND, USER].map(
  (role) => `grant:grant:schema:app:${role}:usage`
)

/**
 * Одиниці, які прийом з нуля кладе в теку дослівно, бо їхній вміст залежить
 * від моделі видів і еталона без теки не має (Р2, Р3), — за фікстурою й
 * родиною, записані явно (умова архітекторки 2): виведений з еталона
 * помічника перелік зробив би оракул порожнім. Таблиця виду стає
 * `CustomTable` без контракту доступу, тож її гранти — SQL застосунку;
 * обгортка запиту рухів несе запит автора. Корпус без «Користувачів» і прав,
 * тож носіїв, ефектів і guards у ньому немає (Р8).
 */
const FOLDER_UNITS: Readonly<
  Record<string, Readonly<Record<string, string[]>>>
> = {
  "scoped catalog with hierarchy, owner, code numbering and predefined items": {
    hierarchy: [
      "function:app.item_simetra_hierarchy()",
      "grant:revoke:function:app.item_simetra_hierarchy():public:execute",
      "trigger:app.item.item_simetra_hierarchy",
      "trigger:app.item.item_simetra_hierarchy_update",
    ],
    access: [
      ...catalogGrants("item", [
        "is_folder",
        "owner_id",
        "parent_id",
        "price",
        "sku",
      ]),
      ...catalogGrants("organization"),
      ...catalogGrants("partner"),
    ],
    schemaUsage,
  },
  "document with two tabular sections, number_period and required check": {
    access: [
      ...catalogGrants("item"),
      ...catalogGrants("organization"),
      ...["sale", "sale_goods", "sale_services"].flatMap(readGrants),
    ],
    schemaUsage,
  },
  "balance and turnover accumulation registers with turnovers_month and totals":
    {
      movementQuery: [
        "function:app.sale_sales_movements(uuid)",
        "function:app.sale_stock_movements(uuid)",
      ],
      access: [
        ...catalogGrants("item"),
        ...catalogGrants("organization"),
        ...[
          "sale",
          "sale_goods",
          "sales",
          "sales_turnovers_month",
          "stock",
          "stock_totals",
          "stock_turnovers_month",
        ].flatMap(readGrants),
      ],
      schemaUsage,
    },
  "independent and subordinate information registers with nullable dimensions":
    {
      movementQuery: ["function:app.sale_rates_movements(uuid)"],
      access: [
        ...catalogGrants("item"),
        ...catalogGrants("organization"),
        ...["prices", "rates", "sale"].flatMap(readGrants),
      ],
      schemaUsage,
    },
  "scoped and global constants": {
    access: [
      ...catalogGrants("item"),
      ...catalogGrants("organization"),
      ...["main_item", "vat_rate"].flatMap(readGrants),
    ],
    schemaUsage,
  },
  "custom table with composite key, FK to auth.users, partial expression index, generated column, deferrable unique":
    {
      access: [...catalogGrants("organization"), ...catalogGrants("partner")],
      schemaUsage,
    },
  "enumeration reference with check and pg enum column": {
    access: [
      ...catalogGrants("item", ["color"]),
      ...catalogGrants("organization"),
    ],
    schemaUsage,
  },
  "movement query wrapper and a scope set function unit": {
    movementQuery: ["function:app.sale_stock_movements(uuid)"],
    access: [
      ...catalogGrants("item"),
      ...catalogGrants("organization"),
      ...[
        "sale",
        "sale_goods",
        "stock",
        "stock_totals",
        "stock_turnovers_month",
      ].flatMap(readGrants),
    ],
    schemaUsage,
  },
}

/**
 * Прийом з нуля корпусу фікстур розгортання (без видів скоупу, `unscoped`):
 * повний ланцюжок §9, втрата — лише родини з еталоном (`mechanicsLoss`), а
 * тека дослівних одиниць — рівно одиниці застосунку фікстури плюс
 * `FOLDER_UNITS` (И8).
 */
export function describeAdoptionFromScratch(): void {
  describe("adoption from scratch: the deployment fixture corpus survives the round trip", () => {
    for (const [name, fixture] of FIXTURES) {
      it(name, async () => {
        const { source, result } = await deployedRoundTrip(
          unscoped(fixture(testProvider())),
          new Map(),
          true
        )
        const model = result!.model
        // Види 1С повертаються як `CustomTable` з тими самими фізичними іменами
        expect(tableKeys(model)).toEqual(tableKeys(source))
        expect(
          kindsOf(model).filter(
            (kind) => kind !== "CustomTable" && kind !== "PgEnum"
          )
        ).toEqual([])
        // Усі файли `.sql` повернутої теки, а не фільтр за шляхом: нормалізація
        // не сховала платформної одиниці (зайва одиниця тут — хибне «чуже»)
        const verbatim = model.sqlUnits.filter((u) => u.file !== undefined)
        const families = FOLDER_UNITS[name]
        // Фікстура без запису — новий кейс корпусу: перелік пишуть явно
        expect(families).toBeDefined()
        expect(verbatim.map((u) => u.identity).sort()).toEqual(
          [
            ...source.sqlUnits
              .filter((u) => u.file !== undefined)
              .map((u) => u.identity),
            ...Object.values(families!).flat(),
          ].sort()
        )
        expect(
          verbatim
            .filter((u) => u.schema === SIGNAL_OUTBOX.schema)
            .map((u) => u.identity)
        ).toEqual([])
      })
    }
  })
}
