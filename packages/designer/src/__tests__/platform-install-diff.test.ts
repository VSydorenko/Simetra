import { describe, expect, it } from "vitest"
import { compile, platformInstall } from "simetra/compiler"
import { DATABASE_PROVIDERS, type DatabaseProvider } from "simetra/model"
import { applyStateOwnership } from "simetra/schema"
import { installMismatch, installObjects } from "./support/platform-install"

/**
 * Точна звірка `diff` бази без стану застосування з платформною установкою
 * (`installMismatch`) на формі, яку дає двигун: дії й відмінності нижче —
 * це вихід `diff` над базою SHOP у CI (ідентичності двигуна й адреси
 * відмінностей каталогу), кожна дія — лише ті поля, які читає звірка.
 */

const T = "simetra.signal_outbox"
const F = {
  notify: "function:simetra.signal_outbox_notify()",
  prune: "function:simetra.signal_outbox_prune(interval)",
  stamp: "function:simetra.signal_outbox_stamp()",
}
const action = (produces: string[], consumes: string[]) => ({
  produces,
  consumes,
  destroys: [],
})

const PLAN = [
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
  ...Object.values(F).map((f) => action([`acl:(${f}).PUBLIC`], [f])),
  ...["method", "payload"].map((c) =>
    action([], [`column:${T}.${c}`, "role:simetra_command"])
  ),
  action([], [`table:${T}`, "role:simetra_signal_consumer"]),
]

const extra = (path: string) => ({
  path,
  kind: "extra" as const,
  detail: "absent in first model",
})

const DIFFERENCES = [
  `tables.${T}`,
  ...Object.values(F).map((f) => `units.${f}`),
  `units.grant:grant:table:${T}:simetra_command:insert(method)`,
  `units.grant:grant:table:${T}:simetra_command:insert(payload)`,
  `units.grant:grant:table:${T}:simetra_signal_consumer:delete,select`,
  ...Object.values(F).map(
    (f) =>
      `units.grant:revoke:function:${f.slice("function:".length)}:public:execute`
  ),
  `units.policy:${T}.signal_outbox_consumer_delete`,
  `units.policy:${T}.signal_outbox_consumer_select`,
  `units.trigger:${T}.simetra_signal_outbox_notify`,
  `units.trigger:${T}.simetra_signal_outbox_stamp`,
].map(extra)

const DATA = { plan: PLAN, differences: DIFFERENCES }

const EXACT = {
  foreignActions: [],
  foreignDifferences: [],
  unplanned: [],
  undifferenced: [],
}

/** Очікувані об'єкти моделі SHOP: без «Користувачів», схема — стану. */
async function expected(provider: DatabaseProvider): Promise<string[]> {
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
      expect(objects).not.toContain("sequence:simetra.row_version")
      expect(objects).toContain(`table:${T}`)
      expect(installMismatch(DATA, objects)).toEqual(EXACT)
    }
  )

  it("an install object the diff does not name is a mismatch", async () => {
    const objects = await expected("postgres")
    const without = (prefix: string) => ({
      plan: PLAN.filter((a) => !a.produces.some((id) => id.startsWith(prefix))),
      differences: DIFFERENCES.filter((d) => !d.path.includes(prefix)),
    })
    const trigger = `trigger:${T}.simetra_signal_outbox_notify`
    expect(installMismatch(without(trigger), objects)).toEqual({
      ...EXACT,
      unplanned: [trigger],
      undifferenced: [trigger],
    })
  })

  it("an action or a difference outside the install is a mismatch", async () => {
    const objects = await expected("postgres")
    const foreign = action(["table:simetra.receipts"], ["schema:simetra"])
    const schemaGrant = action([], ["schema:simetra", "role:simetra_command"])
    const own = extra(
      "units.grant:grant:table:app.orders:simetra_command:select"
    )
    expect(
      installMismatch(
        {
          plan: [...PLAN, foreign, schemaGrant],
          differences: [...DIFFERENCES, own],
        },
        objects
      )
    ).toEqual({
      ...EXACT,
      foreignActions: [foreign, schemaGrant],
      foreignDifferences: [own.path],
    })
  })

  it("an install object the derived set lacks turns the diff foreign", async () => {
    const objects = (await expected("postgres")).filter((o) => o !== F.prune)
    const mismatch = installMismatch(DATA, objects)
    expect(mismatch.foreignActions).toHaveLength(2)
    expect(mismatch.foreignDifferences).toEqual([
      `units.${F.prune}`,
      "units.grant:revoke:function:simetra.signal_outbox_prune(interval):public:execute",
    ])
  })
})
