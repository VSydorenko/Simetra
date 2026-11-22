import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import { addElement, addElementInput, applyChanges } from "simetra/compiler"
import { reverseGenerate } from "simetra/schema"
import { PROVIDER_OWNER_ROLES } from "simetra/model"
import {
  movementQuery,
  superuserClient,
  testProvider,
  testRoleFor,
  testRoleName,
} from "../../../../simetra/test/support"
import { dropRoles } from "../../__tests__/support/db"
import type { OracleShape } from "./fixtures/round-trip-classes"
import {
  describeAdoptionFromScratch,
  describeModelPathInvariants,
} from "./platform-content.support"
import {
  applicationTableKeys,
  deployedRoundTrip,
  engine,
  errors,
  extractDiagnostics,
  classProperty,
  inTarget,
  parser,
  portableClassFixtures,
  refusedAdoption,
  roundTripOf,
  schemaPath,
  scopeOf,
  kindsOfFiles,
  tableKeysOfFiles,
  useRoundTrip,
  describeReferenceDomain,
} from "./round-trip.support"

/**
 * Повний round-trip (спека П2 §9): ціль — тінь із SQL
 * фікстури → extract → зворотна генерація в порожню теку → компіляція →
 * рендер → звірка з тінню рендера. Порожньої звірки замало:
 * незалежний читач `pg_catalog` мусить бачити властивість класу і в цілі, і
 * в тіні, тож однакова втрата з обох боків extract-у не пройде. Спільна
 * підготовка — `round-trip.support.ts`; класи пресета Supabase й тип
 * розширення стеку — `round-trip.supabase.db.test.ts`.
 */

useRoundTrip()

/** Ролі профілю в SQL фікстур: власник (грантор ACL) і анонімна роль API. */
const OWNER = PROVIDER_OWNER_ROLES[testProvider()]
const ANON = testRoleFor("anonymous")

/** Один оператор від суперкористувача стека (клієнт закривається одразу). */
async function asStack(sql: string): Promise<void> {
  const client = await superuserClient()
  try {
    await client.query(sql)
  } finally {
    await client.end()
  }
}

describe("class fixtures survive the round trip", () => {
  for (const fixture of portableClassFixtures()) {
    it(fixture.name, async () => {
      const scope = scopeOf(fixture.schemas)
      // Схема за замовчуванням — завжди в межі (§6.9), тож це перша
      // керована схема фікстури, а не вшита `app`
      const project = {
        defaultSchema: fixture.schemas[0]!,
        attributeCase: "snake_case" as const,
        databaseProvider: testProvider(),
      }
      await inTarget(fixture.sql, scope, async (target) => {
        if (fixture.refused !== undefined) {
          const refused = await refusedAdoption(
            target,
            scope,
            project,
            fixture.refused
          )
          expect(await classProperty(fixture, refused.target)).toEqual(
            fixture.expected
          )
          return
        }
        const result = await roundTripOf(target, scope, project)
        // Властивість класу є в цілі (фікстура її створила) і в тіні
        expect(await classProperty(fixture, result.target)).toEqual(
          fixture.expected
        )
        expect(await classProperty(fixture, result.shadow)).toEqual(
          fixture.expected
        )
        expect(result.shadow).toEqual(result.target)
      })
    })
  }
})

