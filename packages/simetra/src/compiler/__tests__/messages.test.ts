import { describe, expect, it } from "vitest"
import { SCHEMA_RULES } from "simetra/model"
import {
  COMPILER_RULES,
  MESSAGES,
  localize,
  compile,
  type RuleCode,
} from "simetra/compiler"
import { metaFiles, project } from "./helpers"
import { diagnostic } from "../diagnostics"

const ALL_RULES: RuleCode[] = [...SCHEMA_RULES, ...COMPILER_RULES]

// Параметри, яких вимагають тексти: порожні params дали б "undefined" у рядку.
const PARAMS = new Proxy(
  {},
  { get: (_, key) => (key === "then" ? undefined : `<${String(key)}>`) }
) as Record<string, string>

describe("messages catalog", () => {
  it("every rule has en and uk", () => {
    for (const code of ALL_RULES) {
      const entry = MESSAGES[code]
      expect(entry, code).toBeDefined()
      expect(entry.en(PARAMS).trim(), `${code} en`).not.toBe("")
      expect(entry.uk(PARAMS).trim(), `${code} uk`).not.toBe("")
      if (entry.hint !== undefined) {
        for (const locale of ["en", "uk"] as const) {
          const hint = entry.hint[locale]
          const text = typeof hint === "string" ? hint : hint(PARAMS)
          expect(text.trim(), `${code} hint ${locale}`).not.toBe("")
        }
      }
    }
  })

  it("the catalog has no entries outside the rule lists", () => {
    expect(Object.keys(MESSAGES).sort()).toEqual([...ALL_RULES].sort())
  })

  it("a Ukrainian text differs from the English one", () => {
    // Копія англійського тексту в uk — ознака забутого перекладу.
    for (const code of ALL_RULES) {
      expect(MESSAGES[code].uk(PARAMS), code).not.toBe(
        MESSAGES[code].en(PARAMS)
      )
    }
  })

  it("file.schema gets the Zod Ukrainian text", async () => {
    const result = await compile(
      metaFiles({
        "project.meta.json": project(),
        "catalogs/Item/Item.meta.json": { kind: "Catalog", name: 7 },
      })
    )
    const d = result.diagnostics.find((x) => x.code === "file.schema")
    expect(d?.message).toMatch(/^Invalid input/)
    expect(localize(d!, "uk").message).toMatch(/^Неправильн.*отримано число/)
  })

  it("physical.reserved-word does not claim a keyword must always be quoted", () => {
    // COL_NAME_KEYWORD (`position`) у ролі імені колонки лапок не потребує
    const entry = MESSAGES["physical.reserved-word"]
    const params = { name: "position" }
    expect(entry.en(params)).not.toMatch(/must be quoted/)
    expect(entry.en(params)).toBe(
      "Physical name position is a PostgreSQL keyword; some positions need it quoted"
    )
    expect(entry.uk(params)).toBe(
      "Фізичне ім'я position — ключове слово Postgres; на деяких позиціях його треба брати в лапки"
    )
  })

  it("localize returns uk text", () => {
    const d = diagnostic("identity.id-missing", "a.meta.json", "/id")
    expect(d.message).toBe("id is missing")
    expect(localize(d, "en")).toEqual({
      message: "id is missing",
      hint: "Run simetra fix to assign ids.",
    })
    expect(localize(d, "uk")).toEqual({
      message: "Немає id",
      hint: "Виконайте simetra fix, щоб призначити id.",
    })
  })

  it("localize fills parameters and parametric hints", () => {
    const d = diagnostic("reference.ambiguous", "a.meta.json", "/x", {
      name: "Item",
      candidates: "Catalog.Item, Document.Item",
    })
    expect(localize(d, "uk")).toEqual({
      message: 'Ім\'я "Item" неоднозначне між Catalog.Item, Document.Item',
      hint: "Кваліфікуйте маркер як <Kind>.<Name>, наприклад Catalog.Item.",
    })
  })

  it("subscription.handler-assigns-mechanics names the problem and the way out", () => {
    const d = diagnostic(
      "subscription.handler-assigns-mechanics",
      "a.meta.json",
      "/handler",
      { function: "app.stamp", problem: "RETURN OLD" }
    )
    expect(localize(d, "en")).toEqual({
      message:
        "Handler app.stamp assigns a row-mechanics column or replaces the row (RETURN OLD); the platform maintains updated_at and version",
      hint: "Change other columns of NEW and return NEW, or NULL to skip the write.",
    })
    expect(localize(d, "uk")).toEqual({
      message:
        "Обробник app.stamp присвоює колонку механіки рядка або підміняє рядок (RETURN OLD); updated_at і version веде платформа",
      hint: "Змінюйте інші колонки NEW і повертайте NEW або NULL, щоб пропустити запис.",
    })
  })

  it("localize omits the hint when the rule has none", () => {
    const d = diagnostic("identity.name-duplicate", "a", "/n", {
      name: "X",
      scope: "Y",
    })
    expect(localize(d, "uk")).toEqual({
      message: 'Ім\'я "X" уже оголошене в Y',
    })
  })

  it("sql.closed-shell puts the line on the statement only for dynamic SQL", () => {
    const text = (problem: string, locale: "en" | "uk") =>
      localize(
        diagnostic("sql.closed-shell", "a.sql", "", {
          function: "public.f",
          line: 7,
          problem,
        }),
        locale
      ).message
    expect(text("dynamicSql", "en")).toBe(
      "Function public.f is outside the closed shell: its body runs dynamic SQL (EXECUTE, a dynamic cursor or RETURN QUERY EXECUTE) at line 7"
    )
    expect(text("dynamicSql", "uk")).toBe(
      "Функція public.f поза закритою оболонкою: її тіло виконує динамічний SQL (EXECUTE, динамічний курсор чи RETURN QUERY EXECUTE) у рядку 7"
    )
    // Решта проблем — про функцію цілком: рядок її початку.
    expect(text("volatility", "en")).toBe(
      "Function public.f at line 7 is outside the closed shell: its volatility is not explicit"
    )
    expect(text("volatility", "uk")).toBe(
      "Функція public.f у рядку 7 поза закритою оболонкою: її волатильність не явна"
    )
  })

  it("renders every fill problem of promote.expression-invalid as a sentence", () => {
    const reasons = [
      "noKey",
      "syntax",
      "subquery",
      "aggregate",
      "foreignTable",
      "multipleTargets",
      "multipleStatements",
      "setReturning",
      "volatile",
      "unknownFunction",
      "unqualifiedFunction",
      "castToTime",
      "specialTimeLiteral",
      "nondeterministicWindow",
      "unknownColumn",
    ]
    for (const locale of ["en", "uk"] as const) {
      const messages = reasons.map((reason) => {
        const { message } = localize(
          diagnostic("promote.expression-invalid", "", "", {
            at: "/fill/0/expression",
            expression: "x",
            reason,
          }),
          locale
        )
        expect(message, `${reason} ${locale}`).not.toMatch(
          new RegExp(`: ${reason}$`)
        )
        return message
      })
      expect(new Set(messages).size, locale).toBe(reasons.length)
    }
  })

  // Рішення В17: збій `ALTER TABLE` на тригері — не проблема даних, а запис
  // іде під закріпленим `search_path`
  it("chooses the hint of apply.data-step-failed by the statement", () => {
    const hint = (params: Record<string, string>, locale: "en" | "uk") =>
      localize(
        diagnostic("apply.data-step-failed", "", "", {
          table: "app.u",
          steps: "d1",
          sqlstate: "55006",
          error: "e",
          ...params,
        }),
        locale
      ).hint
    const write = (statement: string) => ({ phase: "write", statement })
    for (const statement of ["trigger-disable", "trigger-enable"]) {
      expect(hint(write(statement), "en")).toMatch(/not a data problem/)
      expect(hint(write(statement), "en")).not.toMatch(/Fix the data/)
      expect(hint(write(statement), "uk")).not.toMatch(/Виправте дані/)
    }
    expect(hint(write("update"), "en")).toMatch(/Fix the data.*search_path/s)
    expect(hint(write("update"), "uk")).toMatch(/Виправте дані.*search_path/s)
    expect(hint({ phase: "compute" }, "en")).not.toMatch(/search_path/)
    // Текст повідомлення теж називає перемикання тригерів, а не запис
    expect(
      localize(
        diagnostic("apply.data-step-failed", "", "", {
          ...write("trigger-enable"),
          table: "app.u",
          steps: "d1",
          sqlstate: "55006",
          error: "e",
        }),
        "en"
      ).message
    ).toMatch(/^Enabling the user triggers of app\.u/)
  })

  // Рішення В19: тип, якого план не називає, не лікується «спершу зміною типу»
  it("gives the unparsed type of a data step its own hint", () => {
    const hint = (detail: string, locale: "en" | "uk") =>
      localize(
        diagnostic("plan.promotion-unsupported", "", "", {
          reason: "dataStepType",
          detail,
        }),
        locale
      ).hint
    for (const locale of ["en", "uk"] as const) {
      expect(hint("unparsed", locale)).not.toBe(hint("missing", locale))
      expect(hint("unparsed", locale)).not.toBe(hint("cast", locale))
    }
    expect(hint("unparsed", "en")).toMatch(/a type the plan can name/)
    expect(hint("missing", "en")).toMatch(/Apply the change of the type first/)
  })

  // Рішення В18: правило `UPDATE` — своя причина й порада
  it("renders the rewrite rule detail of dataStepTable", () => {
    const text = (detail: string | undefined, locale: "en" | "uk") =>
      localize(
        diagnostic("plan.promotion-unsupported", "", "", {
          reason: "dataStepTable",
          ...(detail === undefined ? {} : { detail }),
        }),
        locale
      )
    for (const locale of ["en", "uk"] as const) {
      expect(text("rule", locale).message).toMatch(/UPDATE/)
      expect(text("rule", locale).hint).toMatch(/UPDATE/)
      expect(text(undefined, locale).message).not.toMatch(/UPDATE/)
    }
  })

  it("sql.generated-grant names the object and points to fix", () => {
    const d = diagnostic("sql.generated-grant", "sql/public/g.sql", "", {
      identity: "grant:grant:function:public.my_orgs():anon:execute",
      line: 1,
      object: "public.my_orgs()",
    })
    expect(d.message).toBe(
      "Privileges on public.my_orgs() are generated from the metadata; this statement contradicts them"
    )
    expect(d.hint).toBe(
      "Remove the statement; simetra fix removes it when every target belongs to the platform — a statement that also names other objects is split by hand."
    )
    const uk = localize(d, "uk")
    expect(uk.message).toBe(
      "Права на public.my_orgs() генеруються з метаданих; цей оператор їм суперечить"
    )
    expect(uk.hint).toBe(
      "Приберіть оператор; simetra fix прибирає його, коли всі цілі належать платформі, — оператор, що називає й чужі об'єкти, ділять вручну."
    )
  })

  it("plan.provider-trigger-taken names the trigger and the provider table", () => {
    const d = diagnostic("plan.provider-trigger-taken", "", "", {
      trigger: "audit_x",
      table: "auth.users",
    })
    expect(d.message).toBe(
      "No plan was written. Trigger audit_x on auth.users already exists and was not created by Simetra; the generated trigger would silently replace it"
    )
    expect(d.hint).toBe(
      "Give the subscription another physicalName, or describe the existing trigger first (introspect) and apply."
    )
    const uk = localize(d, "uk")
    expect(uk.message).toBe(
      "План не записано. Тригер audit_x на auth.users уже є і створений не Simetra; згенерований тригер тихо замінив би його"
    )
    expect(uk.hint).toBe(
      "Дайте підписці інший physicalName або спершу опишіть наявний тригер (introspect) і застосуйте."
    )
  })

  it("plan.numbering-not-generated names the object and its table", () => {
    const d = diagnostic("plan.numbering-not-generated", "", "", {
      object: "Party",
      table: "app.party",
    })
    expect(d.message).toBe(
      "Party (app.party) numbers rows on first write, but counters are not generated yet: the number stays empty"
    )
    expect(d.hint).toBe(
      "If the object needs no number, set autonumber: false, or codeLength: 0 for a catalog; otherwise the number stays empty until the platform generates counters."
    )
    const uk = localize(d, "uk")
    expect(uk.message).toBe(
      "Party (app.party) нумерує рядки першим записом, але лічильники ще не генеруються: номер лишиться порожнім"
    )
    expect(uk.hint).toBe(
      "Якщо номер об'єкту не потрібен, задайте autonumber: false, а довіднику — codeLength: 0; інакше номер лишатиметься порожнім, доки платформа не генерує лічильників."
    )
  })

  it("plan.update-of-narrowed names the trigger, the table and the columns", () => {
    const d = diagnostic("plan.update-of-narrowed", "", "", {
      trigger: "items_price",
      table: "app.items",
      columns: "price, qty",
    })
    expect(d.message).toBe(
      "Trigger items_price on app.items fired on UPDATE OF price, qty; the subscription fires only when a value actually changes"
    )
    expect(d.hint).toBe(
      "Review the handler: an UPDATE that writes the current values into these columns no longer runs it."
    )
    const uk = localize(d, "uk")
    expect(uk.message).toBe(
      "Тригер items_price на app.items спрацьовував на UPDATE OF price, qty; підписка спрацьовує лише на справжню зміну значення"
    )
    expect(uk.hint).toBe(
      "Перевірте обробник: UPDATE, що записує в ці колонки їхні поточні значення, його більше не запускає."
    )
  })

  it("plan.service-role-access-lost names the tables and keeps them CustomTable", () => {
    const d = diagnostic("plan.service-role-access-lost", "", "", {
      tables: "app.items, app.item_lines",
    })
    expect(d.message).toBe(
      "Server code using the service key loses access to app.items, app.item_lines: after promotion the service role has no privileges on kind tables"
    )
    expect(d.hint).toBe(
      "If server code reads or writes these tables with the service key, keep them CustomTable until platform commands (P4)."
    )
    const uk = localize(d, "uk")
    expect(uk.message).toBe(
      "Серверний код на сервісному ключі втрачає доступ до app.items, app.item_lines: після промоції сервісна роль не має привілеїв на таблицях виду"
    )
    expect(uk.hint).toBe(
      "Якщо серверний код читає чи пише ці таблиці сервісним ключем, лишіть їх CustomTable до команд платформи (П4)."
    )
  })
})
