import { describe, expect, it } from "vitest"
import {
  compile,
  fixFiles,
  type CompiledModel,
  type SqlUnit,
} from "simetra/compiler"
import { PLATFORM_ROLES, quoteIdent } from "simetra/model"
import { modelHash } from "../../../../simetra/src/compiler/canonical"
import {
  acceptDebt,
  metaFiles,
  project,
  testProvider,
  withSessionOptions,
} from "../../../../simetra/test/support"
import { asSuperuser, query } from "../../__tests__/support/db"
import {
  codes,
  compiled,
  EMPTY,
  establish,
  inTarget,
  PARTY,
  party,
  plan,
  USER,
  useBuildPlanRoles,
} from "./build-plan.support"

/**
 * Схема застосунку, відмінна від `public`: таблицю читають лише ролі з
 * `USAGE` на її схемі. Грант схеми дає платформа тим ролям, яким вид дає
 * доступ до таблиць, — без дослівного гранту в проєкті. DB-рівень, бо
 * відмову за схемою дає лише сервер.
 */

useBuildPlanRoles()

describe.concurrent("USAGE on the application schema", () => {
  it.each([
    ["the request role", USER],
    ["the command role", PLATFORM_ROLES.command],
  ])("lets %s read a table of a non-public schema", async (_name, role) => {
    const model = await compiled({ [PARTY]: party() })
    expect(model.project.defaultSchema).toBe("app")
    await inTarget(EMPTY, async (url) => {
      await establish(url, model)
      const rows = await query<{ n: number }>(
        withSessionOptions(asSuperuser(url), `-c role=${role}`),
        "select count(*)::int as n from app.party"
      )
      expect(rows).toEqual([{ n: 0 }])
    })
  })
})

describe("moving from a verbatim USAGE grant to the generated one", () => {
  const USAGE = "sql/app/usage.sql"
  const isUsage = (u: CompiledModel["sqlUnits"][number]) =>
    u.class === "grant" && u.generator === "access" && /ON SCHEMA/i.test(u.sql)
  const filesWith = async (verbatim: boolean) =>
    acceptDebt(
      metaFiles({
        "project.meta.json": project({
          defaultSchema: "app",
          database: { provider: testProvider() },
        }),
        [PARTY]: party(),
        ...(verbatim
          ? {
              [USAGE]: [USER, PLATFORM_ROLES.command]
                .map((r) => `GRANT USAGE ON SCHEMA app TO ${quoteIdent(r)};\n`)
                .join(""),
            }
          : {}),
      })
    )

  it("flags the duplicate, removes it with fix and plans nothing on a database applied with it", async () => {
    // Дослівний тотожний грант — грант платформи: помилка з вирізом `fix`, а
    // не `sql.unit-duplicate`
    const verbatim = await filesWith(true)
    const flagged = await compile(verbatim)
    expect(
      flagged.diagnostics
        .filter((d) => d.severity === "error")
        .map((d) => d.code)
    ).toEqual(["sql.generated-grant", "sql.generated-grant"])
    const fixed = await fixFiles(verbatim, {
      schemaPath: () => "",
      newId: () => {
        throw new Error("fix must not assign ids here")
      },
    })
    expect(fixed.ok).toBe(true)
    // Інші зміни — доповнення файлів метаданих; SQL `fix` торкається лише
    // дубліката
    expect(fixed.changes).toContainEqual({ path: USAGE, content: null })
    expect(
      fixed.changes.filter((c) => c.path.startsWith("sql/")).map((c) => c.path)
    ).toEqual([USAGE])
    const model = await compiled({ [PARTY]: party() })
    // База, застосована до генерації грантів: ті самі гранти — дослівною
    // одиницею, і marker несе саме такий знімок
    const before: Omit<CompiledModel, "hash"> = {
      ...model,
      sqlUnits: model.sqlUnits.map((u) => {
        if (!isUsage(u)) return u
        const verbatim: SqlUnit = { ...u, file: USAGE, line: 1 }
        delete verbatim.generator
        return verbatim
      }),
    }
    const old: CompiledModel = { ...before, hash: await modelHash(before) }
    // Канонічний знімок не несе джерела одиниці (файл чи генератор), тож
    // marker такої бази — той самий, що й після переходу
    expect(old.hash).toBe(model.hash)
    await inTarget(EMPTY, async (url) => {
      await establish(url, old)
      const outcome = await plan(url, model)
      expect(codes(outcome)).not.toContain("apply.drift")
      const steps = outcome.status === "planned" ? outcome.artifact.steps : []
      expect(steps.filter((s) => /SCHEMA "?app"?/i.test(s.sql))).toEqual([])
      expect(outcome.status).toBe("unchanged")
    })
  })
})
