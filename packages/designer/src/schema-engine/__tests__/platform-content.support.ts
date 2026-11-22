import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import {
  PLATFORM_ROLES,
  PROVIDER_API_ROLES,
  PROVIDER_OWNER_ROLES,
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
  DOCS_GRANT,
  POLICY_DEBT,
  POLICY_FUNCTION,
  READ_POLICY,
  policyFiles,
} from "../../../../simetra/src/compiler/__tests__/fixtures/policy-function"
import {
  CATALOG_OUTBOX_TABLE,
  CATALOG_UNIT_FORMS,
} from "../../../../simetra/src/compiler/__tests__/fixtures/platform-catalog-forms"
import {
  deployedRoundTrip,
  engine,
  errors,
  inTarget,
  kindsOf,
  parser,
  restoreScopeKinds,
  schemaPath,
  tableKeys,
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
    "catalogs/Item/Item.meta.json": catalog("Item"),
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

    // Пари нормалізації (Р5) записано з живого extract; тут вони лишаються
    // формами живого каталогу на профілі прогону, інакше правило помічника
    // звіряло б не те, що дає база (И8)
    it("the recorded catalog forms are the live catalog's", async () => {
      const files = projectWithKind()
      const compiled = await compile(files)
      expect(errors(compiled.diagnostics)).toEqual([])
      const { scope } = await engineScope(compiled.model!)
      const live = await inTarget(
        renderDesiredState(compiled.model!).sql,
        scope,
        async (target) => (await engine.extract(target, scope)).model
      )
      const units = new Map(live.units.map((u) => [u.identity, u.sql]))
      expect(
        Object.fromEntries(
          Object.keys(CATALOG_UNIT_FORMS).map((id) => [id, units.get(id)])
        )
      ).toEqual(CATALOG_UNIT_FORMS)
      expect(
        live.tables.find(
          (t) =>
            t.schema === SIGNAL_OUTBOX.schema && t.name === SIGNAL_OUTBOX.name
        )
      ).toEqual(CATALOG_OUTBOX_TABLE)
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
const OWNER = PROVIDER_OWNER_ROLES[testProvider()]
const USER = PROVIDER_API_ROLES[testProvider()].user
const SERVICE = PROVIDER_API_ROLES[testProvider()].service

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

/**
 * `USAGE` схеми `app` кожному отримувачу гранту в ній: сервісна роль
 * (є лише на Supabase) отримує `EXECUTE` функцій множини видів скоупу.
 */
const schemaUsage = [COMMAND, USER, ...(SERVICE === null ? [] : [SERVICE])].map(
  (role) => `grant:grant:schema:app:${role}:usage`
)

/**
 * Межа тенанта виду `org` після прийому з нуля й повернення виду (Р8):
 * дослівні політики скоупу кореня `organization` (без вставки — ключ кореня
 * і є значенням скоупу) і кожної таблиці `tables`, а в скоуплених довідниках
 * `catalogs` — вставка носія `org_id` роллю команд.
 */
const orgScope = (tables: string[], catalogs: string[] = []) => [
  ...["delete", "read", "update"].map(
    (command) => `policy:app.organization.organization_scope_${command}`
  ),
  ...tables.flatMap((table) =>
    ["delete", "insert", "read", "update"].map(
      (command) => `policy:app.${table}.${table}_scope_${command}`
    )
  ),
  ...catalogs.map(
    (table) => `grant:grant:table:app.${table}:${COMMAND}:insert(org_id)`
  ),
]

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
    scope: orgScope(["item", "partner"], ["item", "partner"]),
    schemaUsage,
  },
  "document with two tabular sections, number_period and required check": {
    access: [
      ...catalogGrants("item"),
      ...catalogGrants("organization"),
      ...["sale", "sale_goods", "sale_services"].flatMap(readGrants),
    ],
    scope: orgScope(["item", "sale", "sale_goods", "sale_services"], ["item"]),
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
      scope: orgScope(
        [
          "item",
          "sale",
          "sale_goods",
          "sales",
          "sales_turnovers_month",
          "stock",
          "stock_totals",
          "stock_turnovers_month",
        ],
        ["item"]
      ),
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
      scope: orgScope(["item", "prices", "rates", "sale"], ["item"]),
      schemaUsage,
    },
  "scoped and global constants": {
    access: [
      ...catalogGrants("item"),
      ...catalogGrants("organization"),
      ...["main_item", "vat_rate"].flatMap(readGrants),
    ],
    scope: orgScope(["item", "main_item"], ["item"]),
    schemaUsage,
  },
  "custom table with composite key, FK to auth.users, partial expression index, generated column, deferrable unique":
    {
      access: [...catalogGrants("organization"), ...catalogGrants("partner")],
      scope: orgScope(["partner"], ["partner"]),
      schemaUsage,
    },
  "enumeration reference with check and pg enum column": {
    access: [
      ...catalogGrants("item", ["color"]),
      ...catalogGrants("organization"),
    ],
    scope: orgScope(["item"], ["item"]),
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
    scope: orgScope(
      [
        "item",
        "sale",
        "sale_goods",
        "stock",
        "stock_totals",
        "stock_turnovers_month",
      ],
      ["item"]
    ),
    schemaUsage,
  },
  // Функція політики й її викликачі — уже дослівний борг джерела, а її
  // `EXECUTE` — форма платформи. Понад джерело тека має лише коментар схеми
  // `public` з пресета Supabase: таблиці фікстури стоять у `public`, тож
  // схема в межі прийому
  "a policy function of debt called by a verbatim policy": {
    presetComment: ["comment:schema:public"],
  },
}

const POLICY_FUNCTION_FIXTURE =
  "a policy function of debt called by a verbatim policy"

/**
 * Фікстура корпусу з функцією політики (спека декларацій функцій §5.8):
 * функцію множини без параметрів кличе дослівна політика `SELECT` прийнятої
 * таблиці, і вона проходить форму — зворотна генерація не пише їй ні
 * декларації, ні дослівного гранту, а `EXECUTE` виводить платформа. Форма
 * існує лише на `supabase`: актор — `auth.uid()`. На `postgres` актор —
 * лише `simetra.current_user_id()`, яку дає шар «Користувачів», а прийом з
 * нуля бази зі схемою `simetra` не визначений (спека користувачів §12);
 * сирий вираз над `current_setting` — `actorUnbound`.
 */
const POLICY_FUNCTION_FIXTURES: [
  string,
  (provider: ReturnType<typeof testProvider>) => Map<string, string>,
][] =
  testProvider() === "supabase"
    ? [
        [
          POLICY_FUNCTION_FIXTURE,
          () =>
            policyFiles(
              POLICY_FUNCTION() + READ_POLICY() + DOCS_GRANT(),
              POLICY_DEBT()
            ),
        ],
      ]
    : []

/**
 * Прийом з нуля корпусу фікстур розгортання з їхніми видами скоупу (Р8):
 * функції множини видів після прийому — відмови класу ремонту, які лагодить
 * `restoreScopeKinds`; далі повний ланцюжок §9 до порожнього плану, втрата —
 * лише родини з еталоном (`mechanicsLoss`), а тека дослівних одиниць — рівно
 * одиниці застосунку фікстури плюс `FOLDER_UNITS` (И8).
 */
export function describeAdoptionFromScratch(): void {
  describe("adoption from scratch: the deployment fixture corpus survives the round trip", () => {
    for (const [name, fixture] of [...FIXTURES, ...POLICY_FUNCTION_FIXTURES]) {
      it(name, async () => {
        const { source, result } = await deployedRoundTrip(
          fixture(testProvider()),
          new Map(),
          true,
          restoreScopeKinds
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
        if (name === POLICY_FUNCTION_FIXTURE) {
          // Функція політики після прийому — знову форма: без декларації й
          // дослівних грантів `EXECUTE`, а виведений грант ціль і тінь мають
          // однаковий — роль політики-викликача
          expect(
            [...result!.files.keys()].filter((path) =>
              path.endsWith(".functions.json")
            )
          ).toEqual([])
          expect(
            verbatim
              .filter(
                (u) =>
                  u.class === "grant" &&
                  u.identity.includes("function:public.f()")
              )
              .map((u) => u.identity)
          ).toEqual([])
          expect(
            model.sqlUnits
              .filter(
                (u) =>
                  u.generator === "functionExecute" &&
                  u.sql.startsWith("GRANT ")
              )
              .map((u) => u.sql)
          ).toEqual([`GRANT EXECUTE ON FUNCTION public.f() TO ${USER};`])
          for (const shape of [result!.target, result!.shadow])
            expect(
              shape.acls
                .find((a) => a.object === "f:public.f()")
                ?.acl.map((item) => item.split("=")[0])
                .filter((role) => role !== "" && role !== OWNER)
                .sort()
            ).toEqual([USER])
        }
      })
    }
  })
}
