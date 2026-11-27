import {
  ZERO_UUID,
  channelTopic,
  type CatalogEntry,
  type RightsRow,
  type RightsSnapshot,
} from "simetra/model"
import { describe, expect, it } from "vitest"
import {
  catalogEntry,
  catalogRights,
} from "../../../model/runtime/__tests__/entries"
import { can, canSubscribe, deniesSomePair, readAllowed } from "../rights"

const KIND = "00000000-0000-4000-8000-0000000000c1"
const SCOPE = "00000000-0000-4000-8000-0000000000c2"
const OTHER = "00000000-0000-4000-8000-0000000000c3"
const OBJECT = "00000000-0000-4000-8000-0000000000c4"
const PLAIN = "00000000-0000-4000-8000-0000000000c5"
const USER = "00000000-0000-4000-8000-0000000000c6"
const LABEL = "task"

const scoped = (over: Partial<CatalogEntry> = {}): CatalogEntry =>
  catalogEntry({
    id: OBJECT,
    kindLabel: LABEL,
    scopeKindId: KIND,
    signal: true,
    rights: catalogRights(),
    ...over,
  })
const unscoped = (over: Partial<CatalogEntry> = {}): CatalogEntry => {
  // Контракт нескоупленого: без межі тенанта й множини скоупів.
  const rights = catalogRights({ readBoundary: [] })
  delete rights.scopeSet
  const entry: CatalogEntry = { ...scoped({ id: PLAIN, rights }), ...over }
  delete entry.scopeKindId
  delete entry.scopeColumn
  return entry
}

const row = (over: Partial<RightsRow> = {}): RightsRow => ({
  level: "scope",
  levelId: null,
  scope: SCOPE,
  container: null,
  object: LABEL,
  action: "read",
  extent: "any",
  dimensionId: null,
  ...over,
})
const snap = (
  rights: RightsRow[],
  scopeSets = [{ scopeKind: KIND, scope: SCOPE }],
  userId: string | null = USER
): RightsSnapshot => ({
  userId,
  scopeSets,
  rights,
  members: [],
  dimensionValues: [],
})

const topic = (object = OBJECT, scope = SCOPE, kind = KIND) =>
  channelTopic({ kind: "changes", scopeKindId: kind, scope, object })