describe("the builtin PUBLIC privilege beside a schema ADP", () => {
  const roundTripOptions = {
    defaultSchema: "app",
    attributeCase: "snake_case" as const,
    databaseProvider: testProvider(),
  }
  const publicAcl = (object: string) => (shape: OracleShape) =>
    shape.acls
      .find((a) => a.object === object)
      ?.acl.filter((item) => item.startsWith("="))

  // Маркер двигуна для рядка ADP схеми не означає відкликання: вбудований
  // `EXECUTE`/`USAGE` для `PUBLIC` не має ставати ні `GRANT`, ні `REVOKE`,
  // ні одиницею ADP
  // `GRANT EXECUTE ON FUNCTIONS` у ADP схеми застосунку прийом відмовляє
  // (Р15 спеки декларацій функцій): тіні немає, тож витяг і ціль звіряються
  // без неї, а відмова — рівно одна, на одиниці ADP
  it("builtin PUBLIC execute beside a schema ADP writes no PUBLIC unit", async () => {
    const scope = scopeOf(["app"])
    await inTarget(
      `CREATE SCHEMA app;
       ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT EXECUTE ON FUNCTIONS TO ${ANON};
       CREATE FUNCTION app.open() RETURNS int LANGUAGE sql AS $$ select 1 $$;`,
      scope,
      async (target) => {
        const {
          extracted,
          files,
          diagnostics,
          target: shape,
        } = await refusedAdoption(target, scope, roundTripOptions, [
          {
            code: "sql.default-privileges-execute",
            schema: "app",
            name: `defaultPrivileges:${OWNER}:app:function:grant:${ANON}:execute`,
          },
        ])
        expect(
          extracted.model.units.filter((u) => /\bPUBLIC\b/i.test(u.sql))
        ).toEqual([])
        // Відмова — на файлі, де лежить сам ADP
        const [refusal] = errors(diagnostics)
        expect(files.get(refusal!.file)).toMatch(
          /ALTER DEFAULT PRIVILEGES[^;]*IN SCHEMA[^;]*GRANT EXECUTE ON FUNCTIONS/i
        )
        expect(publicAcl("f:app.open()")(shape)).toEqual([`=X/${OWNER}`])
      }
    )
  })

  it("builtin PUBLIC usage on a type beside a schema ADP writes no PUBLIC unit", async () => {
    const scope = scopeOf(["app"])
    await inTarget(
      `CREATE SCHEMA app;
       ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT USAGE ON TYPES TO ${ANON};
       CREATE TYPE app.mood AS ENUM ('ok', 'bad');`,
      scope,
      async (target) => {
        const result = await roundTripOf(target, scope, roundTripOptions)
        expect(
          result.extracted.model.units.filter((u) => /\bPUBLIC\b/i.test(u.sql))
        ).toEqual([])
        const acl = publicAcl("T:app.mood")
        expect(acl(result.target)).toEqual([`=U/${OWNER}`])
        expect(acl(result.shadow)).toEqual([`=U/${OWNER}`])
      }
    )
  })

  it("a schema ADP that grants to PUBLIC is read as a unit, and the compiler refuses it", async () => {
    // Р4 (б) спеки прав §6.1: ADP схеми називає лише ролі API, тож `PUBLIC`
    // відмовлено. Одиниця є у витягу й у теці зворотної генерації, а
    // відмова — рівно одна, кодована, на цій одиниці
    const scope = scopeOf(["app"])
    await inTarget(
      `CREATE SCHEMA app;
       CREATE TABLE app.note (id uuid PRIMARY KEY);
       ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT SELECT ON TABLES TO PUBLIC;`,
      scope,
      async (target) => {
        const identity = `defaultPrivileges:${OWNER}:app:table:grant:public:select`
        const { extracted, diagnostics } = await refusedAdoption(
          target,
          scope,
          roundTripOptions,
          [{ code: "sql.kind-table-verbatim", identity }]
        )
        const units = extracted.model.units.filter(
          (u) => u.class === "defaultPrivileges"
        )
        expect(
          units.map((u) => ({ identity: u.identity, sql: u.sql }))
        ).toEqual([{ identity, sql: expect.stringMatching(/TO PUBLIC/i) }])
        expect(errors(diagnostics).map((d) => d.params)).toEqual([
          {
            identity,
            table: "app.*",
            form: "defaultPrivileges",
            roles: "PUBLIC",
            line: expect.any(Number),
          },
        ])
      }
    )
  })
})

describe("a role of the application's own", () => {
  it("is assumed, and a grant to it survives the round trip", async () => {
    // Роль — інфраструктура кластера (спека §6.9): межа керує грантами на неї,
    // а не нею самою. Роль кластерна, тож видна й тіні поруч із ціллю;
    // прибирається в `finally`
    const role = testRoleName("round_trip_reader")
    // Роль кластерна: її створює суперкористувач стека, бо власник профілю
    // `CREATEROLE` не має
    await asStack(`CREATE ROLE ${role} NOLOGIN`)
    try {
      const scope = scopeOf(["app"])
      await inTarget(
        `CREATE SCHEMA app;
         CREATE TABLE app.report (id uuid PRIMARY KEY, body text);
         GRANT SELECT ON app.report TO ${role};`,
        scope,
        async (target) => {
          const result = await roundTripOf(target, scope, {
            defaultSchema: "app",
            attributeCase: "snake_case",
            databaseProvider: testProvider(),
          })
          expect(
            result.extracted.model.units
              .filter((u) => u.class === "grant")
              .map((u) => u.sql)
          ).toEqual([expect.stringContaining(role)])
          const granted = (shape: OracleShape) =>
            shape.acls
              .find((a) => a.object === "r:app.report")
              ?.acl.filter((item) => item.startsWith(`${role}=`))
          expect(granted(result.target)).toEqual([`${role}=r/${OWNER}`])
          expect(granted(result.shadow)).toEqual([`${role}=r/${OWNER}`])
        }
      )
    } finally {
      await dropRoles(role)
    }
  })
})

