import { describe, expect, it } from "vitest"
import { compile } from "simetra/compiler"
import {
  attribute,
  catalog,
  customTable,
  metaFiles,
  project,
  salesDocument,
  uuid,
} from "./helpers"

const SALE_SQL = "documents/Sale/Sale.sql"
const TABLE_SQL = "custom-tables/T/T.sql"
const SHARED_SQL = "sql/public/misc.sql"
const DEBT = "sql-debt.json"

const POLICY = "CREATE POLICY p ON public.t USING (true);"
const TRIGGER =
  "CREATE TRIGGER trg BEFORE INSERT ON public.t FOR EACH ROW EXECUTE FUNCTION public.f();"
const HANDLER =
  "CREATE FUNCTION public.f() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$ BEGIN RETURN NEW; END $$;"

/** Документ `Sale` і прийнята таблиця `T` плюс `.sql` і перелік боргу. */
async function diagnostics(files: Record<string, string>) {
  const result = await compile(
    metaFiles({
      "project.meta.json": project(),
      ...salesDocument(),
      "custom-tables/T/T.meta.json": customTable("T"),
      ...files,
    })
  )
  return result.diagnostics
}

const debt = (units: string[]) => JSON.stringify({ units })

describe("debt ratchet: sql-debt.json", () => {
  it("a debt unit missing from sql-debt.json is an error", async () => {
    const found = await diagnostics({
      [TABLE_SQL]: `${HANDLER}\n${POLICY}`,
      [DEBT]: debt([]),
    })
    expect(found.map((d) => [d.code, d.file, d.params])).toEqual([
      ["sql.debt-grows", TABLE_SQL, { identity: "policy:public.t.p", line: 2 }],
    ])
  })

  it("a missing sql-debt.json is an empty list", async () => {
    const found = await diagnostics({ [TABLE_SQL]: POLICY })
    expect(found.map((d) => [d.code, d.params?.identity])).toEqual([
      ["sql.debt-grows", "policy:public.t.p"],
    ])
  })

  it("a listed debt unit compiles", async () => {
    expect(
      await diagnostics({
        [TABLE_SQL]: `${HANDLER}\n${POLICY}`,
        [DEBT]: debt(["policy:public.t.p"]),
      })
    ).toEqual([])
  })

  it("moving a trigger from a kind module to a shared file is debt growth", async () => {
    // У модулі виду тригер — заборонений клас; перенесений у спільний `sql/`
    // він не стає прийнятним, а стає новим боргом.
    const inModule = await diagnostics({
      [SALE_SQL]: TRIGGER.replace("public.t", "public.sale"),
      [SHARED_SQL]: HANDLER,
    })
    expect(inModule.map((d) => d.code)).toEqual(["sql.statement-not-allowed"])
    const moved = await diagnostics({
      [SHARED_SQL]: `${HANDLER}\n${TRIGGER.replace("public.t", "public.sale")}`,
    })
    expect(moved.map((d) => [d.code, d.file, d.params?.identity])).toEqual([
      ["sql.debt-grows", SHARED_SQL, "trigger:public.sale.trg"],
    ])
  })

  it("functions in the closed shell are never debt", async () => {
    // Функція в оболонці проходить і в модулі боргу, і в спільному файлі;
    // функція поза оболонкою там — борг.
    expect(
      await diagnostics({
        [SHARED_SQL]: HANDLER,
        [TABLE_SQL]: HANDLER.replace("f()", "g()"),
      })
    ).toEqual([])
    const open = await diagnostics({
      [SHARED_SQL]: HANDLER.replace(" VOLATILE", ""),
    })
    expect(open.map((d) => [d.code, d.params?.identity])).toEqual([
      ["sql.debt-grows", "function:public.f()"],
    ])
  })

  it("a kind module is never debt: its other classes stay errors", async () => {
    const found = await diagnostics({
      [SALE_SQL]: "CREATE POLICY p ON public.sale USING (true);",
      [DEBT]: debt(["policy:public.sale.p"]),
    })
    // Запис про одиницю модуля виду боргом не є, тож і він застарілий.
    expect(found.map((d) => d.code)).toEqual([
      "sql.statement-not-allowed",
      "sql.debt-stale",
    ])
  })

  it("a listed identity without a unit is stale", async () => {
    const found = await diagnostics({
      [TABLE_SQL]: POLICY,
      [DEBT]: debt(["policy:public.t.gone", "policy:public.t.p"]),
    })
    expect(found.map((d) => [d.code, d.file, d.pointer, d.params])).toEqual([
      [
        "sql.debt-stale",
        DEBT,
        "/units/0",
        { identity: "policy:public.t.gone" },
      ],
    ])
  })

  it("a listed function now in the closed shell is stale", async () => {
    const found = await diagnostics({
      [SHARED_SQL]: HANDLER,
      [DEBT]: debt(["function:public.f()"]),
    })
    expect(found.map((d) => [d.code, d.params?.identity])).toEqual([
      ["sql.debt-stale", "function:public.f()"],
    ])
  })

  it("paid-off debt cannot come back without introspect", async () => {
    // Оператор боргу видалено (виражено властивістю): запис застарів, `fix`
    // його прибирає, а повернута одиниця з тим самим ім'ям — знову ріст.
    const listed = debt(["policy:public.t.p"])
    expect((await diagnostics({ [DEBT]: listed })).map((d) => d.code)).toEqual([
      "sql.debt-stale",
    ])
    expect(await diagnostics({ [DEBT]: debt([]) })).toEqual([])
    const back = await diagnostics({ [TABLE_SQL]: POLICY, [DEBT]: debt([]) })
    expect(back.map((d) => [d.code, d.params?.identity])).toEqual([
      ["sql.debt-grows", "policy:public.t.p"],
    ])
  })

  it("a compile failing before stage 3 does not judge the debt", async () => {
    // Без моделі ідентичності неповні: ріст боргу тут був би шумом.
    const found = await diagnostics({
      [TABLE_SQL]: POLICY,
      "catalogs/Broken/Broken.meta.json": "{",
    })
    expect(found.map((d) => d.code)).not.toContain("sql.debt-grows")
    expect(found.map((d) => d.code)).toContain("file.invalid-json")
  })

  it("an unparsed .sql leaves debt unknown: no stale entries", async () => {
    const found = await diagnostics({
      [TABLE_SQL]: "CREATE POLICY",
      [DEBT]: debt(["policy:public.t.p"]),
    })
    expect(found.map((d) => d.code)).toEqual(["sql.parse"])
  })

  it.each([
    ["unsorted", ["policy:public.t.p", "function:public.f()"]],
    ["with duplicates", ["policy:public.t.p", "policy:public.t.p"]],
  ])("%s sql-debt.json is not canonical", async (_name, units) => {
    const found = await diagnostics({
      [TABLE_SQL]: POLICY,
      [DEBT]: debt(units),
    })
    // Перелік зламаний — ратчет над ним мовчить: причину вже названо.
    expect(found.map((d) => [d.code, d.file, d.pointer])).toEqual([
      ["debt.not-canonical", DEBT, "/units/1"],
    ])
  })

  it("an unknown key in sql-debt.json is a schema error", async () => {
    const found = await diagnostics({
      [DEBT]: JSON.stringify({ units: [], extra: 1 }),
    })
    expect(found.map((d) => [d.code, d.file, d.pointer])).toEqual([
      ["file.unknown-key", DEBT, "/extra"],
    ])
  })

  it("a subscription handler is never debt, listed or not", async () => {
    // Рішення 8: обробник поза оболонкою — `subscription.handler-not-closed`,
    // а не `sql.debt-grows`, і перелік боргу цього не змінює.
    const handlerFile = "sql/public/stamp.sql"
    const files = (extra: Record<string, unknown>) =>
      metaFiles({
        "project.meta.json": project(),
        "catalogs/Contract/Contract.meta.json": catalog("Contract", {
          attributes: [attribute("number", { type: "String", length: 20 })],
        }),
        "event-subscriptions/Stamp/Stamp.meta.json": {
          id: uuid(7101),
          kind: "EventSubscription",
          name: "Stamp",
          physicalName: "stamp",
          sources: [{ kind: "Catalog", name: "Contract" }],
          event: "beforeWrite",
          handler: { name: "stamp" },
        },
        [handlerFile]:
          "CREATE FUNCTION public.stamp() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;",
        ...extra,
      })
    for (const extra of [{}, { [DEBT]: debt(["function:public.stamp()"]) }]) {
      const found = (await compile(files(extra))).diagnostics
      // Обробник боргом не буває, тож запис про нього — застарілий.
      expect(found.map((d) => [d.code, d.params?.problem])).toEqual([
        ["subscription.handler-not-closed", "volatility"],
        ...(DEBT in extra ? [["sql.debt-stale", undefined]] : []),
      ])
    }
  })
})