describe("canSubscribe", () => {
  const catalog = { objects: [scoped(), unscoped()] }
  const cases: [string, RightsSnapshot, string, boolean][] = [
    ["свій скоуп з правом", snap([row()]), topic(), true],
    ["обсяг own", snap([row({ extent: "own" })]), topic(), true],
    [
      "обсяг виміру",
      snap([row({ extent: "dimension", dimensionId: OTHER })]),
      topic(),
      true,
    ],
    ["учасник без read", snap([row({ action: "update" })]), topic(), false],
    ["право на чужу мітку", snap([row({ object: "other" })]), topic(), false],
    ["чужий скоуп", snap([row()]), topic(OBJECT, OTHER), false],
    ["скоуп поза scopeSets, але рядок є", snap([row()], []), topic(), false],
    [
      "scopeSets іншого виду",
      snap([row()], [{ scopeKind: OTHER, scope: SCOPE }]),
      topic(),
      false,
    ],
    [
      "рядок права чужого скоупу",
      snap([row({ scope: OTHER })]),
      topic(),
      false,
    ],
    [
      "лише контейнер, скоуплений",
      snap([row({ level: "container", container: OTHER })]),
      topic(),
      false,
    ],
    [
      "роль рівня global на скоупленому",
      snap([row({ level: "global", scope: null })]),
      topic(),
      false,
    ],
    [
      "роль everyUser на скоупленому",
      snap([row({ level: "everyUser", scope: null })]),
      topic(),
      false,
    ],
    [
      "нескоуплений з global",
      snap([row({ level: "global", scope: null })], []),
      topic(PLAIN, ZERO_UUID, ZERO_UUID),
      true,
    ],
    [
      "нескоуплений з everyUser",
      snap([row({ level: "everyUser", scope: null })], []),
      topic(PLAIN, ZERO_UUID, ZERO_UUID),
      true,
    ],
    [
      "нескоуплений з own",
      snap([row({ level: "global", scope: null, extent: "own" })], []),
      topic(PLAIN, ZERO_UUID, ZERO_UUID),
      true,
    ],
    [
      "нескоуплений з роллю рівня скоупу",
      snap([row()], []),
      topic(PLAIN, ZERO_UUID, ZERO_UUID),
      true,
    ],
    [
      "нескоуплений лише контейнер",
      snap([row({ level: "container", container: OTHER })], []),
      topic(PLAIN, ZERO_UUID, ZERO_UUID),
      false,
    ],
    [
      "нескоуплений, скоуп не нульовий",
      snap([row()], []),
      topic(PLAIN, SCOPE, ZERO_UUID),
      false,
    ],
    [
      "нескоуплений, вид не нульовий",
      snap([row()], []),
      topic(PLAIN, ZERO_UUID, KIND),
      false,
    ],
    [
      "вид топіка ≠ вид об'єкта",
      snap([row()]),
      topic(OBJECT, SCOPE, OTHER),
      false,
    ],
    ["невідомий об'єкт", snap([row()]), topic(OTHER), false],
    [
      "верхній регістр",
      snap([row()]),
      `simetra:${KIND.toUpperCase()}:${SCOPE.toUpperCase()}:${OBJECT.toUpperCase()}`,
      false,
    ],
    ["userId null", snap([row()], undefined, null), topic(), false],
    // Канали прав (Р11 плану B6-2, перенесено в B6-1): межа тенанта без
    // умови права, глобальний — дійсному, користувача — лише свій.
    [
      "канал прав свого скоупу без прав",
      snap([]),
      channelTopic({ kind: "rights", scopeKindId: KIND, scope: SCOPE }),
      true,
    ],
    [
      "канал прав скоупу поза scopeSets",
      snap([row()]),
      channelTopic({ kind: "rights", scopeKindId: KIND, scope: OTHER }),
      false,
    ],
    [
      "канал прав виду поза scopeSets",
      snap([row()]),
      channelTopic({ kind: "rights", scopeKindId: OTHER, scope: SCOPE }),
      false,
    ],
    [
      "канал прав з нульовим лише видом",
      snap([row()]),
      channelTopic({ kind: "rights", scopeKindId: ZERO_UUID, scope: SCOPE }),
      false,
    ],
    [
      "канал прав з нульовим лише скоупом",
      snap([row()]),
      channelTopic({ kind: "rights", scopeKindId: KIND, scope: ZERO_UUID }),
      false,
    ],
    [
      "глобальний канал прав без членства",
      snap([], []),
      channelTopic({
        kind: "rights",
        scopeKindId: ZERO_UUID,
        scope: ZERO_UUID,
      }),
      true,
    ],
    [
      "глобальний канал прав, userId null",
      snap([], [], null),
      channelTopic({
        kind: "rights",
        scopeKindId: ZERO_UUID,
        scope: ZERO_UUID,
      }),
      false,
    ],
    [
      "канал прав свого скоупу, userId null",
      snap([row()], undefined, null),
      channelTopic({ kind: "rights", scopeKindId: KIND, scope: SCOPE }),
      false,
    ],
    [
      "свій канал користувача",
      snap([]),
      channelTopic({ kind: "user", userId: USER }),
      true,
    ],
    [
      "чужий канал користувача",
      snap([row()]),
      channelTopic({ kind: "user", userId: OTHER }),
      false,
    ],
    ["чужий формат", snap([row()]), `other:${KIND}:${SCOPE}:${OBJECT}`, false],
  ]
  it.each(cases)("%s", (_name, snapshot, channel, expected) => {
    expect(canSubscribe(snapshot, channel, catalog)).toBe(expected)
  })

  describe("корінь виду скоупу", () => {
    // Корінь несе скоуп у власному id: топік скоупу — id рядка кореня.
    const root = { objects: [scoped({ scopeColumn: "id" })] }
    it("свій корінь", () => {
      expect(canSubscribe(snap([row()]), topic(OBJECT, SCOPE), root)).toBe(true)
    })
    it("чужий корінь", () => {
      expect(canSubscribe(snap([row()]), topic(OBJECT, OTHER), root)).toBe(
        false
      )
    })
  })

  it("несигнальний об'єкт", () => {
    const users = { objects: [scoped({ signal: false })] }
    expect(canSubscribe(snap([row()]), topic(), users)).toBe(false)
  })

  it("publicRead скоупленого: без скоупу й права, лише користувач", () => {
    const open = { objects: [scoped({ publicRead: "anon" })] }
    expect(canSubscribe(snap([], []), topic(OBJECT, OTHER), open)).toBe(true)
    expect(canSubscribe(snap([], [], null), topic(OBJECT, OTHER), open)).toBe(
      false
    )
    // Вид топіка все одно мусить збігтися.
    expect(canSubscribe(snap([]), topic(OBJECT, SCOPE, OTHER), open)).toBe(
      false
    )
  })

  it("publicRead нескоупленого: лише нульовий скоуп", () => {
    const open = { objects: [unscoped({ publicRead: "authenticated" })] }
    expect(
      canSubscribe(snap([], []), topic(PLAIN, ZERO_UUID, ZERO_UUID), open)
    ).toBe(true)
    expect(
      canSubscribe(snap([], []), topic(PLAIN, SCOPE, ZERO_UUID), open)
    ).toBe(false)
  })
})

