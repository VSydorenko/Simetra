import {
  ZERO_UUID,
  channelTopic,
  type CatalogEntry,
  type RightsRow,
  type RightsSnapshot,
} from "simetra/model"
import { describe, expect, it } from "vitest"
import { catalogEntry } from "../../../model/runtime/__tests__/entries"
import { canSubscribe, readAllowed } from "../rights"

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
    rightsContract: true,
    ...over,
  })
const unscoped = (over: Partial<CatalogEntry> = {}): CatalogEntry => {
  const entry: CatalogEntry = { ...scoped({ id: PLAIN }), ...over }
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
): RightsSnapshot => ({ userId, scopeSets, rights })

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
    ["верхній регістр", snap([row()]), topic().toUpperCase(), false],
    ["userId null", snap([row()], undefined, null), topic(), false],
    [
      "канал прав",
      snap([row()]),
      channelTopic({ kind: "rights", scopeKindId: KIND, scope: SCOPE }),
      false,
    ],
    [
      "канал користувача",
      snap([row()]),
      channelTopic({ kind: "user", userId: USER }),
      false,
    ],
    ["чужий формат", snap([row()]), `other:${KIND}:${SCOPE}:${OBJECT}`, false],
  ]
  it.each(cases)("%s", (_name, snapshot, channel, expected) => {
    expect(canSubscribe(snapshot, channel, catalog)).toBe(expected)
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

  it("пара без скоупу для скоупленого — ні", () => {
    expect(readAllowed(snap([row()]), { scope: null }, scoped())).toBe(false)
  })

  it("об'єкт без rightsContract — так", () => {
    const entry = scoped({ rightsContract: undefined })
    expect(readAllowed(snap([], []), pair, entry)).toBe(true)
  })

  it("publicRead — так", () => {
    expect(
      readAllowed(snap([], []), pair, scoped({ publicRead: "authenticated" }))
    ).toBe(true)
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
