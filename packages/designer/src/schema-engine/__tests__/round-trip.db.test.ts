import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import { reverseGenerate } from "simetra/schema"
import { PROVIDER_OWNER_ROLES } from "simetra/model"
import {
  FIXTURES,
  readReferenceDomain,
  superuserClient,
  testProvider,
  testRoleFor,
  testRoleName,
} from "../../../../simetra/test/support"
import { dropRoles } from "../../__tests__/support/db"
import type { OracleShape } from "./fixtures/round-trip-classes"
import {
  deployedRoundTrip,
  engine,
  errors,
  extractDiagnostics,
  inTarget,
  kindsOf,
  parser,
  portableClassFixtures,
  roundTripOf,
  schemaPath,
  scopeOf,
  tableKeys,
  useRoundTrip,
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
      await inTarget(fixture.sql, scope, async (target) => {
        // Схема за замовчуванням — завжди в межі (§6.9), тож це перша
        // керована схема фікстури, а не вшита `app`
        const result = await roundTripOf(target, scope, {
          defaultSchema: fixture.schemas[0]!,
          attributeCase: "snake_case",
          databaseProvider: testProvider(),
        })
        // Властивість класу є в цілі (фікстура її створила) і в тіні
        expect(fixture.property(result.target)).toEqual(fixture.expected)
        expect(fixture.property(result.shadow)).toEqual(fixture.expected)
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
  it("builtin PUBLIC execute beside a schema ADP writes no PUBLIC unit", async () => {
    const scope = scopeOf(["app"])
    await inTarget(
      `CREATE SCHEMA app;
       ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT EXECUTE ON FUNCTIONS TO ${ANON};
       CREATE FUNCTION app.open() RETURNS int LANGUAGE sql AS $$ select 1 $$;`,
      scope,
      async (target) => {
        const result = await roundTripOf(target, scope, roundTripOptions)
        expect(
          result.extracted.model.units.filter((u) => /\bPUBLIC\b/i.test(u.sql))
        ).toEqual([])
        const acl = publicAcl("f:app.open()")
        expect(acl(result.target)).toEqual([`=X/${OWNER}`])
        expect(acl(result.shadow)).toEqual([`=X/${OWNER}`])
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

  it("a schema ADP that grants to PUBLIC is kept as a unit", async () => {
    const scope = scopeOf(["app"])
    await inTarget(
      `CREATE SCHEMA app;
       CREATE TABLE app.note (id uuid PRIMARY KEY);
       ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT SELECT ON TABLES TO PUBLIC;`,
      scope,
      async (target) => {
        const result = await roundTripOf(target, scope, roundTripOptions)
        expect(
          result.extracted.model.units
            .filter((u) => u.class === "defaultPrivileges")
            .map((u) => u.sql)
        ).toEqual([expect.stringMatching(/GRANT SELECT ON TABLES TO PUBLIC/i)])
        expect(result.shadow.defaultAcls).toEqual(result.target.defaultAcls)
        expect(result.target.defaultAcls).not.toEqual([])
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

describe("adoption from scratch: the deployment fixture corpus survives the round trip", () => {
  for (const [name, fixture] of FIXTURES) {
    it(name, async () => {
      const { source, result } = await deployedRoundTrip(
        fixture(testProvider()),
        new Map(),
        true
      )
      // Види 1С повертаються як `CustomTable` з тими самими фізичними іменами
      expect(tableKeys(result.model)).toEqual(tableKeys(source))
      expect(
        kindsOf(result.model).filter(
          (kind) => kind !== "CustomTable" && kind !== "PgEnum"
        )
      ).toEqual([])
    })
  }
})

// Референсний домен має довідник «Користувачі», тож база несе платформний
// шар у схемі `simetra`. Прийом такої бази з нуля не визначений (спека
// користувачів §12): свіжий introspect розклав би `simetra` у метадані
// застосунку, а схема зарезервована. Тому домен проходить round-trip поверх
// власної теки: шар і види 1С описані в ній, генератор їх не дублює.
describe("over existing metadata: the reference domain survives the round trip", () => {
  it("reference domain", async () => {
    const files = readReferenceDomain(testProvider())
    const { source, result } = await deployedRoundTrip(files, files, false)
    // Види 1С і платформний шар лишаються описаними власною текою
    expect(tableKeys(result.model)).toEqual(tableKeys(source))
    expect(kindsOf(result.model)).toEqual(kindsOf(source))
    expect(result.model.sqlUnits.map((u) => u.identity).sort()).toEqual(
      source.sqlUnits.map((u) => u.identity).sort()
    )
  })
})

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