describe("readAllowed", () => {
  const pair = { scope: SCOPE }
  const cases: [string, RightsSnapshot, boolean][] = [
    ["скоуплений: рядок scope", snap([row()]), true],
    ["скоуплений: обсяг own", snap([row({ extent: "own" })]), true],
    [
      "скоуплений: контейнерний рядок цього скоупу",
      snap([row({ level: "container", container: OTHER })]),
      true,
    ],
    [
      "скоуплений: контейнерний рядок чужого скоупу",
      snap([row({ level: "container", container: OTHER, scope: OTHER })]),
      false,
    ],
    [
      "скоуплений: global зі скоупом у рядку не відкриває",
      snap([row({ level: "global" })]),
      false,
    ],
    [
      "скоуплений: everyUser зі скоупом у рядку не відкриває",
      snap([row({ level: "everyUser" })]),
      false,
    ],
    ["скоуплений: без read", snap([row({ action: "update" })]), false],
    ["скоуплений: чужа мітка", snap([row({ object: "x" })]), false],
    ["скоуплений: рядок чужого скоупу", snap([row({ scope: OTHER })]), false],
    ["скоуплений: скоуп поза scopeSets", snap([row()], []), false],
    [
      "скоуплений: global не відкриває",
      snap([row({ level: "global", scope: null })]),
      false,
    ],
    [
      "скоуплений: everyUser не відкриває",
      snap([row({ level: "everyUser", scope: null })]),
      false,
    ],
  ]
  it.each(cases)("%s", (_name, snapshot, expected) => {
    expect(readAllowed(snapshot, pair, scoped())).toBe(expected)
  })

  it("корінь: свій — так, чужий — ні", () => {
    const root = scoped({ scopeColumn: "id" })
    expect(readAllowed(snap([row()]), { scope: SCOPE }, root)).toBe(true)
    expect(readAllowed(snap([row()]), { scope: OTHER }, root)).toBe(false)
  })

  it("пара без скоупу для скоупленого — ні", () => {
    expect(readAllowed(snap([row()]), { scope: null }, scoped())).toBe(false)
  })

  it("об'єкт без контракту rights — так", () => {
    const entry = scoped()
    delete entry.rights
    expect(readAllowed(snap([], []), pair, entry)).toBe(true)
  })

  it.each<[string, string | null, "anon" | "authenticated", boolean]>([
    ["користувач і authenticated", USER, "authenticated", true],
    ["користувач і anon", USER, "anon", true],
    ["гість і anon", null, "anon", true],
    ["гість і authenticated", null, "authenticated", false],
  ])("publicRead: %s", (_, userId, publicRead, expected) => {
    expect(
      readAllowed(snap([], [], userId), pair, scoped({ publicRead }))
    ).toBe(expected)
  })

  const free = { scope: ZERO_UUID }
  it.each<[string, RightsRow[], boolean]>([
    ["нескоуплений: global", [row({ level: "global", scope: null })], true],
    [
      "нескоуплений: everyUser",
      [row({ level: "everyUser", scope: null })],
      true,
    ],
    [
      "нескоуплений: контейнерний рядок",
      [row({ level: "container", container: OTHER })],
      true,
    ],
    ["нескоуплений: без рядків", [], false],
    ["нескоуплений: без read", [row({ action: "update" })], false],
  ])("%s", (_name, rights, expected) => {
    expect(readAllowed(snap(rights, []), free, unscoped())).toBe(expected)
  })
})