// Корпус прийому з нуля й інваріанти «платформне — за вмістом» — спільні з
// файлом профілю Supabase
describeAdoptionFromScratch()
describeModelPathInvariants()
describeReferenceDomain()

describe("adoption from scratch with named scope set functions", () => {
  // Після прийому `app.org_ids` кличуть дослівні політики кількох таблиць,
  // а її вивід — ключ кореня, не ключ таблиці політики: функцією політики
  // (§5.8) вона не стає, і прийом дає ще `sql.policy-helper-correlated`
  // (`outputKey`; відмови — у `deployedRoundTrip`). Теку прийому лагодять
  // дві мутації `add` (Р8), записані тут буквально, без виведення
  // `restoreScopeKinds` корпусу: вид скоупу `org` зі `scopes` — `app.org_ids`
  // стає формою платформи й губить декларацію (`toPlatformForms`), потім вид
  // `user` (`setFunction: user_ids`, зовнішній корінь фікстури; таблиць не
  // має, тож `scopes` не потрібні) — так само для `app.user_ids`. Після них
  // тека компілюється без помилок, а план проти бази порожній (Б5):
  // `deployedRoundTrip` веде ланцюжок і застосування.
  it("movement query with named scope set functions: adoption reaches an empty plan through the add of scope kinds org and user", async () => {
    const { source, result, adopted } = await deployedRoundTrip(
      movementQuery(testProvider()),
      new Map(),
      true,
      async (kept) => {
        // Корінь `Organization` — сама таблиця виду без носія; решта — з FK на нього
        const scopes: Record<string, { scope: string; scopeColumn?: string }> =
          { Organization: { scope: "org" } }
        for (const table of [
          "Item",
          "Sale",
          "SaleGoods",
          "Stock",
          "StockTotals",
          "StockTurnoversMonth",
        ]) {
          scopes[table] = { scope: "org", scopeColumn: "orgId" }
        }
        const org = await addElement(
          kept,
          addElementInput.parse({
            target: { kind: "Project" },
            collection: "scopeKinds",
            element: {
              name: "org",
              root: { object: { kind: "CustomTable", name: "Organization" } },
              setFunction: { name: "org_ids" },
            },
            scopes,
          }),
          { schemaPath, newId: () => randomUUID() }
        )
        // `app.org_ids` стала формою платформи й декларації не має; лишається
        // лише відмова класу ремонту для `app.user_ids` — її знімає наступний `add`
        expect(
          errors(org.diagnostics).map((d) => ({
            code: d.code,
            function: d.params?.function,
          }))
        ).toEqual([
          { code: "sql.declaration-check-missing", function: "app.user_ids" },
        ])
        expect(org.written).toBe(true)
        const withOrg = applyChanges(kept, org.changes)
        const user = await addElement(
          withOrg,
          addElementInput.parse({
            target: { kind: "Project" },
            collection: "scopeKinds",
            element: {
              name: "user",
              root: {
                external: { schema: "auth", table: "users", column: "id" },
              },
              setFunction: { name: "user_ids" },
            },
          }),
          { schemaPath, newId: () => randomUUID() }
        )
        expect(errors(user.diagnostics)).toEqual([])
        expect(user.ok).toBe(true)
        return applyChanges(withOrg, user.changes)
      }
    )
    // Таблиці платформної установки тека не описує — їх ставить платформа
    expect(tableKeysOfFiles(adopted!, source.project.defaultSchema)).toEqual(
      await applicationTableKeys(source)
    )
    expect(
      kindsOfFiles(adopted!).filter(
        (kind) => kind !== "CustomTable" && kind !== "PgEnum"
      )
    ).toEqual([])
    // Б5: звірка в `compiledTrip` дає рівно втрачену механіку таблиць виду
    // (відома втрата прийому з нуля), а функції множини й їхні гранти — форми
    // платформи, які план не чіпає: ні дослівних грантів, ні декларацій
    expect(
      result!.comparison.plan.actions.filter((a) =>
        /org_ids|user_ids/.test(a.sql)
      )
    ).toEqual([])
    expect(
      [...adopted!.keys()].filter((path) => path.endsWith(".functions.json"))
    ).toEqual([])
  })
})

// Референсний домен має довідник «Користувачі», тож база несе платформний
// шар у схемі `simetra`. Прийом такої бази з нуля не визначений (спека
// користувачів §12): свіжий introspect розклав би `simetra` у метадані
// застосунку, а схема зарезервована. Тому домен проходить round-trip поверх
// власної теки: шар і види 1С описані в ній, генератор їх не дублює.

