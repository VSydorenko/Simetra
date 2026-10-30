import { describe, expect, it } from "vitest"
import {
  compile,
  promoteObject,
  promotionRecordHash,
  type PromoteInput,
} from "simetra/compiler"
import {
  buildPlan,
  SUPABASE_EXPECTED_BLIND_FUNCTIONS,
  type PlanArtifact,
  type SchemaEngine,
} from "simetra/schema"
import {
  acceptDebt,
  catalog,
  CATALOG_FILE,
  CONTACT_FILE,
  COUNTERPARTY_FILE,
  COUNTERPARTY_ID,
  uuid,
} from "../../../../simetra/test/support"
import { query } from "../../__tests__/support/db"
import {
  BLIND_SETUP,
  codes,
  contactsMapping,
  contactsProject,
  dbs,
  EMPTY,
  engine,
  errors,
  establish,
  inTarget,
  Json,
  OLD,
  OWNER,
  params,
  planned,
  planPromotion,
  promoted,
  Promoted,
  readerWithoutPlpgsqlCheck,
  stepMatching,
  STRANGER,
  useBuildPlanRoles,
  WRITERS,
} from "./build-plan.support"

/**
 * Конвеєр плану `buildPlan` на справжній базі — план промоції. Спільна
 * підготовка — `build-plan.support.ts`; конвеєр розділено на файли, щоб шарди
 * DB-джоби CI були рівними (один файл займав понад половину джоби).
 */

useBuildPlanRoles()