describe("deniesSomePair", () => {
  it("a scoped object without publicRead: scopes outside the snapshot are denied", () => {
    expect(deniesSomePair(snap([row()]), scoped())).toBe(true)
  })

  it("a scoped object opened by publicRead: no pair is denied", () => {
    expect(
      deniesSomePair(snap([]), scoped({ publicRead: "authenticated" }))
    ).toBe(false)
  })

  it("an unscoped object: its one pair, by the read right", () => {
    expect(
      deniesSomePair(snap([row({ scope: null, level: "global" })]), unscoped())
    ).toBe(false)
    expect(deniesSomePair(snap([]), unscoped())).toBe(true)
  })

  it("an object without a rights contract: none", () => {
    const entry = scoped()
    delete entry.rights
    expect(deniesSomePair(snap([]), entry)).toBe(false)
  })
})

describe("can", () => {
  const MEMBER = "00000000-0000-4000-8000-0000000000d1"
  const DIM = "00000000-0000-4000-8000-0000000000d2"
  const VALUE = "00000000-0000-4000-8000-0000000000d3"
  const BOX = "00000000-0000-4000-8000-0000000000d4"
  const ASSIGNEE = { attribute: "assignee" }
  const REGION = { attribute: "region" }
  const PROJECT = { attribute: "project" }

  const rich = (over: Partial<ReturnType<typeof catalogRights>> = {}) =>
    catalogRights({
      actions: [
        {
          action: "update",
          extents: [
            { form: "any" },
            { form: "own" },
            { form: "dimension", dimensionId: DIM },
          ],
        },
        { action: "read", extents: [{ form: "any" }] },
      ],
      ownership: [{ carrier: ASSIGNEE, owner: { scopeKind: KIND } }],
      access: [{ dimensionId: DIM, carrier: REGION, fresh: true }],
      binding: { containerId: BOX, carrier: PROJECT },
      ...over,
    })
  const withRich = (over = {}) => scoped({ rights: rich(over) })
  const update = (r: Partial<RightsRow>) => row({ action: "update", ...r })
  const mineSnap = (
    rights: RightsRow[],
    over: Partial<RightsSnapshot> = {}
  ): RightsSnapshot => ({
    ...snap(rights),
    members: [{ scopeKind: KIND, scope: SCOPE, member: MEMBER }],
    dimensionValues: [{ dimension: DIM, values: [VALUE] }],
    ...over,
  })
  const at = { scope: SCOPE }

  it("any: a scope row answers, no row means a right to something", () => {
    const entry = withRich()
    expect(can(mineSnap([update({})]), entry, "update", at)).toBe(true)
    expect(can(mineSnap([]), entry, "update", at)).toBe(false)
  })

  it("a global or everyUser row does not open a scoped object", () => {
    const entry = withRich()
    for (const level of ["global", "everyUser"])
      expect(
        can(mineSnap([update({ level, scope: null })]), entry, "update", at)
      ).toBe(false)
  })

  it("a scope outside scopeSets is false", () => {
    const rows = [update({ scope: OTHER })]
    expect(can(mineSnap(rows), withRich(), "update", { scope: OTHER })).toBe(
      false
    )
  })

  it("own: the carrier against my members and the user", () => {
    const entry = withRich()
    const rows = [update({ extent: "own" })]
    const opts = (assignee: unknown) => ({ ...at, row: { assignee } })
    expect(can(mineSnap(rows), entry, "update", opts(MEMBER))).toBe(true)
    expect(can(mineSnap(rows), entry, "update", opts(OTHER))).toBe(false)
    expect(can(mineSnap(rows), entry, "update", opts(null))).toBe(false)
    expect(can(mineSnap(rows), entry, "update", { ...at, row: {} })).toBe(
      "unknown"
    )
    expect(can(mineSnap(rows), entry, "update", at)).toBe(true)
  })

  it("own by users compares with userId", () => {
    const entry = withRich({
      ownership: [{ carrier: ASSIGNEE, owner: { users: true } }],
    })
    const rows = [update({ extent: "own" })]
    expect(
      can(mineSnap(rows), entry, "update", { ...at, row: { assignee: USER } })
    ).toBe(true)
  })

  it("a dimension: the carrier against my values", () => {
    const entry = withRich()
    const rows = [update({ extent: "dimension", dimensionId: DIM })]
    const opts = (region: unknown) => ({ ...at, row: { region } })
    expect(can(mineSnap(rows), entry, "update", opts(VALUE))).toBe(true)
    expect(can(mineSnap(rows), entry, "update", opts(OTHER))).toBe(false)
  })

  it("a dimension: truncated values and a missing carrier are unknown", () => {
    const entry = withRich()
    const rows = [update({ extent: "dimension", dimensionId: DIM })]
    const truncated = mineSnap(rows, {
      dimensionValues: [
        { dimension: DIM, values: [], truncated: true, digest: "a".repeat(64) },
      ],
    })
    expect(
      can(truncated, entry, "update", { ...at, row: { region: OTHER } })
    ).toBe("unknown")
    expect(can(mineSnap(rows), entry, "update", { ...at, row: {} })).toBe(
      "unknown"
    )
  })

  it("a dimension with a stale relation: unknown only from the stale part", () => {
    const entry = withRich({
      access: [{ dimensionId: DIM, carrier: REGION, fresh: false }],
    })
    // Права свіжі за сигналом: без рядка гранту відповідь хибна
    expect(can(mineSnap([]), entry, "update", at)).toBe(false)
    expect(
      can(mineSnap([]), entry, "update", { ...at, row: { region: VALUE } })
    ).toBe(false)
    const rows = [update({ extent: "dimension", dimensionId: DIM })]
    expect(can(mineSnap(rows), entry, "update", at)).toBe(true)
    expect(
      can(mineSnap(rows), entry, "update", { ...at, row: { region: VALUE } })
    ).toBe("unknown")
    // Контейнерна гілка того самого виміру теж лише з нестабільним носієм
    const container = [
      update({
        extent: "dimension",
        dimensionId: DIM,
        level: "container",
        container: BOX,
      }),
    ]
    expect(
      can(mineSnap(container), entry, "update", {
        ...at,
        row: { region: VALUE, project: BOX },
      })
    ).toBe("unknown")
  })

  it("a container branch: a container row and the bound container", () => {
    const entry = withRich()
    const rows = [update({ level: "container", scope: SCOPE, container: BOX })]
    const opts = (project: unknown) => ({ ...at, row: { project } })
    expect(can(mineSnap(rows), entry, "update", opts(BOX))).toBe(true)
    expect(can(mineSnap(rows), entry, "update", opts(OTHER))).toBe(false)
    // Без рядка — право в якомусь контейнері скоупу, без умов носіїв.
    expect(can(mineSnap(rows), entry, "update", at)).toBe(true)
    expect(can(mineSnap([]), entry, "update", at)).toBe(false)
  })

  it("a missing container carrier is unknown only where a container row exists", () => {
    const entry = withRich()
    const rows = [update({ level: "container", scope: SCOPE, container: BOX })]
    const opts = { ...at, row: {} }
    expect(can(mineSnap(rows), entry, "update", opts)).toBe("unknown")
    expect(can(mineSnap([]), entry, "update", opts)).toBe(false)
  })

  it("a container right in another scope gives nothing, with and without a row", () => {
    const entry = withRich()
    const rows = [update({ level: "container", scope: OTHER, container: BOX })]
    const snapshot = mineSnap(rows, {
      scopeSets: [
        { scopeKind: KIND, scope: SCOPE },
        { scopeKind: KIND, scope: OTHER },
      ],
    })
    expect(can(snapshot, entry, "update", at)).toBe(false)
    expect(
      can(snapshot, entry, "update", { ...at, row: { project: BOX } })
    ).toBe(false)
    expect(can(snapshot, entry, "update", { scope: OTHER })).toBe(true)
  })

  it("without a row a dimension branch needs values to pass", () => {
    const rows = [update({ extent: "dimension", dimensionId: DIM })]
    const empty = mineSnap(rows, {
      dimensionValues: [{ dimension: DIM, values: [] }],
    })
    const fresh = withRich()
    const stale = withRich({
      access: [{ dimensionId: DIM, carrier: REGION, fresh: false }],
    })
    expect(can(empty, fresh, "update", at)).toBe(false)
    expect(can(empty, stale, "update", at)).toBe("unknown")
    const truncated = mineSnap(rows, {
      dimensionValues: [
        { dimension: DIM, values: [], truncated: true, digest: "a".repeat(64) },
      ],
    })
    expect(can(truncated, fresh, "update", at)).toBe(true)
    expect(can(mineSnap(rows), fresh, "update", at)).toBe(true)
  })

  it("a container branch with own needs the own carrier too", () => {
    const entry = withRich()
    const rows = [
      update({
        level: "container",
        scope: SCOPE,
        container: BOX,
        extent: "own",
      }),
    ]
    const row = (assignee: string) => ({ project: BOX, assignee })
    expect(
      can(mineSnap(rows), entry, "update", { ...at, row: row(MEMBER) })
    ).toBe(true)
    expect(
      can(mineSnap(rows), entry, "update", { ...at, row: row(OTHER) })
    ).toBe(false)
  })

  it("an unscoped object: any non-container level", () => {
    const rights = catalogRights({ readBoundary: [] })
    delete rights.scopeSet
    const entry = unscoped({ rights })
    const global = row({ level: "global", scope: null })
    expect(can(snap([global]), entry, "read")).toBe(true)
    expect(
      can(
        snap([{ ...global, level: "container", container: BOX }]),
        entry,
        "read"
      )
    ).toBe(false)
  })

  it("create of a root: a grant of any level but a container, no scope", () => {
    const entry = withRich({
      actions: [
        { action: "create", extents: [{ form: "any" }, { form: "own" }] },
      ],
      root: { author: ASSIGNEE },
    })
    const create = (r: Partial<RightsRow>) => row({ action: "create", ...r })
    expect(
      can(mineSnap([create({ level: "global", scope: null })]), entry, "create")
    ).toBe(true)
    expect(
      can(
        mineSnap([create({ level: "container", container: BOX })]),
        entry,
        "create"
      )
    ).toBe(false)
    // `own` — лише коли автор — я.
    const own = [create({ extent: "own", level: "global", scope: null })]
    expect(
      can(mineSnap(own), entry, "create", { row: { assignee: MEMBER } })
    ).toBe(true)
    expect(
      can(mineSnap(own), entry, "create", { row: { assignee: OTHER } })
    ).toBe(false)
  })

  it("create of a root with own: only the author carrier counts, not another owner", () => {
    const entry = withRich({
      actions: [{ action: "create", extents: [{ form: "own" }] }],
      ownership: [
        { carrier: ASSIGNEE, owner: { scopeKind: KIND } },
        { carrier: { attribute: "owner" }, owner: { users: true } },
      ],
      root: { author: ASSIGNEE },
    })
    const own = [
      row({ action: "create", extent: "own", level: "global", scope: null }),
    ]
    const row_ = (assignee: string, owner: string) => ({ assignee, owner })
    expect(
      can(mineSnap(own), entry, "create", { row: row_(MEMBER, OTHER) })
    ).toBe(true)
    expect(
      can(mineSnap(own), entry, "create", { row: row_(OTHER, USER) })
    ).toBe(false)
  })

  it("a custom action is judged by its own rows and extents", () => {
    const entry = withRich({
      actions: [
        { action: "reassign", extents: [{ form: "any" }, { form: "own" }] },
      ],
    })
    const rows = [row({ action: "reassign", extent: "own" })]
    const opts = (assignee: string) => ({ ...at, row: { assignee } })
    expect(can(mineSnap(rows), entry, "reassign", opts(MEMBER))).toBe(true)
    expect(can(mineSnap(rows), entry, "reassign", opts(OTHER))).toBe(false)
    expect(can(mineSnap([row()]), entry, "reassign", opts(MEMBER))).toBe(false)
  })

  it("a key carrier: the row key against the user", () => {
    const entry = withRich({
      ownership: [{ carrier: { key: true }, owner: { users: true } }],
      actions: [{ action: "update", extents: [{ form: "own" }] }],
    })
    const rows = [update({ extent: "own" })]
    const opts = (key: string) => ({ ...at, row: { ref: key } })
    expect(can(mineSnap(rows), entry, "update", opts(USER))).toBe(true)
    expect(can(mineSnap(rows), entry, "update", opts(OTHER))).toBe(false)
  })

  it("publicRead opens read for a valid user and lifts the tenant boundary", () => {
    const entry = withRich({}) as CatalogEntry
    const open = { ...entry, publicRead: "authenticated" as const }
    expect(can(mineSnap([]), open, "read", { scope: OTHER })).toBe(true)
    expect(can(snap([], [], null), open, "read", at)).toBe(false)
    expect(can(mineSnap([]), entry, "read", at)).toBe(false)
  })

  it("a verbatim scope set: only the tenant boundary is unknown", () => {
    const entry = withRich({ scopeSet: "verbatim" })
    expect(can(mineSnap([update({})]), entry, "update", at)).toBe("unknown")
    // Права свіжі: без гранту хибно, `unknown` лише від межі тенанта
    expect(can(mineSnap([]), entry, "update", { scope: OTHER })).toBe(false)
  })

  it("an adopted membership of the kind: unknown, publicRead is not exempt", () => {
    const facts = { membershipKinds: [KIND] }
    const entry = withRich()
    expect(can(mineSnap([update({})]), entry, "update", at, facts)).toBe(
      "unknown"
    )
    const open = { ...entry, publicRead: "authenticated" as const }
    expect(can(mineSnap([]), open, "read", at, facts)).toBe("unknown")
    // Членство іншого виду об'єкта не торкається.
    expect(
      can(mineSnap([update({})]), entry, "update", at, {
        membershipKinds: [OTHER],
      })
    ).toBe(true)
  })

  it("adopted assignments make every grant branch unknown, any level", () => {
    const facts = { membershipKinds: [], assignments: true as const }
    expect(
      can(
        mineSnap([update({ level: "container", container: BOX })]),
        withRich(),
        "update",
        { ...at, row: { project: BOX } },
        facts
      )
    ).toBe("unknown")
    expect(can(mineSnap([]), withRich(), "update", at, facts)).toBe("unknown")
  })

  it("an object without a contract is unknown", () => {
    const entry = scoped()
    delete entry.rights
    expect(can(snap([]), entry, "read", at)).toBe("unknown")
  })

  it("the users boundary: only the own row is certain", () => {
    const entry = withRich({ readBoundary: ["tenant", "users"] })
    const rows = [row()]
    expect(
      can(mineSnap(rows), entry, "read", { ...at, row: { ref: USER } })
    ).toBe(true)
    expect(
      can(mineSnap(rows), entry, "read", { ...at, row: { ref: OTHER } })
    ).toBe("unknown")
    expect(
      can(mineSnap([]), entry, "read", { ...at, row: { ref: OTHER } })
    ).toBe(false)
  })

  it("an unknown action has no branches", () => {
    expect(can(mineSnap([row()]), withRich(), "delete", at)).toBe(false)
  })

  it("a replaced snapshot changes the answer: no second cache", () => {
    const entry = withRich()
    expect(can(mineSnap([]), entry, "update", at)).toBe(false)
    expect(can(mineSnap([update({})]), entry, "update", at)).toBe(true)
  })
})
