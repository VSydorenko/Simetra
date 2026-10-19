import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import {
  compile,
  derivePromotionFacts,
  loadSqlParser,
  promoteInput,
  type PromoteInput,
  type PromotionRecord,
} from "simetra/compiler"
import {
  buildPlan,
  readDataFacts,
  reverseGenerate,
  tableKey,
  type ApplyDatabase,
  type PlanOutcome,
  type PlannedDataTable,
} from "simetra/schema"
import {
  acceptDebt,
  CONTACT_FILE,
  metaFiles,
  project,
  uuid,
} from "../../../../simetra/test/support"
import {
  contactsMapping,
  contactsProject,
  dbs,
  EMPTY,
  engine,
  errors,
  establish,
  inTarget,
  Json,
  params,
  planned,
  planPromotion,
  Promoted,
  promoted,
  stepMatching,
  targetScope,
  useBuildPlanRoles,
} from "./build-plan.support"

/**
 * Конвеєр плану `buildPlan` на справжній базі — кроки даних промоції. Спільна
 * підготовка — `build-plan.support.ts`; конвеєр розділено на файли, щоб шарди
 * DB-джоби CI були рівними (один файл займав понад половину джоби).
 */

useBuildPlanRoles()

// Конкурентно: ціль і копії кожного тесту — власні бази, ролі створює лише
// `beforeAll`, а лічильники двигунів-шпигунів — локальні для тесту
describe.concurrent("buildPlan", () => {
  describe("promotion", () => {
    describe("promotion data steps", () => {
      // Прийнята таблиця `app.items`: `inactive` виводиться з ужитку й стає
      // позначкою видалення кроком конверсії, `code` і `payload` лишаються
      // реквізитами (рішення 1–5, 12, 13 плану П3-2b-2)
      const ITEM_ID = uuid(7401)
      const ITEM_FILE = "custom-tables/Item/Item.meta.json"
      const CODE_T = "sql/app/code_t.sql"
      const NORM = "sql/app/norm.sql"
      const COLOR = "pg-enums/Color/Color.meta.json"
      const OTHER = "custom-tables/Other/Other.meta.json"
      const DELETION_MARK = {
        target: { to: "standard", name: "deletionMark" },
        expression: "coalesce(inactive, false)",
      } as const

      const item = (extra: Json[] = []) => ({
        id: ITEM_ID,
        kind: "CustomTable",
        name: "Item",
        physicalName: "items",
        kindLabel: "item",
        schema: "app",
        columns: [
          {
            id: uuid(7402),
            name: "id",
            physicalName: "id",
            type: "UUID",
            notNull: true,
          },
          { id: uuid(7403), name: "code", physicalName: "code", type: "Text" },
          {
            id: uuid(7404),
            name: "inactive",
            physicalName: "inactive",
            type: "Boolean",
          },
          {
            id: uuid(7405),
            name: "payload",
            physicalName: "payload",
            type: "Text",
          },
          ...extra,
        ],
        primaryKey: { name: "items_pkey", columns: ["id"] },
        uniques: [{ name: "items_code_key", columns: ["code"] }],
        rowLevelSecurity: "enabled",
      })

      /** Тека з таблицею й SQL-файлами `sql`; борг одиниць прийнято. */
      const itemFiles = (
        o: { sql?: Record<string, string>; extra?: Json[] } = {}
      ): Promise<Map<string, string>> =>
        acceptDebt(
          metaFiles({
            "project.meta.json": project(),
            [ITEM_FILE]: item(o.extra),
            ...o.sql,
          })
        )

      const itemMapping = (
        o: {
          fill?: PromoteInput["fill"]
          attributes?: Json[]
          columns?: Record<string, unknown>
          conversions?: Record<string, string>
        } = {}
      ): PromoteInput =>
        promoteInput.parse({
          target: { name: "Item" },
          into: {
            kind: "Catalog",
            name: "Item",
            data: {
              codeLength: 0,
              descriptionLength: 0,
              ...(o.attributes === undefined
                ? {}
                : { attributes: o.attributes }),
            },
          },
          columns: {
            id: { to: "standard", name: "ref" },
            code: { to: "attribute", element: { name: "code", unique: true } },
            inactive: { to: "retire" },
            payload: { to: "attribute", element: { name: "payload" } },
            ...o.columns,
          },
          fill: o.fill ?? [DELETION_MARK],
          conversions: {
            "Item#uniques/items_code_key": "property",
            ...o.conversions,
          },
        })

      const promotedItems = async (
        o: {
          sql?: Record<string, string>
          extra?: Json[]
          fill?: PromoteInput["fill"]
          attributes?: Json[]
          columns?: Record<string, unknown>
          conversions?: Record<string, string>
        } = {}
      ): Promise<Promoted> => promoted(await itemFiles(o), itemMapping(o))

      /** Відмови `plan.promotion-unsupported` з їхніми причинами. */
      const reasons = (outcome: PlanOutcome) =>
        params(outcome, "plan.promotion-unsupported").map((p) => p.reason)

      it("plans a conversion of a retired column into the deletion mark", async () => {
        // Тригер таблиці — модулем: секція бере перелік із цілі, а промоція
        // знімає його з класом `applicationCode`
        const p = await promotedItems({
          sql: {
            "sql/app/touch.sql":
              "CREATE FUNCTION app.touch() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN RETURN NEW; END $fn$;\n",
            "custom-tables/Item/Item.sql":
              "CREATE TRIGGER items_touch BEFORE UPDATE ON app.items FOR EACH ROW EXECUTE FUNCTION app.touch();\n",
          },
          conversions: { "trigger:app.items.items_touch": "applicationCode" },
        })
        expect(p.record.dataSteps.map((s) => [s.column, s.kind])).toEqual([
          ["deletion_mark", "conversion"],
        ])
        const outcome = await planPromotion(p)
        const artifact = planned(outcome)
        const section = artifact.promotion!
        expect(section.data).toEqual([
          {
            temp: "simetra_fill_1",
            before: { schema: "app", table: "items", key: "id" },
            after: { schema: "app", table: "item", key: "id" },
            columns: [
              {
                step: "d1",
                column: "deletion_mark",
                type: "boolean",
                expression: "coalesce(inactive, false)",
                kind: "conversion",
                guard:
                  "SELECT pg_catalog.count(*) AS lost FROM (SELECT (\ncoalesce(inactive, false)\n) AS x FROM app.items) AS s WHERE x IS NOT NULL AND (x::boolean) IS DISTINCT FROM x",
              },
            ],
            triggers: [{ name: "items_touch", enabled: "O" }],
          },
        ])
        // Колонка-ціль з'являється кроком наміру, без NOT NULL і DEFAULT
        expect(
          artifact.steps
            .filter((s) => s.origin === "intent")
            .map((s) => s.sql)
            .filter((sql) => sql.includes("ADD COLUMN"))
        ).toEqual(["ALTER TABLE app.item ADD COLUMN deletion_mark boolean"])
        // Конверсія наявних значень не змінює: пункту `repair:` немає
        expect(
          section.permissionItems.filter((i) => i.token.startsWith("repair:"))
        ).toEqual([])
        // Замір цілі — за виразом
        expect(
          section.preservation[0]!.columns.filter((c) => c.dataStep === "d1")
        ).toEqual([
          {
            before: "((\ncoalesce(inactive, false)\n)::boolean)",
            after: "deletion_mark",
            dataStep: "d1",
          },
        ])
        expect(errors(outcome)).toEqual([])
      })

      /** Модель після промоції з іншими файлами `files` поверх її тек. */
      const recompiled = async (
        p: Promoted,
        files: Record<string, string>
      ): Promise<Promoted> => {
        const afterFiles = await acceptDebt(
          new Map([...p.afterFiles, ...Object.entries(files)])
        )
        const result = await compile(afterFiles)
        expect(
          result.diagnostics.filter((d) => d.severity === "error")
        ).toEqual([])
        return { ...p, afterFiles, after: result.model! }
      }

      /**
       * Реквізит `label` бажаного стану — у типі `type` з одиниці `unit`.
       * Метадані виду доменів і власних типів не несуть (`Raw` промоція
       * відхиляє), тож тип підмінено в зібраній моделі, а одиницю типу
       * поставлено перед таблицями.
       */
      const withTypedLabel = (
        p: Promoted,
        type = "app.code_t",
        unit = "code_t",
        column = "label"
      ): Promoted => {
        const node = p.after.creationOrder.find(
          (n) =>
            (n.type === "unit" && n.identity.includes(unit)) ||
            (n.type === "enumType" && n.name === unit)
        )!
        return {
          ...p,
          after: {
            ...p.after,
            physical: {
              ...p.after.physical,
              tables: p.after.physical.tables.map((t) =>
                t.name !== "item"
                  ? t
                  : {
                      ...t,
                      columns: t.columns.map((c) =>
                        c.name === column ? { ...c, type } : c
                      ),
                    }
              ),
            },
            creationOrder: [
              node,
              ...p.after.creationOrder.filter((n) => n !== node),
            ],
          },
        }
      }

      const LABEL = [{ name: "label", type: "Text" }]
      const fillLabel = (expression: string): PromoteInput["fill"] => [
        DELETION_MARK,
        { target: { to: "attribute", name: "label" }, expression },
      ]

      it("refuses an inherited table", async () => {
        const outcome = await planPromotion(await promotedItems(), {
          drift:
            "create schema other; create table other.items_child () inherits (app.items);",
        })
        expect(outcome.status).toBe("refused")
        expect(reasons(outcome)).toEqual(["dataStepTable"])
        expect(params(outcome, "plan.promotion-unsupported")[0]).toMatchObject({
          step: "d1",
          table: "app.items",
        })
      })

      // Рішення В18: правило `UPDATE` — і `ALSO`, і `INSTEAD` — підмінило б
      // той `UPDATE`, чий лічильник звіряється з обчисленим
      it("refuses a table with an UPDATE rewrite rule", async () => {
        const outcome = await planPromotion(await promotedItems(), {
          drift:
            "create rule items_touch as on update to app.items do also notify items_touch;",
        })
        expect(outcome.status).toBe("refused")
        expect(reasons(outcome)).toEqual(["dataStepTable"])
        expect(params(outcome, "plan.promotion-unsupported")[0]).toMatchObject({
          step: "d1",
          table: "app.items",
          detail: "rule",
        })
      })

      const NORM_SQL = (body: string) =>
        `CREATE FUNCTION app.norm(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $fn$ SELECT ${body} $fn$;\n`

      it("refuses a model function the plan changes", async () => {
        const p = await promotedItems({
          sql: { [NORM]: NORM_SQL("lower(t)") },
          attributes: LABEL,
          fill: fillLabel("app.norm(code)"),
        })
        const outcome = await planPromotion(
          await recompiled(p, { [NORM]: NORM_SQL("upper(t)") })
        )
        expect(outcome.status).toBe("refused")
        // `CREATE OR REPLACE FUNCTION` — дія `alter`: предмет оператора з
        // дерева — сама функція (вердикт В7)
        expect(params(outcome, "plan.data-step-function-changed")).toEqual([
          {
            step: "d2",
            function: "app.norm",
            detail: "changed",
            by: expect.stringMatching(/^s\d+$/),
          },
        ])
      })

      it("refuses a model function that is not immutable on the target", async () => {
        const p = await promotedItems({
          sql: { [NORM]: NORM_SQL("lower(t)") },
          attributes: LABEL,
          fill: fillLabel("app.norm(code)"),
        })
        const outcome = await planPromotion(p, {
          drift: "alter function app.norm(text) stable;",
        })
        expect(outcome.status).toBe("refused")
        expect(params(outcome, "plan.data-step-volatile")).toEqual([
          { step: "d2", function: "app.norm" },
        ])
      })

      it("refuses without the TEMP privilege", async () => {
        // Власник бази має право окремо, тож лише `PUBLIC` не досить
        const outcome = await planPromotion(await promotedItems(), {
          superuser: true,
          drift: `do $$ begin execute format('revoke temp on database %I from public, postgres', current_database()); end $$;`,
        })
        expect(outcome.status).toBe("refused")
        expect(errors(outcome)).toEqual(["plan.temp-privilege"])
        expect(params(outcome, "plan.temp-privilege")).toEqual([
          { role: "postgres" },
        ])
      })

      it("refuses a session replication role other than origin", async () => {
        const outcome = await planPromotion(await promotedItems(), {
          superuser: true,
          drift: `do $$ begin execute format('alter database %I set session_replication_role = replica', current_database()); end $$;`,
        })
        expect(outcome.status).toBe("refused")
        expect(errors(outcome)).toEqual(["plan.replication-role"])
        expect(params(outcome, "plan.replication-role")).toEqual([
          { value: "replica" },
        ])
      })

      it("refuses a key that is a fill target", async () => {
        const p = await promotedItems()
        const record: PromotionRecord = {
          ...p.record,
          dataSteps: [
            ...p.record.dataSteps,
            {
              ...p.record.dataSteps[0]!,
              column: "id",
              expression:
                "coalesce(id, '00000000-0000-4000-8000-000000000000'::uuid)",
              kind: "backfill",
            },
          ],
        }
        const outcome = await planPromotion(p, {
          records: [{ ...p.input, record }],
        })
        expect(outcome.status).toBe("refused")
        expect(reasons(outcome)).toEqual(["dataStepKey", "dataStepKey"])
        expect(
          params(outcome, "plan.promotion-unsupported").map((x) => x.detail)
        ).toEqual(["fillTarget", "fillTarget"])
      })

      it("refuses a record whose data step kind was edited", async () => {
        // Ремонт, переписаний у файлі на конверсію, пройшов би без `repair:`
        const p = await promotedItems({
          fill: [
            DELETION_MARK,
            {
              target: { to: "attribute", name: "code" },
              expression: "btrim(code)",
            },
          ],
        })
        expect(p.record.dataSteps.map((s) => s.kind)).toEqual([
          "conversion",
          "repair",
        ])
        const record: PromotionRecord = {
          ...p.record,
          dataSteps: p.record.dataSteps.map((s) => ({
            ...s,
            kind: "conversion",
          })),
        }
        const outcome = await planPromotion(p, {
          records: [{ ...p.input, record }],
        })
        expect(outcome.status).toBe("refused")
        expect(params(outcome, "plan.promotion-record-mismatch")).toEqual([
          {
            objectId: ITEM_ID,
            file: p.input.file,
            detail: "dataSteps",
            step: "d2",
            reason: "derived repair, recorded conversion",
          },
        ])
      })

      it("asks repair: for a repair of existing values", async () => {
        const p = await promotedItems({
          fill: [
            DELETION_MARK,
            {
              target: { to: "attribute", name: "code" },
              expression: "btrim(code)",
            },
          ],
        })
        const artifact = planned(await planPromotion(p))
        expect(
          artifact.promotion!.permissionItems.filter((i) =>
            i.token.startsWith("repair:")
          )
        ).toEqual([
          { token: "repair:app.item", summary: ["code ← btrim(code)"] },
        ])
        expect(artifact.requiredPermissions).toContain("repair:app.item")
      })

      it("refuses a fill target referenced with ON UPDATE CASCADE", async () => {
        const p = await promotedItems({
          fill: [
            DELETION_MARK,
            {
              target: { to: "attribute", name: "code" },
              expression: "btrim(code)",
            },
          ],
        })
        const outcome = await planPromotion(p, {
          drift:
            "create schema other; create table other.refs (code text references app.items (code) on update cascade);",
        })
        expect(outcome.status).toBe("refused")
        expect(reasons(outcome)).toEqual(["dataStepReferenced"])
        expect(params(outcome, "plan.promotion-unsupported")[0]).toMatchObject({
          step: "d2",
          table: "app.items",
          column: "code",
        })
      })

      it("plans a backfill with now()", async () => {
        // Функції часу транзакції — поза перевіркою IMMUTABLE на цілі
        const p = await promotedItems({
          extra: [
            {
              id: uuid(7406),
              name: "createdAt",
              physicalName: "created_at",
              type: "DateTime",
            },
          ],
          columns: { createdAt: { to: "standard", name: "createdAt" } },
          fill: [
            DELETION_MARK,
            {
              target: { to: "standard", name: "createdAt" },
              expression: "coalesce(created_at, now())",
            },
          ],
        })
        const artifact = planned(await planPromotion(p))
        expect(
          artifact.promotion!.data[0]!.columns.map((c) => [
            c.column,
            c.kind,
            c.type,
          ])
        ).toEqual([
          ["deletion_mark", "conversion", "boolean"],
          ["created_at", "backfill", "timestamp with time zone"],
        ])
      })

      it("proves a windowed fill expression measured in a subquery", async () => {
        // Review focus 1: віконна функція в агрегаті заборонена, тож замір
        // «до» прогону-доказу рахує вираз у підзапиті
        const p = await promotedItems({
          attributes: [{ name: "position", type: "Integer" }],
          fill: [
            DELETION_MARK,
            {
              target: { to: "attribute", name: "position" },
              expression: "row_number() over (order by id)",
            },
          ],
        })
        const artifact = planned(await planPromotion(p))
        expect(
          artifact.promotion!.preservation[0]!.columns.find(
            (c) => c.dataStep === "d2"
          )
        ).toEqual({
          before: "((\nrow_number() over (order by id)\n)::integer)",
          // `position` — ключове слово, тож фізичне ім'я дістає `_`
          after: "position_",
          dataStep: "d2",
        })
      })

      it("takes SHARE ROW EXCLUSIVE for a table only a repair touches", async () => {
        // Вердикт (б): таблиця ТЧ уже має канонічні імена, тож ні намір, ні
        // двигун її не займають — слід дає лише крок даних
        const files = contactsProject()
        const raw = JSON.parse(files.get(CONTACT_FILE)!) as Json
        ;(raw.columns as Json[])[1]!.physicalName = "parent_id"
        ;(raw.foreignKeys as Json[])[0]!.name =
          "counterparty_contacts_parent_id_fkey"
        raw.rowLevelSecurity = "enabled"
        // Індекс ключа власника, який вид і так має, — під своїм іменем
        raw.indexes = [
          {
            name: "counterparty_contacts_parent_id_idx",
            keys: [{ column: "counterpartyId" }],
          },
        ]
        files.set(CONTACT_FILE, JSON.stringify(raw))
        const mapping = contactsMapping()
        mapping.conversions[
          "CounterpartyContact#indexes/counterparty_contacts_parent_id_idx"
        ] = "property"
        mapping.fill = [
          {
            table: "CounterpartyContact",
            target: { to: "attribute", name: "phone" },
            expression: "btrim(phone)",
          },
        ]
        const p = await promoted(files, mapping)
        const contacts = { schema: "app", name: "counterparty_contacts" }
        const artifact = planned(await planPromotion(p))
        const touching = artifact.steps.filter((s) =>
          s.lockedTables.some((t) => t.name === contacts.name)
        )
        // Гранти доступу таблиці виду — кроки двигуна без замка таблиці:
        // слід замків вони не змінюють
        expect(touching.map((s) => [s.origin, s.lockClass, s.sql])).toEqual([
          [
            "engine",
            "none",
            'REVOKE ALL ON TABLE "app"."counterparty_contacts" FROM "authenticated"',
          ],
          [
            "engine",
            "none",
            'GRANT SELECT ON TABLE "app"."counterparty_contacts" TO "authenticated"',
          ],
        ])
        expect(artifact.promotion!.data.map((t) => t.columns[0]!.step)).toEqual(
          ["d1"]
        )
        expect(artifact.locks).toContainEqual({
          ...contacts,
          mode: "shareRowExclusive",
        })
        // Без права на явний LOCK замок бере сам крок — і це крок даних
        const reader: ApplyDatabase = {
          transaction: (target, end, fn) =>
            dbs.reader.transaction(target, end, (tx) =>
              fn({
                ...tx,
                query: async <R extends Record<string, unknown>>(
                  sql: string,
                  params?: readonly unknown[]
                ): Promise<R[]> => {
                  const rows = await tx.query<R>(sql, params)
                  return sql.includes("AS lockable")
                    ? rows.map((r) =>
                        r.name === contacts.name ? { ...r, lockable: false } : r
                      )
                    : rows
                },
              })
            ),
        }
        const implicit = planned(await planPromotion(p, { reader }))
        expect(implicit.implicitLocks).toEqual([
          { ...contacts, mode: "shareRowExclusive", step: "d1" },
        ])
      })

      it("refuses a target type absent on the target before the copy", async () => {
        // Домен створює бажаний стан: без відмови до копії `ADD COLUMN`
        // наміру впав би на ній сирим 42704
        const p = await promotedItems({
          attributes: LABEL,
          fill: fillLabel("code"),
        })
        const desired = withTypedLabel(
          await recompiled(p, {
            [CODE_T]: "CREATE DOMAIN app.code_t AS text;\n",
          })
        )
        let clones = 0
        const outcome = await planPromotion(desired, {
          engine: {
            ...engine,
            withTargetClone: (o, target, scope, fn) => {
              clones++
              return engine.withTargetClone(o, target, scope, fn)
            },
          },
        })
        expect(outcome.status).toBe("refused")
        expect(reasons(outcome)).toEqual(["dataStepType"])
        expect(params(outcome, "plan.promotion-unsupported")[0]).toMatchObject({
          step: "d2",
          type: "app.code_t",
          detail: "missing",
        })
        expect(clones).toBe(0)
      })

      it("refuses a type an engine step changes", async () => {
        const domain = (check: string) =>
          `CREATE DOMAIN app.code_t AS text CONSTRAINT code_t_check CHECK (${check});\n`
        const p = await promotedItems({
          sql: { [CODE_T]: domain("VALUE <> ''") },
          attributes: LABEL,
          fill: fillLabel("code"),
        })
        const desired = withTypedLabel(
          await recompiled(p, { [CODE_T]: domain("length(VALUE) < 100") })
        )
        const outcome = await planPromotion(desired)
        expect(outcome.status).toBe("refused")
        expect(reasons(outcome)).toEqual(["dataStepType"])
        expect(params(outcome, "plan.promotion-unsupported")[0]).toMatchObject({
          step: "d2",
          type: "app.code_t",
          detail: "changed",
        })
      })

      it("refuses an enum value an engine step adds", async () => {
        // Вердикт архітектора (8): `ALTER TYPE … ADD VALUE` — предмет оператора
        // — сам енам кроку даних
        // Енам — прийнятий `PgEnum`: SQL-файл енамів не створює
        const enumOf = (values: string[]) =>
          JSON.stringify({
            id: uuid(7601),
            kind: "PgEnum",
            name: "Color",
            physicalName: "color",
            schema: "app",
            values,
          })
        const p = await promotedItems({
          sql: { [COLOR]: enumOf(["red"]) },
          attributes: LABEL,
          fill: fillLabel("'red'"),
        })
        const desired = withTypedLabel(
          await recompiled(p, { [COLOR]: enumOf(["red", "green"]) }),
          "app.color",
          "color"
        )
        const outcome = await planPromotion(desired)
        expect(outcome.status).toBe("refused")
        expect(reasons(outcome)).toEqual(["dataStepType"])
        expect(params(outcome, "plan.promotion-unsupported")[0]).toMatchObject({
          step: "d2",
          type: "app.color",
          detail: "changed",
        })
      })

      it("lets through a type change of another table to the step's domain", async () => {
        // Вердикт В7: `ALTER TABLE … ALTER COLUMN … TYPE <домен>` — теж `alter`
        // із доменом у `consumed`, але предмет оператора — таблиця
        const DOMAIN = "CREATE DOMAIN app.code_t AS text;\n"
        const other = (column: Json) =>
          JSON.stringify({
            id: uuid(7501),
            kind: "CustomTable",
            name: "Other",
            physicalName: "others",
            kindLabel: "other",
            schema: "app",
            columns: [
              {
                id: uuid(7502),
                name: "id",
                physicalName: "id",
                type: "UUID",
                notNull: true,
              },
              { id: uuid(7503), name: "c", physicalName: "c", ...column },
            ],
            primaryKey: { name: "others_pkey", columns: ["id"] },
            rowLevelSecurity: "enabled",
          })
        const p = await promotedItems({
          sql: { [CODE_T]: DOMAIN, [OTHER]: other({ type: "Text" }) },
          attributes: LABEL,
          fill: fillLabel("code"),
        })
        const desired = withTypedLabel(
          await recompiled(p, {
            [OTHER]: other({ type: "Raw", pgType: "app.code_t" }),
          })
        )
        const outcome = await planPromotion(desired)
        const artifact = planned(outcome)
        expect(
          stepMatching(artifact, /ALTER COLUMN "c" TYPE/).map((s) => s.verb)
        ).toEqual(["alter"])
        expect(artifact.promotion!.data[0]!.columns[1]!.type).toBe("app.code_t")
      })

      it("refuses a preservation type the same plan creates", async () => {
        // Вердикт (в): замір «до» приводить `code` до нового типу до будь-якого
        // кроку, а домен створює сам план — відмова плану, а не сирий 42704
        // заміру на застосуванні
        const p = await promotedItems()
        const desired = withTypedLabel(
          await recompiled(p, {
            [CODE_T]: "CREATE DOMAIN app.code_t AS text;\n",
          }),
          "app.code_t",
          "code_t",
          "code"
        )
        const record: PromotionRecord = {
          ...p.record,
          typeChanges: [
            {
              schema: "app",
              table: "item",
              column: "code",
              from: "text",
              to: "app.code_t",
            },
          ],
        }
        let clones = 0
        const outcome = await planPromotion(desired, {
          records: [{ ...p.input, record }],
          engine: {
            ...engine,
            withTargetClone: (o, target, scope, fn) => {
              clones++
              return engine.withTargetClone(o, target, scope, fn)
            },
          },
        })
        expect(outcome.status).toBe("refused")
        expect(errors(outcome)).toEqual(["plan.preservation-type"])
        expect(params(outcome, "plan.preservation-type")).toEqual([
          { column: "app.item.code", type: "app.code_t", detail: "missing" },
        ])
        expect(clones).toBe(0)
      })

      it("picks the text form of the cast guard when no operator exists", async () => {
        const guardOf = async (expression: string) => {
          const p = await promotedItems({
            attributes: [{ name: "data", type: "Json" }],
            fill: [
              DELETION_MARK,
              { target: { to: "attribute", name: "data" }, expression },
            ],
          })
          const artifact = planned(await planPromotion(p))
          return artifact.promotion!.data[0]!.columns[1]!
        }
        // `jsonb = text` немає: сторож порівнює текст
        const text = await guardOf("payload")
        expect(text.type).toBe("jsonb")
        expect(text.guard).toBe(
          "SELECT pg_catalog.count(*) AS lost FROM (SELECT (\npayload\n) AS x FROM app.items) AS s WHERE x IS NOT NULL AND (x::jsonb)::pg_catalog.text IS DISTINCT FROM x::pg_catalog.text"
        )
        // Явна конверсія: `jsonb` з `jsonb`
        const compare = await guardOf("payload::jsonb")
        expect(compare.guard).toBe(
          "SELECT pg_catalog.count(*) AS lost FROM (SELECT (\npayload::jsonb\n) AS x FROM app.items) AS s WHERE x IS NOT NULL AND (x::jsonb) IS DISTINCT FROM x"
        )
      })

      it("reads the data facts of the target", async () => {
        // Тригери користувача `O` і `A` за іменем, без вимкнених і внутрішніх
        // тригерів FK; партиціонована таблиця; вхідний FK із каскадом
        // оновлення на змаплену ціль; типи й функції в старому стані
        await inTarget(
          `create schema app;
           create table app.items (id uuid primary key, code text unique, n int);
           create function app.touch() returns trigger language plpgsql as $$ begin return new; end $$;
           create trigger b_touch before update on app.items for each row execute function app.touch();
           create trigger a_audit after update on app.items for each row execute function app.touch();
           alter table app.items enable always trigger a_audit;
           create trigger c_off after update on app.items for each row execute function app.touch();
           alter table app.items disable trigger c_off;
           create table app.refs (code text references app.items (code) on update cascade, item uuid references app.items (id));
           create table app.parted (id uuid, k int) partition by range (k);
           create function app.norm(t text) returns text language sql immutable as $$ select lower(t) $$;`,
          async (url) => {
            const parse = await loadSqlParser()
            const column = (
              step: string,
              name: string,
              type: string,
              expression: string
            ) => ({
              step,
              column: name,
              type,
              expression,
              kind: "split" as const,
              guard: "",
            })
            const tables: PlannedDataTable[] = [
              {
                temp: "simetra_fill_1",
                before: { schema: "app", table: "items", key: "id" },
                after: { schema: "app", table: "item", key: "id" },
                columns: [
                  column("d1", "code", "text", "app.norm(code)"),
                  column("d2", "len", "integer", "pg_catalog.length(code)"),
                ],
              },
              {
                temp: "simetra_fill_2",
                before: { schema: "app", table: "parted", key: "id" },
                after: { schema: "app", table: "parted", key: "id" },
                columns: [column("d3", "k2", "public.missing_t", "random()")],
              },
            ]
            const facts = await dbs.reader.transaction(
              { url },
              "rollback",
              (tx) =>
                readDataFacts(tx, tables, parse, new Map([["d1", "code"]]))
            )
            expect(facts.triggers.get(tableKey("app", "items"))).toEqual([
              { name: "a_audit", enabled: "A" },
              { name: "b_touch", enabled: "O" },
            ])
            expect(facts.inherited).toEqual([tableKey("app", "parted")])
            expect(facts.cascading).toEqual(["d1"])
            expect(facts.types).toEqual(
              new Map([
                ["text", "found"],
                ["integer", "found"],
                ["public.missing_t", "missing"],
              ])
            )
            expect(facts.functions).toEqual([
              {
                step: "d1",
                schema: "app",
                name: "norm",
                immutable: true,
                exists: true,
              },
              // Перевантаження `length(bytea, name)` — STABLE: функція
              // доведена лише тоді, коли IMMUTABLE кожне
              {
                step: "d2",
                schema: "pg_catalog",
                name: "length",
                immutable: false,
                exists: true,
              },
              { step: "d3", name: "random", immutable: false, exists: true },
            ])
            expect(facts.tempPrivilege).toBe(true)
            expect(facts.replicationRole).toBe("origin")
          }
        )
      })

      it("keeps a user type qualified in the snapshot and in typeChanges", async () => {
        // Рішення В5: адаптер читає типи під `search_path = pg_catalog`, тож
        // домен `public`, хоч `public` і в шляху сесії, приходить
        // кваліфікованим — і в колонці, і в зміні типу запису
        await inTarget(
          `create schema app;
           create domain public.code_t as text;
           create table app.t (id uuid primary key, c public.code_t);`,
          async (url) => {
            const extracted = await engine.extract({ url }, targetScope)
            expect(
              extracted.model.tables
                .find((t) => t.name === "t")!
                .columns.find((c) => c.name === "c")!.type
            ).toBe("public.code_t")
            const reversed = await reverseGenerate(extracted.model, {
              project: {
                name: "Adopted",
                defaultSchema: "app",
                attributeCase: "camelCase",
                databaseProvider: "supabase",
              },
              existing: new Map(),
              newId: () => randomUUID(),
              schemaPath: (_file, schemaFile) => `schemas/${schemaFile}`,
              parse: await loadSqlParser(),
            })
            const result = await compile(await acceptDebt(reversed.files))
            expect(
              result.diagnostics.filter((d) => d.severity === "error")
            ).toEqual([])
            const before = result.model!.physical
            const t = before.tables.find((x) => x.name === "t")!
            expect(t.columns.find((c) => c.name === "c")!.type).toBe(
              "public.code_t"
            )
            const derived = derivePromotionFacts(
              before,
              {
                physical: {
                  tables: [
                    {
                      ...t,
                      columns: t.columns.map((c) =>
                        c.name === "c" ? { ...c, type: "text" } : c
                      ),
                    },
                  ],
                },
                attributeCase: "camelCase",
              },
              {
                objectId: t.origin.objectId,
                tables: [t.origin.objectId],
                columns: t.columns.map((c) => ({
                  sourceId: c.origin.elementId!,
                  successorId: c.origin.elementId!,
                })),
              }
            )
            expect(derived.ok && derived.facts.typeChanges).toEqual([
              {
                schema: "app",
                table: "t",
                column: "c",
                from: "public.code_t",
                to: "text",
              },
            ])
          }
        )
      })

      it("reads desiredInvalid from the shadow in a promotion", async () => {
        // Борг 2b-1: гілка промоції читає недійсні об'єкти з бажаної тіні
        const p = await promoted()
        const outcome = await inTarget(EMPTY, async (url) => {
          await establish(url, p.before)
          const reader: ApplyDatabase = {
            transaction: (target, end, fn) =>
              dbs.reader.transaction(target, end, (tx) =>
                fn({
                  ...tx,
                  query: async <R extends Record<string, unknown>>(
                    sql: string,
                    params?: readonly unknown[]
                  ): Promise<R[]> =>
                    // Запит недійсних об'єктів, а не об'єктів еквівалентності
                    target.url !== url && sql.includes("domain constraint")
                      ? ([{ object: "constraint app.x x_a" }] as unknown as R[])
                      : tx.query<R>(sql, params),
                })
              ),
          }
          return buildPlan(
            engine,
            { ...dbs, reader },
            p.after,
            { target: { url } },
            [p.input]
          )
        })
        expect(planned(outcome).desiredInvalid).toEqual([
          "constraint app.x x_a",
        ])
      })
    })
  })
})
