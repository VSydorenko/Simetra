import { describe, expect, it } from "vitest"
import {
  SUPABASE_EXPECTED_BLIND_FUNCTIONS,
  type PlanArtifact,
} from "simetra/schema"
import {
  CONTACT_FILE,
  COUNTERPARTY_FILE,
  uuid,
} from "../../../../simetra/test/support"
import {
  BLIND_SETUP,
  codes,
  contactsMapping,
  contactsProject,
  errors,
  Json,
  OLD,
  params,
  planned,
  planPromotion,
  promoted,
  stepMatching,
  STRANGER,
  useBuildPlanRoles,
} from "./build-plan.support"

/**
 * Конвеєр плану `buildPlan` на стеку Supabase — промоція з FK на таблицю
 * провайдера (`storage.objects`), сліпі функції пресету й доступ сервісної
 * ролі (спека промоції §8). Спільна підготовка — `build-plan.support.ts`.
 */

useBuildPlanRoles()

// Конкурентно: ціль і копії кожного тесту — власні бази, ролі створює лише
// `beforeAll`, а лічильники двигунів-шпигунів — локальні для тесту
describe.concurrent("buildPlan", () => {
  describe("promotion", () => {
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
  })
})
