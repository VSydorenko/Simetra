import { beforeAll, describe, expect, it } from "vitest"
import {
  compile,
  loadSqlParser,
  platformInstall,
  type SqlParser,
} from "simetra/compiler"
import { DATABASE_PROVIDERS, type DatabaseProvider } from "simetra/model"
import { applyStateOwnership } from "simetra/schema"
import {
  installMismatch,
  installObjects,
  type InstallExpectation,
} from "./support/platform-install"

/**
 * Точна звірка `diff` бази без стану застосування з платформною установкою
 * (`installMismatch`) на формі, яку дає двигун: дії й відмінності нижче —
 * це вихід `diff` над базою SHOP у CI (ідентичності двигуна й адреси
 * відмінностей каталогу), кожна дія — лише ті поля, які читає звірка
 * (текст оператора — лише його дієслово й об'єкт).
 */

const T = "simetra.signal_outbox"
/** Ідентичності двигуна функцій установки: типи аргументів без лапок. */
const F = {
  notify: "function:simetra.signal_outbox_notify()",
  prune: "function:simetra.signal_outbox_prune(interval)",
  stamp: "function:simetra.signal_outbox_stamp()",
}
/**
 * Ті самі функції ідентичностями одиниць — так їх називають адреси
 * відмінностей каталогу (`units.<ідентичність>`): частини імені й типу — за
 * `quoteIdent`, тож `interval` — у лапках.
 */
const U = {
  notify: "function:simetra.signal_outbox_notify()",
  prune: 'function:simetra.signal_outbox_prune("interval")',
  stamp: "function:simetra.signal_outbox_stamp()",
}
let parse: SqlParser
beforeAll(async () => {
  parse = await loadSqlParser()
})
const extra = (path: string) => ({
  path,
  kind: "extra" as const,
  detail: "absent in first model",
})

const action = (produces: string[], consumes: string[], sql = "CREATE") => ({
  sql,
  produces,
  consumes,
  destroys: [],
})

const CONSUMER_GRANT = action(
  [],
  [`table:${T}`, "role:simetra_signal_consumer"],
  `GRANT DELETE, SELECT ON TABLE ${T} TO "simetra_signal_consumer"`
)
const CONSUMER_PATH = `units.grant:grant:table:${T}:simetra_signal_consumer:delete,select`

/**
 * Функція порожності `RichText` (Р-B7-8) і її гранти ролям сесії профілю:
 * рядки тієї самої форми, що й записані вище (дія створення, відкликання від
 * `PUBLIC` з ACL, грант із залежністю `role:`); роль — за профілем.
 */
const RICH_TEXT = "function:simetra.rich_text_is_empty(jsonb)"
const RICH_TEXT_ROLES: Record<DatabaseProvider, string[]> = {
  supabase: ["anon", "authenticated", "service_role", "simetra_command"],
  postgres: ["simetra_anon", "simetra_command", "simetra_user"],
}
const richTextPlan = (provider: DatabaseProvider) => [
  action([RICH_TEXT], ["schema:simetra"]),
  action(
    [`acl:(${RICH_TEXT}).PUBLIC`],
    [RICH_TEXT],
    `REVOKE ALL ON FUNCTION ${RICH_TEXT} FROM PUBLIC`
  ),
  ...RICH_TEXT_ROLES[provider].map((role) =>
    action(
      [],
      [RICH_TEXT, `role:${role}`],
      `GRANT EXECUTE ON FUNCTION ${RICH_TEXT} TO "${role}"`
    )
  ),
]
const richTextDifferences = (provider: DatabaseProvider) => {
  const signature = RICH_TEXT.slice("function:".length)
  return [
    `units.${RICH_TEXT}`,
    `units.grant:revoke:function:${signature}:public:execute`,
    ...RICH_TEXT_ROLES[provider].map(
      (role) => `units.grant:grant:function:${signature}:${role}:execute`
    ),
  ].map(extra)
}
const richTextGrants = (provider: DatabaseProvider) => [
  ...RICH_TEXT_ROLES[provider].map((role) => `grant|${RICH_TEXT}|${role}`),
  `revoke|${RICH_TEXT}|public`,
]