describe("what the round trip cannot carry is loud", () => {
  it("an exclusion constraint is unrepresentable by name", async () => {
    const diagnostics = await extractDiagnostics(
      `CREATE SCHEMA app;
       CREATE TABLE app.booking (
         id uuid PRIMARY KEY,
         during tstzrange NOT NULL,
         CONSTRAINT booking_no_overlap EXCLUDE USING gist (during WITH &&)
       );`,
      ["app"]
    )
    // Модель каталогу не має поля для EXCLUDE, тож до генератора воно не
    // доходить: гучно його називає вже extract, і `introspect` не пише нічого
    const messages = diagnostics
      .filter((d) => d.code === "engine.unrepresentable")
      .map((d) => d.message)
    expect(messages).toEqual([
      expect.stringMatching(/booking_no_overlap.*exclusion/),
    ])
    expect(messages[0]).toContain("app.booking")
  })

  it("an owner other than the session role is unrepresentable by name", async () => {
    // Таблицю ролі провайдера (роль API) політика двигуна виключає, і
    // її ловить перепис; власника поза ролями провайдера двигун читає ребром
    // `owner`, якого модель не має. Роль кластерна — прибирається в `finally`
    const role = testRoleName("round_trip_owner")
    // Роль кластерна, а членство власника в ній видає суперкористувач стека:
    // власник профілю не має ні `CREATEROLE`, ні `ADMIN` на неї, а сам він
    // `NOINHERIT`, тож права ролі успадковує лише явне `INHERIT`
    await asStack(`CREATE ROLE ${role} NOLOGIN`)
    await asStack(`GRANT ${role} TO ${OWNER} WITH INHERIT TRUE, SET TRUE`)
    try {
      const diagnostics = await extractDiagnostics(
        `CREATE SCHEMA app;
         CREATE TABLE app.ledger (id uuid PRIMARY KEY);
         GRANT CREATE ON SCHEMA app TO ${role};
         ALTER TABLE app.ledger OWNER TO ${role};`,
        ["app"]
      )
      // Сама роль — припущена інфраструктура кластера, не помилка: гучна
      // лише таблиця з чужим власником
      expect(
        diagnostics
          .filter((d) => d.code === "engine.unrepresentable")
          .map((d) => d.message)
      ).toEqual([
        `table:app.ledger: property owner cannot be represented in the catalog model: owner role:${role} is not the default owner`,
      ])
    } finally {
      await dropRoles(role)
    }
  })

  it("a cast is an unmodeled class", async () => {
    const diagnostics = await extractDiagnostics(
      `CREATE SCHEMA app;
       CREATE TYPE app.pair AS (a int, b int);
       CREATE CAST (app.pair AS text) WITH INOUT;`,
      ["app"]
    )
    expect(
      diagnostics
        .filter((d) => d.code === "engine.unmodeled-class")
        .map((d) => d.message)
    ).toEqual([expect.stringMatching(/^1 object\(s\) of class cast /)])
  })
})

describe("function volatility is read under the extraction search_path", () => {
  // Ідентичність двигуна кваліфікує типи аргументів, бо витяг іде під
  // `search_path = pg_catalog`; факт волатильності під типовим шляхом сесії
  // дав би некваліфікований тип зі схеми на шляху, і функція мовчки лишилася б
  // без явної VOLATILE — тобто боргом закритої оболонки
  it.each([
    [
      "public",
      `CREATE TYPE public.mood AS ENUM ('ok', 'bad');
       CREATE FUNCTION app.rate(a public.mood) RETURNS integer
         LANGUAGE sql VOLATILE AS $$ SELECT 1 $$;`,
    ],
  ])(
    "a VOLATILE function over a type in %s gets explicit VOLATILE and is not debt",
    async (_schema, sql) => {
      const scope = scopeOf(["app", "public"])
      await inTarget(`CREATE SCHEMA app;\n${sql}`, scope, async (target) => {
        const extracted = await engine.extract(target, scope)
        expect(errors(extracted.diagnostics)).toEqual([])
        const unit = extracted.model.units.find(
          (u) => u.class === "function" && u.name === "rate"
        )
        expect(unit?.volatility).toBe("volatile")
        const reversed = await reverseGenerate(extracted.model, {
          project: {
            name: "RoundTrip",
            defaultSchema: "app",
            attributeCase: "snake_case",
            databaseProvider: testProvider(),
          },
          existing: new Map(),
          newId: () => randomUUID(),
          schemaPath,
          parse: parser(),
        })
        expect(errors(reversed.diagnostics)).toEqual([])
        const text = [...reversed.files].find(([path]) =>
          path.includes("/rate")
        )?.[1]
        expect(text).toMatch(/\bVOLATILE\b/)
        const debt = JSON.parse(
          reversed.files.get("sql-debt.json") ?? "{}"
        ) as { units?: string[] }
        expect(debt.units ?? []).not.toContain(unit!.identity)
      })
    }
  )
})
