/** The platform's standard action vocabulary. */
export const STANDARD_ACTIONS = [
  "read",
  "create",
  "update",
  "markDeletion",
  "delete",
  "post",
  "unpost",
  "write",
] as const

/** A word of the platform's standard action vocabulary. */
export type StandardAction = (typeof STANDARD_ACTIONS)[number]

/** A DML statement kind an action performs on the object's own table. */
export type Dml = "insert" | "update" | "delete"

/**
 * What an action writes itself. A requirement carries no effects: an action
 * that requires `update` does not inherit its writes.
 */
export interface ActionEffects {
  dml: readonly Dml[]
  /** `"all"` — every header column; otherwise canonical column names. */
  header: "all" | readonly string[]
  tabularSections: boolean
}

/** A standard action of a kind with its direct requirements and effects. */
export interface KindAction {
  name: StandardAction
  /** Direct edges of the kind only, without the general `read` edge. */
  requires: readonly StandardAction[]
  effects: ActionEffects
  // Факт реєстру, а не гілка за видом (спека прав §3): регістр не має
  // `create`/`update`/`delete`, лише `write`, а константа вставляє через
  // `update`.
  /**
   * The natural action of its DML: it covers `effects.dml` for the rows that
   * are not the command's root row. At most one such action per DML.
   */
  natural?: true
  /**
   * A transition action: the one header column it changes and the direction.
   * Without `from`/`to` there is no direction (`markDeletion` goes both
   * ways). Neither `"all"` nor a custom action touches a transition column.
   */
  transition?: { column: string; from?: boolean; to?: boolean }
}

/** The extent forms a kind can restrict an action to (rights contract). */
export type RightsExtentForm = "any" | "own" | "dimension"

const NO_EFFECTS: ActionEffects = {
  dml: [],
  header: [],
  tabularSections: false,
}

export const readAction: KindAction = {
  name: "read",
  requires: [],
  effects: NO_EFFECTS,
}

export const deleteAction: KindAction = {
  name: "delete",
  requires: [],
  effects: { dml: ["delete"], header: [], tabularSections: false },
  natural: true,
}

export const markDeletionAction: KindAction = {
  name: "markDeletion",
  requires: [],
  effects: {
    dml: ["update"],
    header: ["deletionMark"],
    tabularSections: false,
  },
  transition: { column: "deletionMark" },
}

export function createAction(tabularSections: boolean): KindAction {
  return {
    name: "create",
    requires: [],
    effects: { dml: ["insert"], header: "all", tabularSections },
    natural: true,
  }
}

export function updateAction(
  tabularSections: boolean,
  dml: readonly Dml[] = ["update"]
): KindAction {
  return {
    name: "update",
    requires: [],
    effects: { dml, header: "all", tabularSections },
    natural: true,
  }
}

// Рухи пише оболонка проведення привілейованим шляхом, а не дія, тож ефект
// post/unpost — лише ознака проведення в шапці.
export const postAction: KindAction = {
  name: "post",
  requires: ["update"],
  effects: { dml: ["update"], header: ["posted"], tabularSections: false },
  transition: { column: "posted", from: false, to: true },
}

export const unpostAction: KindAction = {
  name: "unpost",
  requires: ["post"],
  effects: { dml: ["update"], header: ["posted"], tabularSections: false },
  transition: { column: "posted", from: true, to: false },
}

export const writeAction: KindAction = {
  name: "write",
  requires: [],
  effects: {
    dml: ["insert", "update", "delete"],
    header: "all",
    tabularSections: false,
  },
  natural: true,
}

/** The reference vocabulary of a record kind: read plus the four writes. */
export function recordActions(tabularSections: boolean): readonly KindAction[] {
  return [
    readAction,
    createAction(tabularSections),
    updateAction(tabularSections),
    markDeletionAction,
    deleteAction,
  ]
}

/**
 * Direct requirements of an action plus the general edge: every action that
 * writes something requires `read`.
 */
export function actionRequires(action: {
  requires: readonly string[]
  effects: ActionEffects
}): string[] {
  const edges = [...action.requires]
  // Загальне ребро: без права читати рядок писати його нема сенсу.
  if (action.effects.dml.length > 0 && !edges.includes("read")) {
    edges.push("read")
  }
  return edges
}

/**
 * Transitive closure of requirements: every action maps to the sorted set of
 * actions it needs, without itself. Throws on a cycle; the compiler rejects
 * cycles earlier with a diagnostic.
 */
export function closeRequires(
  actions: readonly { name: string; requires: readonly string[] }[]
): ReadonlyMap<string, readonly string[]> {
  const direct = new Map(actions.map((a) => [a.name, a.requires]))
  const closed = new Map<string, readonly string[]>()
  const visiting = new Set<string>()
  const close = (name: string): readonly string[] => {
    const known = closed.get(name)
    if (known !== undefined) return known
    if (visiting.has(name)) throw new Error(`requires cycle at "${name}"`)
    visiting.add(name)
    const all = new Set<string>()
    for (const edge of direct.get(name) ?? []) {
      all.add(edge)
      for (const deeper of close(edge)) all.add(deeper)
    }
    visiting.delete(name)
    all.delete(name)
    const sorted = [...all].sort()
    closed.set(name, sorted)
    return sorted
  }
  for (const a of actions) close(a.name)
  return closed
}