const OUTBOX_PLAN = [
  action(
    [
      `table:${T}`,
      ...["id", "method", "payload", "partition", "created_at"].map(
        (c) => `column:${T}.${c}`
      ),
      `default:${T}.partition`,
      `default:${T}.created_at`,
      ...["id", "method", "partition", "payload", "size"].map(
        (c) => `constraint:${T}.signal_outbox_${c}_check`
      ),
      `constraint:${T}.signal_outbox_pkey`,
    ],
    ["schema:simetra"]
  ),
  // ENABLE ROW LEVEL SECURITY нічого не створює
  action([], [`table:${T}`, "schema:simetra"]),
  ...Object.values(F).map((f) => action([f], ["schema:simetra"])),
  ...["notify", "stamp"].map((t) =>
    action([`trigger:${T}.simetra_signal_outbox_${t}`], [`table:${T}`])
  ),
  ...["delete", "select"].map((p) =>
    action(
      [`policy:${T}.signal_outbox_consumer_${p}`],
      [`table:${T}`, "role:simetra_signal_consumer"]
    )
  ),
  ...Object.values(F).map((f) =>
    action(
      [`acl:(${f}).PUBLIC`],
      [f],
      `REVOKE ALL ON FUNCTION ${f} FROM PUBLIC`
    )
  ),
  ...["method", "payload"].map((c) =>
    action(
      [],
      [`column:${T}.${c}`, "role:simetra_command"],
      `GRANT INSERT ("${c}") ON TABLE ${T} TO "simetra_command"`
    )
  ),
  CONSUMER_GRANT,
]

const OUTBOX_DIFFERENCES = [
  `tables.${T}`,
  ...Object.values(U).map((f) => `units.${f}`),
  `units.grant:grant:table:${T}:simetra_command:insert(method)`,
  `units.grant:grant:table:${T}:simetra_command:insert(payload)`,
  CONSUMER_PATH,
  ...Object.values(U).map(
    (f) =>
      `units.grant:revoke:function:${f.slice("function:".length)}:public:execute`
  ),
  `units.policy:${T}.signal_outbox_consumer_delete`,
  `units.policy:${T}.signal_outbox_consumer_select`,
  `units.trigger:${T}.simetra_signal_outbox_notify`,
  `units.trigger:${T}.simetra_signal_outbox_stamp`,
].map(extra)

const dataOf = (provider: DatabaseProvider) => ({
  plan: [...OUTBOX_PLAN, ...richTextPlan(provider)],
  differences: [...OUTBOX_DIFFERENCES, ...richTextDifferences(provider)],
})
/** Звірки нижче — на `postgres`. */
const DATA = dataOf("postgres")
const PLAN = DATA.plan
const DIFFERENCES = DATA.differences

const EXACT = {
  foreignActions: [],
  foreignDifferences: [],
  foreignGrants: [],
  unplanned: [],
  undifferenced: [],
}

/** Очікувані об'єкти моделі SHOP: без «Користувачів», схема — стану. */
async function expected(
  provider: DatabaseProvider
): Promise<InstallExpectation> {
  const compiled = await compile(
    new Map([
      [
        "project.meta.json",
        JSON.stringify({ name: "Shop", database: { provider } }),
      ],
    ])
  )
  return installObjects(
    await platformInstall(provider),
    applyStateOwnership(compiled.model!).owns
  )
}