// Конкурентно: ціль і копії кожного тесту — власні бази, ролі створює лише
// `beforeAll`, а лічильники двигунів-шпигунів — локальні для тесту
describe.concurrent("buildPlan", () => {
  describe("promotion", () => {
    it("plans a promotion with intent steps first and proves it on a copy", async () => {
      const p = await promoted()
      const outcome = await planPromotion(p)
      const artifact = planned(outcome)

      // Кроки наміру — першими: таблиця, колонки, потім канонічні імена
      const intent = artifact.steps.filter((s) => s.origin === "intent")
      expect(artifact.steps.slice(0, intent.length)).toEqual(intent)
      expect(intent.map((s) => s.sql)).toEqual([
        "ALTER TABLE app.counterparties RENAME TO counterparty",
        "ALTER TABLE app.counterparty RENAME COLUMN created_at TO simetra_retired_1",
        "ALTER TABLE app.counterparty RENAME COLUMN name TO description",
        "ALTER TABLE app.counterparty RENAME COLUMN inn TO tax_id",
        "ALTER TABLE app.counterparty RENAME COLUMN is_deleted TO archived",
        "ALTER TABLE app.counterparty_contacts RENAME COLUMN counterparty_id TO parent_id",
        "ALTER TABLE app.counterparty RENAME CONSTRAINT counterparties_pkey TO counterparty_pkey",
        "ALTER TABLE app.counterparty RENAME CONSTRAINT counterparties_inn_key TO counterparty_tax_id_key",
        "ALTER TABLE app.counterparty_contacts RENAME CONSTRAINT counterparty_contacts_counterparty_id_fkey TO counterparty_contacts_parent_id_fkey",
      ])
      // Нумерація наскрізна: кроки двигуна йдуть за кроками наміру
      expect(artifact.steps.map((s) => s.id)).toEqual(
        artifact.steps.map((_, i) => `s${i + 1}`)
      )
      // PK і FK ТЧ — перейменування, а не DROP/ADD; таблиці не перестворено
      const engine = artifact.steps.filter((s) => s.origin === "engine")
      expect(
        engine.filter((s) =>
          /pkey|parent_id_fkey|DROP TABLE|CREATE TABLE/.test(s.sql)
        )
      ).toEqual([])
      expect(stepMatching(artifact, /DROP COLUMN/).map((s) => s.sql)).toEqual([
        'ALTER TABLE "app"."counterparty" DROP COLUMN "simetra_retired_1"',
      ])

      // Дослівно перенесені коментарі знімаються з бази з класом `metadata`
      // від `promote` (спека промоції §8), а не відмовою
      expect(
        p.record.conversions
          .filter((c) => c.subject.includes("#comment"))
          .map((c) => [c.subject, c.class])
      ).toEqual([
        ["Counterparty#comment", "metadata"],
        ["Counterparty#comment/inn", "metadata"],
      ])
      const comments = stepMatching(artifact, /^COMMENT ON/)
      expect(comments.map((s) => s.sql)).toEqual([
        'COMMENT ON COLUMN "app"."counterparty"."tax_id" IS NULL',
        'COMMENT ON TABLE "app"."counterparty" IS NULL',
      ])

      const section = artifact.promotion!
      expect(section.conversions).toEqual(
        expect.arrayContaining(
          comments.map((s) => ({ step: s.id, class: "metadata" }))
        )
      )
      expect(section.recordHash).toBe(await promotionRecordHash(p.record))
      expect(section.record).toEqual(p.record)
      const counterparty = { schema: "app", name: "counterparty" }
      const contacts = { schema: "app", name: "counterparty_contacts" }
      expect(section.columns).toEqual([
        { table: counterparty, from: "created_at", to: "simetra_retired_1" },
        { table: counterparty, from: "name", to: "description" },
        { table: counterparty, from: "inn", to: "tax_id" },
        { table: counterparty, from: "is_deleted", to: "archived" },
        { table: contacts, from: "counterparty_id", to: "parent_id" },
      ])
      expect(section.canonicalNames).toEqual([
        {
          kind: "constraint",
          table: counterparty,
          from: "counterparties_pkey",
          to: "counterparty_pkey",
        },
        {
          kind: "constraint",
          table: counterparty,
          from: "counterparties_inn_key",
          to: "counterparty_tax_id_key",
        },
        {
          kind: "constraint",
          table: contacts,
          from: "counterparty_contacts_counterparty_id_fkey",
          to: "counterparty_contacts_parent_id_fkey",
        },
      ])
      // Кожна таблиця запису — один замір; колонка зі зміною типу несе крок
      expect(
        section.preservation.map((t) => [t.before.table, t.after.table])
      ).toEqual(p.record.tables.map((t) => [t.from, t.to]))
      const retype = stepMatching(artifact, /ALTER COLUMN "description" TYPE/)
      expect(retype).toHaveLength(1)
      expect(p.record.typeChanges.map((t) => t.column)).toEqual(["description"])
      expect(
        section.preservation
          .flatMap((t) => t.columns)
          .filter((c) => c.typeChangeStep !== undefined)
      ).toEqual([
        {
          before: "(name::character varying(150))",
          after: "description",
          typeChangeStep: retype[0]!.id,
        },
      ])
      // `access:app.counterparty` — згенерований грант читання таблиці виду
      expect(section.permissionItems.map((i) => i.token)).toEqual([
        "access:app.counterparty",
        "access:app.counterparty_contacts",
        "remove:app.counterparty",
      ])
      expect(artifact.requiredPermissions.slice(0, 3)).toEqual([
        "access:app.counterparty",
        "access:app.counterparty_contacts",
        "remove:app.counterparty",
      ])
      // Блокування — у старих іменах, до кроку наміру
      expect(artifact.locks).toEqual([
        { schema: "app", name: "counterparties", mode: "accessExclusive" },
        {
          schema: "app",
          name: "counterparty_contacts",
          mode: "accessExclusive",
        },
      ])
      // План промоції не попереджає про відмову `COMMIT`
      expect(
        outcome.diagnostics
          .filter((d) => d.severity === "warning")
          .map((d) => d.code)
      ).toEqual(["plan.schema-only-proof"])
      expect(errors(outcome)).toEqual([])
    })

    it("does not lock a foreign key target when the promotion only renames the FK column", async () => {
      const files = contactsProject()
      files.set(
        "catalogs/Region/Region.meta.json",
        JSON.stringify(catalog("Region", { id: uuid(7301) }))
      )
      const party = JSON.parse(files.get(COUNTERPARTY_FILE)!) as Json
      ;(party.columns as Json[]).push({
        id: uuid(7007),
        name: "regionId",
        physicalName: "region_id",
        type: "UUID",
      })
      party.foreignKeys = [
        {
          name: "counterparties_region_id_fkey",
          columns: ["regionId"],
          references: {
            object: { kind: "Catalog", name: "Region" },
            key: "ref",
          },
        },
      ]
      files.set(COUNTERPARTY_FILE, JSON.stringify(party))
      const mapping = contactsMapping()
      mapping.columns.regionId = {
        to: "attribute",
        collection: "attributes",
        element: { name: "area" },
      }
      const p = await promoted(files, mapping)
      const outcome = await planPromotion(p)
      const artifact = planned(outcome)
      const region = p.after.physical.tables.find(
        (t) => t.origin.objectId === uuid(7301)
      )!
      // Перейменування колонки FK і самого FK займає лише власну таблицю
      // (спека промоції §7.2): ціль FK не блокується ні явно, ні неявно
      expect(
        stepMatching(artifact, /RENAME COLUMN region_id TO area_id$/)
      ).toHaveLength(1)
      expect(
        stepMatching(
          artifact,
          /RENAME CONSTRAINT counterparties_region_id_fkey/
        )
      ).toHaveLength(1)
      expect(
        [...artifact.locks, ...artifact.implicitLocks].filter(
          (l) => l.name === region.name
        )
      ).toEqual([])
      // Звірка сліду на доказі: зайвого замка немає
      expect(outcome.diagnostics.map((d) => d.code)).not.toContain(
        "apply.lock-footprint-exceeded"
      )
    })

    it("refuses a dropped comment that the record does not classify", async () => {
      // Запис без класу перенесеного коментаря (зіпсований чи записаний
      // до появи цього класу, спека промоції §8): зникнення коментаря нічим не покрите — відмова, а не мовчки
      const p = await promoted()
      const record = {
        ...p.record,
        conversions: p.record.conversions.filter(
          (c) => !c.subject.includes("#comment")
        ),
      }
      const outcome = await planPromotion(p, {
        records: [{ ...p.input, record }],
      })
      expect(outcome.status).toBe("refused")
      expect(errors(outcome)).toEqual(["plan.removal-unclassified"])
      expect(params(outcome, "plan.removal-unclassified")).toEqual([
        {
          paths:
            "tables.app.counterparties.comment, tables.app.counterparties.columns.inn.comment",
        },
      ])
    })

    it.each([
      ["with", "", "lockable"],
      [
        "without",
        `ALTER TABLE storage.objects OWNER TO ${STRANGER}`,
        "implicit",
      ],
    ])(
      "plans a foreign key target outside the scope %s a lock privilege",
      async (_, drift, expected) => {
        // Вилучена колонка з FK на `storage.objects`: зняття FK бере ACCESS
        // EXCLUSIVE на ціль, а явний замок — лише з правом на LOCK (спека промоції §7.2)
        const files = contactsProject()
        const party = JSON.parse(files.get(COUNTERPARTY_FILE)!) as Json
        ;(party.columns as Json[]).push({
          id: uuid(7008),
          name: "objectId",
          physicalName: "object_id",
          type: "UUID",
        })
        party.foreignKeys = [
          {
            name: "counterparties_object_id_fkey",
            columns: ["objectId"],
            references: {
              external: {
                schema: "storage",
                table: "objects",
                columns: ["id"],
              },
            },
          },
        ]
        files.set(COUNTERPARTY_FILE, JSON.stringify(party))
        const mapping = contactsMapping()
        mapping.columns.objectId = { to: "retire" }
        const p = await promoted(files, mapping)
        const outcome = await planPromotion(p, {
          ...(drift === "" ? {} : { drift, superuser: true }),
        })
        const artifact = planned(outcome)
        const objects = {
          schema: "storage",
          name: "objects",
          mode: "accessExclusive",
        }
        const locked = artifact.locks.filter((l) => l.schema === "storage")
        const dropFk = stepMatching(
          artifact,
          /DROP CONSTRAINT "counterparties_object_id_fkey"/
        )[0]!
        if (expected === "lockable") {
          expect(locked).toEqual([objects])
          expect(artifact.implicitLocks).toEqual([])
        } else {
          expect(locked).toEqual([])
          expect(artifact.implicitLocks).toEqual([
            { ...objects, step: dropFk.id },
          ])
        }
        // Читання таблиці провайдера блоковані на всю транзакцію
        expect(params(outcome, "plan.foreign-exclusive-lock")).toEqual([
          { table: "storage.objects", step: dropFk.id },
        ])
        expect(outcome.diagnostics.map((d) => d.code)).not.toContain(
          "apply.lock-footprint-exceeded"
        )
      }
    )

    it("refuses a plan whose SQL function body is broken", async () => {
      // Тінь вантажить тіла без перевірки, і крок функції під преамбулою
      // двигуна теж: тіло читає колонку за старим ім'ям, і доказ на копії
      // падає на ревалідації тіл (спека промоції §7.2)
      const p = await promoted()
      const files = await acceptDebt(
        new Map([
          ...p.afterFiles,
          [
            "sql/app/broken.sql",
            "CREATE FUNCTION app.party_inns() RETURNS bigint LANGUAGE sql STABLE AS $fn$ SELECT count(inn) FROM app.counterparty $fn$;\n",
          ],
        ])
      )
      const result = await compile(files)
      expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual(
        []
      )
      const outcome = await planPromotion({ ...p, after: result.model! })
      expect(outcome.status).toBe("refused")
      expect(params(outcome, "apply.function-check-failed")).toEqual([
        {
          count: 1,
          functions: expect.stringMatching(/^app\.party_inns\(\): 42703 /),
        },
      ])
    })

    describe("reserved temporary names", () => {
      // Намір перейменовує через simetra_tmp_<n> і
      // simetra_retired_<n>, тож зайняте таке ім'я — відмова плану, а не
      // сирий 42701/42P07 кроку наміру на копії
      it.each([
        [
          "a column of a unit table",
          `alter table ${OLD} add column simetra_tmp_1 int`,
          "column app.counterparties.simetra_tmp_1",
        ],
        // Саме це ім'я намір дає вилученій колонці created_at: без перевірки
        // крок наміру на копії впав би з 42701
        [
          "a column holding the very name the intent needs",
          `alter table ${OLD} add column simetra_retired_1 int`,
          "column app.counterparties.simetra_retired_1",
        ],
        [
          "a neighbour table in the unit schema",
          "create table app.simetra_tmp_1 (id int)",
          "relation app.simetra_tmp_1",
        ],
        [
          "a type in the unit schema",
          "create type app.simetra_retired_2 as enum ('a')",
          "type app.simetra_retired_2",
        ],
        [
          "a constraint of a unit table",
          `alter table ${OLD} add constraint simetra_tmp_3 check (true)`,
          "constraint app.counterparties.simetra_tmp_3",
        ],
      ])("refuses %s named like a temporary name", async (_, drift, name) => {
        const outcome = await planPromotion(await promoted(), { drift })
        expect(outcome.status).toBe("refused")
        const [taken] = params(outcome, "plan.temp-name-taken")
        expect(String(taken?.names).split(", ")).toContain(name)
        expect(codes(outcome)).not.toContain("apply.step-failed")
      })
    })

    it("refuses a promotion on a target without plpgsql_check", async () => {
      const outcome = await planPromotion(await promoted(), {
        reader: readerWithoutPlpgsqlCheck,
      })
      expect(outcome.status).toBe("refused")
      expect(
        outcome.diagnostics.filter(
          (d) => d.code === "plan.plpgsql-check-unavailable"
        )
      ).toMatchObject([{ severity: "error", params: { on: "target" } }])
    })

    it("plans a promotion with plpgsql_check and the blind warning", async () => {
      const outcome = await planPromotion(await promoted(), {
        drift: BLIND_SETUP,
        superuser: true,
      })
      expect(planned(outcome).plpgsqlCheck).toBe("transient")
      expect(outcome).toMatchObject({
        expectedBlindFunctions: SUPABASE_EXPECTED_BLIND_FUNCTIONS.length,
      })
      expect(params(outcome, "apply.function-check-blind")).toEqual([
        { count: 2, functions: "other.fh(), pgbouncer.other_auth(text)" },
      ])
    })

    it("compares owners of the renamed tables through the intent", async () => {
      // Тінь називає таблицю новим іменем, ціль — старим: без перекладу
      // через намір чужий власник прийнятої таблиці пройшов би непоміченим
      const outcome = await planPromotion(await promoted(), {
        drift: `GRANT CREATE ON SCHEMA app TO ${OWNER};
          ALTER TABLE ${OLD} OWNER TO ${OWNER}`,
      })
      expect(outcome.status).toBe("refused")
      expect(errors(outcome)).toEqual(["plan.owner-mismatch"])
      expect(params(outcome, "plan.owner-mismatch")[0]?.objects).toMatch(
        new RegExp(
          `^relation app\\.counterparties \\(owner ${OWNER}, expected `
        )
      )
    })

    it("collects environment steps after the intent and engine steps of a promotion", async () => {
      // Спека промоції §7.2: копія збору проходить і кроки наміру, тож
      // залишок двигуна — у нових іменах, а доказ засіяний тим самим переліком
      const p = await promoted()
      const outcome = await planPromotion(p, {
        drift:
          "alter default privileges for role postgres grant select on tables to anon",
      })
      const artifact = planned(outcome)
      expect(
        artifact.environment.defaultPrivileges.filter(
          (d) => d.grantee === "anon"
        )
      ).toEqual([
        {
          objtype: "r",
          grantee: "anon",
          privilege: "SELECT",
          grantable: false,
        },
      ])
      const origins = artifact.steps.map((s) => s.origin)
      // Походження йдуть блоками: намір, двигун, копії носіїв, середовище
      const order = ["intent", "engine", "carriers", "environment"]
      expect(origins).toEqual(
        [...origins].sort((a, b) => order.indexOf(a) - order.indexOf(b))
      )
      expect(artifact.steps.map((s) => s.id)).toEqual(
        artifact.steps.map((_, i) => `s${i + 1}`)
      )
      // Класу конверсії біля кроку середовища немає
      const environment = new Set(
        artifact.steps
          .filter((s) => s.origin === "environment")
          .map((s) => s.id)
      )
      expect(
        artifact.promotion!.conversions.filter((c) => environment.has(c.step))
      ).toEqual([])
    })

    it("refuses a transition when no record is passed", async () => {
      const p = await promoted()
      const outcome = await planPromotion(p, { records: [] })
      expect(outcome.status).toBe("refused")
      expect(errors(outcome)).toEqual(["plan.promotion-record-missing"])
    })

    it("refuses a promotion when an API role can write the adopted table", async () => {
      const outcome = await planPromotion(await promoted(), {
        drift: `GRANT INSERT ON ${OLD} TO authenticated`,
      })
      expect(outcome.status).toBe("refused")
      expect(errors(outcome)).toEqual(["plan.write-path"])
      expect(params(outcome, "plan.write-path")).toEqual([
        {
          // Лише таблиця зі знахідкою: контакти на запис закриті
          table: "app.counterparties",
          detail: "grant INSERT to authenticated on app.counterparties",
        },
      ])
    })

    it("refuses default privileges granted to a role an API role is a member of", async () => {
      const outcome = await planPromotion(await promoted(), {
        drift: `ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT INSERT ON TABLES TO ${WRITERS}`,
      })
      expect(outcome.status).toBe("refused")
      expect(errors(outcome)).toEqual(["plan.write-path"])
      expect(params(outcome, "plan.write-path")).toEqual([
        {
          // Схемні типові привілеї стосуються всіх таблиць одиниці схеми
          table: "app.counterparties, app.counterparty_contacts",
          detail: expect.stringMatching(
            new RegExp(`in schema app grant INSERT to ${WRITERS}$`)
          ),
        },
      ])
    })

    it.each([
      [
        "a column-level write grant",
        `GRANT UPDATE (name) ON ${OLD} TO authenticated`,
        "column grant UPDATE to authenticated on app.counterparties",
      ],
      [
        "schema default privileges",
        "ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT INSERT ON TABLES TO anon",
        "in schema app grant INSERT to anon",
      ],
      [
        "global default privileges of the applying role",
        "ALTER DEFAULT PRIVILEGES GRANT INSERT ON TABLES TO authenticated",
        "grant INSERT to authenticated",
      ],
      [
        "an insert policy",
        `CREATE POLICY p ON ${OLD} FOR INSERT TO authenticated WITH CHECK (true)`,
        "policy app.counterparties.p (INSERT)",
      ],
      [
        "a grant to PUBLIC",
        `GRANT DELETE ON ${OLD} TO PUBLIC`,
        "grant DELETE to anon on app.counterparties",
      ],
      [
        "TRUNCATE",
        `GRANT TRUNCATE ON ${OLD} TO service_role`,
        "grant TRUNCATE to service_role on app.counterparties",
      ],
    ])("refuses through %s", async (_, drift, detail) => {
      const outcome = await planPromotion(await promoted(), { drift })
      expect(outcome.status).toBe("refused")
      expect(errors(outcome)).toEqual(["plan.write-path"])
      expect(params(outcome, "plan.write-path")[0]?.detail).toContain(detail)
    })

    it.each([
      [
        // `OWNED BY` і `SET SCHEMA` таку пару не дають (послідовність мусить
        // бути в схемі таблиці), але каталог її не забороняє: залежність
        // вписано прямо, як її лишив би інший шлях
        "OWNED BY",
        `CREATE SCHEMA seq; CREATE SEQUENCE seq.party_numbers;
         INSERT INTO pg_catalog.pg_depend
           (classid, objid, objsubid, refclassid, refobjid, refobjsubid, deptype)
         SELECT 'pg_class'::regclass, 'seq.party_numbers'::regclass, 0,
           'pg_class'::regclass, a.attrelid, a.attnum, 'a'
         FROM pg_catalog.pg_attribute a
         WHERE a.attrelid = '${OLD}'::regclass AND a.attname = 'inn'`,
        true,
      ],
      [
        "DEFAULT nextval",
        `CREATE SCHEMA seq; CREATE SEQUENCE seq.party_numbers;
         ALTER TABLE ${OLD} ALTER COLUMN inn SET DEFAULT nextval('seq.party_numbers')::text`,
        false,
      ],
    ])(
      "refuses a sequence outside the unit schema through %s",
      async (_, drift, superuser) => {
        const outcome = await planPromotion(await promoted(), {
          drift,
          superuser,
        })
        expect(outcome.status).toBe("refused")
        expect(errors(outcome)).toEqual(["plan.promotion-unsupported"])
        expect(params(outcome, "plan.promotion-unsupported")).toEqual([
          {
            objectId: COUNTERPARTY_ID,
            file: `plans/${COUNTERPARTY_ID}.promotion.json`,
            reason: "sequenceSchema",
            table: "app.counterparties",
            column: "inn",
            sequence: "seq.party_numbers",
          },
        ])
      }
    )

    it("plans a sequence in the unit schema without the refusal", async () => {
      // Та сама послідовність у схемі таблиці — справа канонічних імен і
      // класів видалень, а не відмови виявлення
      const outcome = await planPromotion(await promoted(), {
        drift:
          "CREATE SEQUENCE app.party_numbers OWNED BY app.counterparties.inn",
      })
      expect(
        params(outcome, "plan.promotion-unsupported").map((d) => d.reason)
      ).not.toContain("sequenceSchema")
      expect(outcome.status).toBe("planned")
    })

    it("refuses an engine step that drops a renamed column", async () => {
      // Двигун, що бачить інший стан, ніж оголошено: після наміру він ще й
      // знімає перейменовану колонку — її дані пропали б мовчки
      const dropsRenamed: SchemaEngine = {
        ...engine,
        plan: (from, to, scope, o) => {
          const enginePlan = engine.plan(from, to, scope, o)
          const retired = enginePlan.actions.find((a) =>
            /DROP COLUMN "simetra_retired_1"/.test(a.sql)
          )
          if (retired === undefined) return enginePlan
          const renamed = (text: string) =>
            text.replace("simetra_retired_1", "tax_id")
          return {
            ...enginePlan,
            actions: [
              ...enginePlan.actions,
              {
                ...retired,
                sql: renamed(retired.sql),
                destroys: retired.destroys.map(renamed),
                destroyed: retired.destroyed.map((d) =>
                  d.kind === "column" ? { ...d, name: "tax_id" } : d
                ),
              },
            ],
          }
        },
      }
      const outcome = await planPromotion(await promoted(), {
        engine: dropsRenamed,
      })
      expect(outcome.status).toBe("refused")
      expect(errors(outcome)).toEqual(["plan.rename-not-realized"])
      expect(params(outcome, "plan.rename-not-realized")).toEqual([
        { objects: "app.counterparty.tax_id" },
      ])
    })

    it("keeps a same-name redefinition of an adopted index a relaxation", async () => {
      // Прийнятий частковий унікальний індекс у бажаному стані стає повним
      // під тим самим ім'ям: для прийнятого об'єкта це не заміна, а зняття
      // унікальності з дозволом і класом із запису (спека промоції §8)
      const INDEX = "counterparties_inn_active"
      const files = contactsProject()
      const party = JSON.parse(files.get(COUNTERPARTY_FILE)!) as Json
      party.indexes = [
        {
          name: INDEX,
          unique: true,
          keys: [{ column: "inn" }],
          where: "(inn IS NOT NULL)",
        },
      ]
      files.set(COUNTERPARTY_FILE, JSON.stringify(party))
      const mapping = contactsMapping()
      mapping.conversions[`Counterparty#indexes/${INDEX}`] = "rowRule"
      const p = await promoted(files, mapping)
      // Вид такого індексу не описує, тож повний індекс додає бажаній тіні
      // обгортка двигуна
      const fullIndex: SchemaEngine = {
        ...engine,
        withDesiredShadow: (o, sql, scope, fn) =>
          engine.withDesiredShadow(
            o,
            `${sql}\nCREATE UNIQUE INDEX ${INDEX} ON app.counterparty (tax_id);`,
            scope,
            fn
          ),
      }
      const outcome = await planPromotion(p, { engine: fullIndex })
      const artifact = planned(outcome)
      const [drop] = stepMatching(artifact, new RegExp(`DROP INDEX .*${INDEX}`))
      expect(
        stepMatching(artifact, new RegExp(`CREATE UNIQUE INDEX ${INDEX}`))
      ).toHaveLength(1)
      expect(drop?.class).toBe("relaxation")
      expect(artifact.requiredPermissions).toContain(drop!.id)
      expect(artifact.promotion!.conversions).toContainEqual({
        step: drop!.id,
        class: "rowRule",
      })
    })

    describe("class platform", () => {
      const INDEX = "counterparties_inn_idx"

      /** Прийнятий звичайний індекс (типово `inn`) з класом `platform`. */
      async function platformIndex(
        columns: readonly string[] = ["inn"]
      ): Promise<Promoted> {
        const files = contactsProject()
        const party = JSON.parse(files.get(COUNTERPARTY_FILE)!) as Json
        party.indexes = [
          { name: INDEX, keys: columns.map((column) => ({ column })) },
        ]
        files.set(COUNTERPARTY_FILE, JSON.stringify(party))
        const mapping = contactsMapping()
        mapping.conversions[`Counterparty#indexes/${INDEX}`] = "platform"
        return promoted(files, mapping)
      }

      it("refuses an adopted index of the class platform that the kind does not reproduce", async () => {
        // Вид такого індексу не дає, а `UNIQUE (tax_id)` виду його не покриває:
        // `(inn, id)` не префікс ключа. Клас `platform` без заміни був би
        // тихим зникненням індексу
        const outcome = await planPromotion(await platformIndex(["inn", "id"]))
        expect(outcome.status).toBe("refused")
        expect(errors(outcome)).toEqual(["plan.platform-replacement-missing"])
        expect(params(outcome, "plan.platform-replacement-missing")).toEqual([
          {
            objects: `Counterparty#indexes/${INDEX} (index app.counterparties.${INDEX})`,
          },
        ])
      })

      it("plans an adopted index of the class platform that a key of the kind covers", async () => {
        // Спека промоції §8: простий індекс `(inn)` покриває
        // `UNIQUE (tax_id)` реквізиту — той самий пошук, тож заміна є, а
        // індекс знімає двигун
        const outcome = await planPromotion(await platformIndex())
        const artifact = planned(outcome)
        const drops = stepMatching(
          artifact,
          new RegExp(`DROP INDEX .*${INDEX}`)
        )
        expect(drops).toHaveLength(1)
        expect(artifact.promotion!.conversions).toContainEqual({
          step: drops[0]!.id,
          class: "platform",
        })
      })

      it("plans an adopted index of the class platform that the desired state reproduces", async () => {
        // Еквівалентний індекс на тій самій таблиці бажаної тіні — заміна є;
        // його додає обгортка двигуна, бо вид такого індексу поки не описує
        const reproduced: SchemaEngine = {
          ...engine,
          withDesiredShadow: (o, sql, scope, fn) =>
            engine.withDesiredShadow(
              o,
              `${sql}\nCREATE INDEX counterparty_tax_id_idx ON app.counterparty (tax_id);`,
              scope,
              fn
            ),
        }
        const outcome = await planPromotion(await platformIndex(), {
          engine: reproduced,
        })
        const artifact = planned(outcome)
        expect(artifact.promotion!.canonicalNames).toContainEqual({
          kind: "index",
          table: { schema: "app", name: "counterparty" },
          from: INDEX,
          to: "counterparty_tax_id_idx",
        })
      })
    })

    describe("adopted access equal to the schema ADP (decision 10)", () => {
      // Пара гранту, рівна ADP схеми, на копії не видна, і форма `grant` її не
      // перевіряє. Втрату справжнього доступу показує інше місце плану: запис
      // ролей API — гейт шляху запису (Пр21), читання — рядок політики
      const MODULE = "custom-tables/Counterparty/Counterparty.sql"

      /** Модуль прийнятої таблиці з `sql` і класами його одиниць. */
      function withModule(
        sql: string,
        conversions: Record<string, PromoteInput["conversions"][string]>
      ): Promise<Promoted> {
        const files = contactsProject()
        files.set(MODULE, sql)
        // Одиниці модуля — прийнятий борг, як у фікстури з модулем
        files.set(
          "sql-debt.json",
          `${JSON.stringify({ units: Object.keys(conversions).sort() }, null, 2)}\n`
        )
        const mapping = contactsMapping()
        Object.assign(mapping.conversions, conversions)
        return promoted(files, mapping)
      }

      it("refuses an ADP-equal GRANT ALL to the user role through the write-path gate", async () => {
        // Статичний гейт Пр21 бачить запис у тексті прийнятої одиниці ще в
        // `promote`, незалежно від того, чи рівна вона ADP цілі
        const files = contactsProject()
        files.set(MODULE, `GRANT ALL ON TABLE ${OLD} TO authenticated;\n`)
        const identity =
          "grant:grant:table:app.counterparties:authenticated:all"
        files.set(
          "sql-debt.json",
          `${JSON.stringify({ units: [identity] }, null, 2)}\n`
        )
        const mapping = contactsMapping()
        mapping.conversions[identity] = "platform"
        let n = 950_000
        const result = await promoteObject(files, mapping, {
          schemaPath: (file, schemaFile) => `schemas-of/${file}/${schemaFile}`,
          newId: () => uuid(++n),
        })
        expect(
          result.diagnostics
            .filter((d) => d.severity === "error")
            .map((d) => d.code)
        ).toEqual(["promote.write-path"])

        // Той самий грант на цілі, рівний ADP схеми (витяг його не показує),
        // ловить гейт шляху запису наживо
        const outcome = await planPromotion(await promoted(), {
          drift: `ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT ALL ON TABLES TO authenticated;
                  GRANT ALL ON ${OLD} TO authenticated`,
        })
        expect(outcome.status).toBe("refused")
        expect(errors(outcome)).toEqual(["plan.write-path"])
        expect(params(outcome, "plan.write-path")[0]?.detail).toContain(
          "grant INSERT to authenticated on app.counterparties"
        )
      })

      it("refuses an adopted read policy for anon that the kind does not replace", async () => {
        // `anon` читав таблицю грантом з ADP і політикою; вид без `publicRead`
        // гостю нічого не дає — відмова називає політику
        const p = await withModule(
          `CREATE POLICY counterparties_anon ON ${OLD} FOR SELECT TO anon USING (true);\n`,
          { "policy:app.counterparties.counterparties_anon": "platform" }
        )
        const outcome = await planPromotion(p, {
          drift: `ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT SELECT ON TABLES TO anon;
                  GRANT SELECT ON ${OLD} TO anon;
                  GRANT SELECT ON app.counterparty_contacts TO anon`,
        })
        expect(outcome.status).toBe("refused")
        expect(errors(outcome)).toEqual(["plan.platform-replacement-missing"])
        expect(params(outcome, "plan.platform-replacement-missing")).toEqual([
          {
            objects:
              "policy:app.counterparties.counterparties_anon (policy app.counterparties.counterparties_anon)",
          },
        ])
      })

      it("shows the drop of an adopted read policy for public with the class removed", async () => {
        const p = await withModule(
          `CREATE POLICY counterparties_all ON ${OLD} FOR SELECT TO public USING (true);\n`,
          { "policy:app.counterparties.counterparties_all": "removed" }
        )
        const outcome = await planPromotion(p, {
          drift: `ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT SELECT ON TABLES TO anon;
                  GRANT SELECT ON ${OLD} TO anon;
                  GRANT SELECT ON app.counterparty_contacts TO anon`,
        })
        const artifact = planned(outcome)
        const drops = stepMatching(artifact, /DROP POLICY .*counterparties_all/)
        expect(drops).toHaveLength(1)
        expect(artifact.requiredPermissions).toContain(drops[0]!.id)
      })
    })

    describe("service role (promotion spec §8)", () => {
      // Вид сервісній ролі нічого не дає: її доступ промоція забирає й
      // показує окремо. Права запису зупиняє раніше гейт шляху запису
      const LOST =
        "server code on the service key loses access; the server reaches kind data through platform commands (P4)"

      const serviceLines = (artifact: PlanArtifact) =>
        artifact
          .promotion!.permissionItems.map((i) => ({
            token: i.token,
            summary: i.summary.filter((l) => l.startsWith("service role ")),
          }))
          .filter((i) => i.summary.length > 0)

      it("warns about the read access the service role loses and lists it under access:", async () => {
        // Права з ADP схеми без запису: таблиця має рівний ADP грант, витяг
        // його не показує, тож одиниці гранту немає
        const outcome = await planPromotion(await promoted(), {
          drift: `ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT SELECT ON TABLES TO service_role;
                  GRANT SELECT ON ${OLD} TO service_role;
                  GRANT SELECT ON app.counterparty_contacts TO service_role`,
        })
        const artifact = planned(outcome)
        // Таблиці — у старих іменах: так їх знає серверний код
        expect(params(outcome, "plan.service-role-access-lost")).toEqual([
          { tables: "app.counterparties, app.counterparty_contacts" },
        ])
        expect(
          outcome.diagnostics.find(
            (d) => d.code === "plan.service-role-access-lost"
          )?.severity
        ).toBe("warning")
        expect(serviceLines(artifact)).toEqual([
          {
            token: "access:app.counterparty",
            summary: [`service role service_role loses SELECT: ${LOST}`],
          },
          {
            token: "access:app.counterparty_contacts",
            summary: [`service role service_role loses SELECT: ${LOST}`],
          },
        ])
      })

      it("does not warn when the service role has no privileges on the tables", async () => {
        const outcome = await planPromotion(await promoted())
        const artifact = planned(outcome)
        expect(codes(outcome)).not.toContain("plan.service-role-access-lost")
        expect(serviceLines(artifact)).toEqual([])
      })

      it("warns about a column-level read grant of the service role", async () => {
        // Явний прийнятий грант сервісній ролі — клас `removed` (§8)
        const files = contactsProject()
        const identity =
          "grant:grant:table:app.counterparties:service_role:select(name)"
        files.set(
          "custom-tables/Counterparty/Counterparty.sql",
          `GRANT SELECT (name) ON TABLE ${OLD} TO service_role;\n`
        )
        files.set(
          "sql-debt.json",
          `${JSON.stringify({ units: [identity] }, null, 2)}\n`
        )
        const mapping = contactsMapping()
        mapping.conversions[identity] = "removed"
        const outcome = await planPromotion(await promoted(files, mapping))
        const artifact = planned(outcome)
        expect(params(outcome, "plan.service-role-access-lost")).toEqual([
          { tables: "app.counterparties" },
        ])
        expect(serviceLines(artifact)).toEqual([
          {
            token: "access:app.counterparty",
            summary: [
              `service role service_role loses SELECT (columns): ${LOST}`,
            ],
          },
        ])
      })

      it("refuses through the write-path gate first when the ADP gives the service role ALL", async () => {
        const outcome = await planPromotion(await promoted(), {
          drift: `ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT ALL ON TABLES TO service_role;
                  GRANT ALL ON ${OLD} TO service_role;
                  GRANT ALL ON app.counterparty_contacts TO service_role`,
        })
        expect(outcome.status).toBe("refused")
        expect(errors(outcome)).toEqual(["plan.write-path"])
        expect(params(outcome, "plan.write-path")[0]?.detail).toContain(
          "grant INSERT to service_role on app.counterparties"
        )
        expect(codes(outcome)).not.toContain("plan.service-role-access-lost")
      })

      it("warns about a table in public whose service role access comes only from the schema ADP", async () => {
        // Спека промоції §8: прийнятий грант, рівний ADP схеми,
        // проходить промоцію без рядка класу лише тому, що втрату видно тут
        const files = contactsProject()
        for (const file of [COUNTERPARTY_FILE, CONTACT_FILE]) {
          const raw = JSON.parse(files.get(file)!) as Json
          raw.schema = "public"
          files.set(file, JSON.stringify(raw))
        }
        const p = await promoted(files)
        const outcome = await planPromotion(p, {
          drift: `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO service_role;
                  GRANT SELECT ON public.counterparties TO service_role;
                  GRANT SELECT ON public.counterparty_contacts TO service_role`,
        })
        const artifact = planned(outcome)
        expect(params(outcome, "plan.service-role-access-lost")).toEqual([
          { tables: "public.counterparties, public.counterparty_contacts" },
        ])
        expect(serviceLines(artifact)).toEqual([
          {
            token: "access:public.counterparty",
            summary: [`service role service_role loses SELECT: ${LOST}`],
          },
          {
            token: "access:public.counterparty_contacts",
            summary: [`service role service_role loses SELECT: ${LOST}`],
          },
        ])
      })
    })

    describe("class property", () => {
      /** Предмет UNIQUE `inn` фікстури має клас `property` (мапінг-зразок). */
      const SUBJECT = "Counterparty#uniques/counterparties_inn_key"
      const OBJECT = "constraint app.counterparties.counterparties_inn_key"

      it("refuses a deferred unique of the class property that the kind recreates immediate", async () => {
        // Запис, написаний до гейта мутації: ціль має відкладений UNIQUE, а
        // вид дає негайний — клас запису сам нічого не доводить
        const outcome = await planPromotion(await promoted(), {
          drift: `ALTER TABLE ${OLD} DROP CONSTRAINT counterparties_inn_key,
            ADD CONSTRAINT counterparties_inn_key UNIQUE (inn)
              DEFERRABLE INITIALLY DEFERRED`,
        })
        expect(outcome.status).toBe("refused")
        expect(errors(outcome)).toEqual(["plan.property-not-reproduced"])
        expect(params(outcome, "plan.property-not-reproduced")).toEqual([
          {
            subject: SUBJECT,
            object: OBJECT,
            detail: "deferrable: initiallyDeferred → no",
          },
        ])
      })

      it("refuses a unique of the class property that metadata dropped after promote", async () => {
        // Пізніша зміна метаданих зняла `unique` реквізиту, а запис лишив клас
        const p = await promoted()
        const files = new Map(p.afterFiles)
        const raw = JSON.parse(files.get(CATALOG_FILE)!) as Json
        for (const a of raw.attributes as Json[]) delete a.unique
        files.set(CATALOG_FILE, JSON.stringify(raw))
        const changed = await compile(files)
        expect(
          changed.diagnostics.filter((d) => d.severity === "error")
        ).toEqual([])
        const outcome = await planPromotion({ ...p, after: changed.model! })
        expect(outcome.status).toBe("refused")
        expect(errors(outcome)).toEqual(["plan.property-not-reproduced"])
        expect(params(outcome, "plan.property-not-reproduced")).toEqual([
          {
            subject: SUBJECT,
            object: OBJECT,
            detail: "no element of this kind on the table in the desired state",
          },
        ])
      })

      it("plans a unique of the class property whose column changes type", async () => {
        // Двигун законно перебудовує залежний UNIQUE при зміні типу колонки
        // (§7.2): умова гейта — еквівалент у тіні, а не відсутність DROP
        const mapping = contactsMapping()
        mapping.columns.inn = {
          to: "attribute",
          collection: "attributes",
          element: { name: "taxId", type: "String", length: 12, unique: true },
        }
        const p = await promoted(contactsProject(), mapping)
        expect(p.record.typeChanges.map((t) => t.column)).toContain("tax_id")
        const artifact = planned(await planPromotion(p))
        expect(
          stepMatching(artifact, /ALTER COLUMN "tax_id" TYPE/)
        ).toHaveLength(1)
      })
    })

    it("refuses a record without a marker when the old table is live", async () => {
      // Рядок 8 через конвеєр: стара таблиця на цілі, а marker немає
      const p = await promoted()
      const outcome = await inTarget(
        `create schema app; create table ${OLD} (id uuid primary key);`,
        (url) => buildPlan(engine, dbs, p.after, { target: { url } }, [p.input])
      )
      expect(outcome.status).toBe("refused")
      expect(errors(outcome)).toEqual(["plan.promotion-needs-marker"])
      expect(params(outcome, "plan.promotion-needs-marker")).toEqual([
        {
          objectId: COUNTERPARTY_ID,
          file: p.input.file,
          table: OLD,
        },
      ])
    })

    it("ignores a record the ledger has already applied", async () => {
      // Рядок 5 через конвеєр: хеш запису — у ledger цілі
      const p = await promoted()
      const hash = await promotionRecordHash(p.record)
      const outcome = await inTarget(EMPTY, async (url) => {
        await establish(url, p.after)
        // Застосування з COMMIT у 2a відмовляє, тож рядок пише тест
        await query(
          url,
          `update simetra.ledger set promotion = jsonb_build_object('hash', '${hash}')`
        )
        return buildPlan(engine, dbs, p.after, { target: { url } }, [p.input])
      })
      expect(outcome.status).toBe("unchanged")
      expect(
        outcome.diagnostics
          .filter((d) => d.code.startsWith("plan.promotion-"))
          .map((d) => [d.code, d.severity])
      ).toEqual([["plan.promotion-applied", "warning"]])
    })

    it("plans unchanged files without a promotion as P3-1 did", async () => {
      const p = await promoted()
      // Свіжа ціль: перехід не виявлено, запис — не для неї (рядок 9)
      const [without, withRecord] = await inTarget(EMPTY, async (url) => [
        await buildPlan(engine, dbs, p.before, { target: { url } }, []),
        await buildPlan(engine, dbs, p.before, { target: { url } }, [p.input]),
      ])
      const a = planned(without!)
      const b = planned(withRecord!)
      expect(a.promotion).toBeNull()
      expect(b.promotion).toBeNull()
      expect(b.steps).toEqual(a.steps)
      expect(b.planHash).toBe(a.planHash)
      expect(codes(withRecord!)).toContain("plan.promotion-not-applicable")
    })
  })
})