describe("installMismatch", () => {
  it.each(DATABASE_PROVIDERS)(
    "%s: the diff of a database without the apply state is exactly the install",
    async (provider) => {
      const objects = await expected(provider)
      // Послідовність версій — стану застосування, її `diff` не показує
      expect(objects.objects).not.toContain("sequence:simetra.row_version")
      expect(objects.objects).toContain(`table:${T}`)
      // Видимі гранти: власні гранти установки й відкликання від `PUBLIC`
      // того, що `PUBLIC` має за замовчуванням (`EXECUTE` функцій)
      expect(objects.grants).toEqual(
        [
          `grant|table:${T}|simetra_command`,
          `grant|table:${T}|simetra_signal_consumer`,
          ...Object.values(U).map((f) => `revoke|${f}|public`),
          ...richTextGrants(provider),
        ].sort()
      )
      expect(installMismatch(dataOf(provider), objects, parse)).toEqual(EXACT)
    }
  )

  it("an install object the diff does not name is a mismatch", async () => {
    const objects = await expected("postgres")
    const without = (prefix: string) => ({
      plan: PLAN.filter((a) => !a.produces.some((id) => id.startsWith(prefix))),
      differences: DIFFERENCES.filter((d) => !d.path.includes(prefix)),
    })
    const trigger = `trigger:${T}.simetra_signal_outbox_notify`
    expect(installMismatch(without(trigger), objects, parse)).toEqual({
      ...EXACT,
      unplanned: [trigger],
      undifferenced: [trigger],
    })
  })

  it("an action or a difference outside the install is a mismatch", async () => {
    const objects = await expected("postgres")
    const foreign = action(["table:simetra.receipts"], ["schema:simetra"])
    const schemaGrant = action(
      [],
      ["schema:simetra", "role:simetra_command"],
      'GRANT USAGE ON SCHEMA simetra TO "simetra_command"'
    )
    const own = extra(
      "units.grant:grant:table:app.orders:simetra_command:select"
    )
    expect(
      installMismatch(
        {
          plan: [...PLAN, foreign, schemaGrant],
          differences: [...DIFFERENCES, own],
        },
        objects,
        parse
      )
    ).toEqual({
      ...EXACT,
      foreignActions: [foreign, schemaGrant],
      foreignDifferences: [own.path],
      foreignGrants: ["grant|table:app.orders|simetra_command"],
    })
  })

  it("an install object the derived set lacks turns the diff foreign", async () => {
    const all = await expected("postgres")
    const objects = {
      ...all,
      objects: all.objects.filter((o) => o !== U.prune),
    }
    const mismatch = installMismatch(DATA, objects, parse)
    expect(mismatch.foreignActions).toHaveLength(2)
    expect(mismatch.foreignDifferences).toEqual([
      `units.${U.prune}`,
      'units.grant:revoke:function:simetra.signal_outbox_prune("interval"):public:execute',
    ])
  })

  it("a grant to a wrong or an extra role is a mismatch", async () => {
    const objects = await expected("postgres")
    const extraRole = action(
      [],
      [`table:${T}`, "role:some_extra_role"],
      `GRANT SELECT ON TABLE ${T} TO "some_extra_role"`
    )
    const wrongRole = action(
      [],
      [`table:${T}`, "role:simetra_command"],
      `GRANT DELETE, SELECT ON TABLE ${T} TO "simetra_command"`
    )
    const path = `units.grant:grant:table:${T}:some_extra_role:select`
    expect(
      installMismatch(
        {
          plan: [...PLAN.filter((a) => a !== CONSUMER_GRANT), extraRole],
          differences: [
            ...DIFFERENCES.filter((d) => d.path !== CONSUMER_PATH),
            extra(path),
          ],
        },
        objects,
        parse
      )
    ).toEqual({
      ...EXACT,
      foreignGrants: [`grant|table:${T}|some_extra_role`],
      unplanned: [`grant|table:${T}|simetra_signal_consumer`],
      undifferenced: [`grant|table:${T}|simetra_signal_consumer`],
    })
    // Грант не тій ролі: споживача немає, а роль команд має зайве — пару
    // (ціль, роль) цим не покрити, тож видно лише брак гранту споживачеві
    expect(
      installMismatch(
        {
          plan: [...PLAN.filter((a) => a !== CONSUMER_GRANT), wrongRole],
          differences: DIFFERENCES,
        },
        objects,
        parse
      )
    ).toEqual({
      ...EXACT,
      unplanned: [`grant|table:${T}|simetra_signal_consumer`],
    })
  })

  it("a grant to PUBLIC is a mismatch", async () => {
    const objects = await expected("postgres")
    const toPublic = action(
      [`acl:(table:${T}).PUBLIC`],
      [`table:${T}`],
      `GRANT SELECT ON TABLE ${T} TO PUBLIC`
    )
    const path = `units.grant:grant:table:${T}:public:select`
    expect(
      installMismatch(
        {
          plan: [...PLAN, toPublic],
          differences: [...DIFFERENCES, extra(path)],
        },
        objects,
        parse
      )
    ).toEqual({ ...EXACT, foreignGrants: [`grant|table:${T}|public`] })
  })

  it("the consumer's grant missing is a mismatch", async () => {
    const objects = await expected("postgres")
    expect(
      installMismatch(
        {
          plan: PLAN.filter((a) => a !== CONSUMER_GRANT),
          differences: DIFFERENCES.filter((d) => d.path !== CONSUMER_PATH),
        },
        objects,
        parse
      )
    ).toEqual({
      ...EXACT,
      unplanned: [`grant|table:${T}|simetra_signal_consumer`],
      undifferenced: [`grant|table:${T}|simetra_signal_consumer`],
    })
  })
})
