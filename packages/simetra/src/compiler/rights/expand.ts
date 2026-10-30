import type {
  CompiledRoleLevel,
  ProjectionExtent,
  RightsContract,
  RightsProjectionRow,
} from "../contracts"
import { compareStrings, diagnostic, type Diagnostic } from "../diagnostics"
import { supportsExtent } from "./facts"

/**
 * Запис гранту з резолвленими цілями: об'єкти — id, дії — ключі контракту
 * (слово словника чи UUID кастомної дії), вимір обсягу — id. Невідомі цілі
 * вже відхилила стадія 4, тож тут їх немає.
 */
export interface ResolvedGrant {
  form: "grantAll" | "grant" | "deny"
  /** Файл декларації й позиція запису в `grants` — для діагностик. */
  file: string
  index: number
  /** Немає — `grantAll`. */
  objects?: { ids: readonly string[] } | { withAction: string }
  /** Ключі дій у порядку `actions`; порожньо в `grantAll`. */
  actions: readonly string[]
  /** Немає — `deny` без обсягу. */
  extent?: ProjectionExtent
}

/** Набір прав чи роль як джерело грантів: власні записи й прямі включення. */
export interface DeclarationInput {
  id: string
  grants: readonly ResolvedGrant[]
  /** Id прямо включених наборів у порядку `include`. */
  include: readonly string[]
}

/** Роль з рівнем і наборами її замикання включень. */
export interface RoleInput extends DeclarationInput {
  assignedOn: CompiledRoleLevel
  /** Усі набори замикання включень ролі. */
  sets: readonly DeclarationInput[]
}

export interface ExpandContext {
  /** Контракти прав за `objectId`: рівень бере об'єкти лише з них. */
  rights: ReadonlyMap<string, RightsContract>
  /** Імена об'єктів і вимірів за id — для параметрів діагностик. */
  objectNames: ReadonlyMap<string, string>
  dimensionNames: ReadonlyMap<string, string>
}

type Source = RightsProjectionRow["sources"][number]

interface Row {
  objectId: string
  action: string
  extent: ProjectionExtent
  sources: Map<string, Source>
  /** Перший запис, що дав рядок: на ньому стоїть `rights.requires-missing`. */
  origin: { file: string; pointer: string }
}

/** Ключ обсягу: `any`, `own` чи `dim:<id>`. */
function extentKey(extent: ProjectionExtent): string {
  return typeof extent === "string" ? extent : `dim:${extent.dimensionId}`
}

/** Порядок обсягів у проєкції: `any` < `own` < вимір за id. */
export function compareExtents(
  a: ProjectionExtent,
  b: ProjectionExtent
): number {
  const rank = (e: ProjectionExtent) => (e === "any" ? 0 : e === "own" ? 1 : 2)
  return rank(a) - rank(b) || compareStrings(extentKey(a), extentKey(b))
}

const sameExtent = (a: ProjectionExtent, b: ProjectionExtent) =>
  extentKey(a) === extentKey(b)

/**
 * Обсяг підтримано об'єктом. Обсяги дій об'єкта однакові — контракт бере їх
 * з `supportedExtents` — тож читання те саме, що в правилах стадії 4.
 */
const supports = (contract: RightsContract, extent: ProjectionExtent) =>
  contract.actions.some((a) => supportsExtent(a.extents, extent))

/**
 * Дії, які рівень ролі дозволяє на об'єкті; `undefined` — об'єкт поза
 * рівнем. Нескоуплений об'єкт роль скоупу лише читає (спека прав Рх7); глобальна
 * роль і «кожен користувач» покривають нескоуплені об'єкти — в однотенантному
 * проєкті це всі; контейнерна — прив'язані до свого контейнера (спека прав §4.3).
 * Спільне правило рівня для розгортання ролі й домену рівня функцій прав.
 */
export function allowedActions(
  level: CompiledRoleLevel,
  contract: RightsContract
): ReadonlySet<string> | undefined {
  // Довідник прав належить лише своєму рівню (спека прав §4.6): інакше роль скоупу
  // через `read` нескоуплених бачила б, хто адмін платформи.
  if (contract.system !== undefined && !ownRightsLevel(level, contract)) {
    return undefined
  }
  const all = new Set(contract.actions.map((a) => a.action))
  switch (level.level) {
    case "scope":
      if (contract.scopeKindId === level.scopeKindId) return all
      return contract.scopeKindId === undefined ? new Set(["read"]) : undefined
    case "global":
    case "everyUser":
      return contract.scopeKindId === undefined ? all : undefined
    case "container":
      return contract.binding?.containerId === level.containerId
        ? all
        : undefined
  }
}

/**
 * Рівень системного довідника прав — його власний скоуп (спека прав §4.6): вид скоупу
 * — роль цього виду, без скоупу — глобальна роль.
 */
function ownRightsLevel(
  level: CompiledRoleLevel,
  contract: RightsContract
): boolean {
  if (level.level === "scope") return contract.scopeKindId === level.scopeKindId
  return level.level === "global" && contract.scopeKindId === undefined
}

/** «Кожен користувач» не має обсягу `any`: рядки відкриває лише власність чи вимір (спека прав Рх7). */
export const levelAllowsExtent = (
  level: CompiledRoleLevel,
  extent: ProjectionExtent
) => level.level !== "everyUser" || extent !== "any"

/**
 * Розгортання ролі в рядки проєкції (спека прав §3, §4.1): гранти ролі й
 * наборів її замикання в межах рівня, породження `any` → `own` і виміри
 * (спека прав §4.4), `deny` ролі з точністю до обсягу (спека прав §4.1), перевірка вимог і злиття
 * однакових рядків з об'єднанням джерел. Перевірки, що не залежать
 * від рівня, уже зробила стадія 4; тут — лише ті, яких без рівня не видно.
 * Роль з `fullAccess` рядки має так само: її обхід перевірок — справа
 * функцій прав.
 */
export function expandRole(
  role: RoleInput,
  ctx: ExpandContext
): { rows: RightsProjectionRow[]; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = []
  const level = role.assignedOn
  const rows = new Map<string, Row>()
  const keyOf = (objectId: string, action: string, extent: ProjectionExtent) =>
    `${objectId}\u0000${action}\u0000${extentKey(extent)}`
  const objectName = (id: string) => ctx.objectNames.get(id) ?? id
  const extentName = (extent: ProjectionExtent) =>
    typeof extent === "string"
      ? extent
      : (ctx.dimensionNames.get(extent.dimensionId) ?? extent.dimensionId)
  const actionName = (contract: RightsContract, key: string) =>
    contract.actions.find((a) => a.action === key)?.name ?? key
  // Набір включають кілька ролей: ім'я ролі в параметрах розводить їхні
  // діагностики на тому самому місці набору, тож дедуплікація їх не зливає.
  const roleName = objectName(role.id)
  // Обсяг, якого рівень не має, — одна помилка на запис, а не на кожну дію.
  const extentLevelError = (grant: ResolvedGrant, extent: ProjectionExtent) =>
    diagnostic(
      "rights.grant-level",
      grant.file,
      `/grants/${grant.index}/${grant.form}/extent`,
      { level: level.level, extent: extentName(extent), role: roleName }
    )

  const add = (
    contract: RightsContract,
    action: string,
    extent: ProjectionExtent,
    sources: readonly Source[],
    origin: Row["origin"]
  ) => {
    const key = keyOf(contract.objectId, action, extent)
    let row = rows.get(key)
    if (row === undefined) {
      row = {
        objectId: contract.objectId,
        action,
        extent,
        sources: new Map(),
        origin,
      }
      rows.set(key, row)
    }
    for (const source of sources) row.sources.set(source.id, source)
  }
  // `X@any` дає й `X@own` та `X@<вимір>`: інакше `deny X@any` зняв би все, а
  // грант `any` не покривав би рядків, які відкриває вужчий обсяг (спека прав §4.4).
  const grantRow = (
    contract: RightsContract,
    action: string,
    extent: ProjectionExtent,
    sources: readonly Source[],
    origin: Row["origin"]
  ) => {
    add(contract, action, extent, sources, origin)
    if (extent !== "any") return
    if (supports(contract, "own")) add(contract, action, "own", sources, origin)
    for (const { dimensionId } of contract.access) {
      add(contract, action, { dimensionId }, sources, origin)
    }
  }

  // Пари (об'єкт, дія) запису `grant`/`deny`, які рівень дозволяє. Явний
  // перелік стадія 4 вже перевірила на дії й обсяги цілей, тож тут лишається
  // рівень; селектор за дією непридатні пари пропускає (спека прав §4.1).
  const resolve = (grant: ResolvedGrant) => {
    if (grant.extent !== undefined && !levelAllowsExtent(level, grant.extent)) {
      diagnostics.push(extentLevelError(grant, grant.extent))
      return []
    }
    const selector = grant.objects
    const found: { contract: RightsContract; action: string }[] = []
    if (selector === undefined) return found
    if ("withAction" in selector) {
      // Одне правило селектора: він бере об'єкти, де рівень дозволяє його дію,
      // і з дій запису лишає ті, що в об'єкта є, рівнем дозволені й мають
      // обсяг запису. Об'єкта запис не називав, тож непридатна пара — не
      // помилка, а просто не його пара; запис без рядків — теж не помилка.
      for (const contract of ctx.rights.values()) {
        // Системні довідники прав дає лише явний грант (спека прав §4.6).
        if (contract.system !== undefined) continue
        const allowed = allowedActions(level, contract)
        if (allowed?.has(selector.withAction) !== true) continue
        if (grant.extent !== undefined && !supports(contract, grant.extent)) {
          continue
        }
        for (const action of grant.actions) {
          if (allowed.has(action)) found.push({ contract, action })
        }
      }
      return found
    }
    for (const id of selector.ids) {
      const contract = ctx.rights.get(id)!
      const allowed = allowedActions(level, contract)
      grant.actions.forEach((action, position) => {
        if (allowed?.has(action) === true) {
          found.push({ contract, action })
          return
        }
        diagnostics.push(
          diagnostic(
            "rights.grant-level",
            grant.file,
            `/grants/${grant.index}/${grant.form}/actions/${position}`,
            {
              object: objectName(contract.objectId),
              action: actionName(contract, action),
              level: level.level,
              role: roleName,
            }
          )
        )
      })
    }
    return found
  }

  // Джерела рядка — роль і кожен набір на шляху від ролі до набору запису:
  // у ромбі набір дістався двома шляхами, і обидва — його джерела.
  const sets = new Map(role.sets.map((set) => [set.id, set]))
  const reaches = (from: DeclarationInput, target: string): boolean =>
    from.id === target ||
    from.include.some((id) => {
      const next = sets.get(id)
      return next !== undefined && reaches(next, target)
    })
  const sourcesOf = (declaration: DeclarationInput): Source[] => [
    { kind: "Role", id: role.id },
    ...role.sets
      .filter((set) => reaches(set, declaration.id))
      .map((set): Source => ({ kind: "RightsSet", id: set.id })),
  ]

  for (const declaration of [role, ...role.sets]) {
    const sources = sourcesOf(declaration)
    for (const grant of declaration.grants) {
      const origin = { file: grant.file, pointer: `/grants/${grant.index}` }
      if (grant.form === "deny") continue
      if (grant.form === "grantAll") {
        const extent = grant.extent!
        if (!levelAllowsExtent(level, extent)) {
          // Власний запис ролі суперечить її рівню — помилка; у наборі рівня
          // немає, тож набір під такою роллю просто нічого не дає (спека прав §4.1).
          if (declaration === role) {
            diagnostics.push(extentLevelError(grant, extent))
          }
          continue
        }
        // `grantAll` бере кожну дію, яку рівень дозволяє, і пропускає
        // об'єкти без обсягу (спека прав §4.1); кастомні дії теж — об'єкт один, тож
        // UUID однозначний.
        for (const contract of ctx.rights.values()) {
          // Системні довідники прав дає лише явний грант (спека прав §4.6).
          if (contract.system !== undefined) continue
          const allowed = allowedActions(level, contract)
          if (allowed === undefined || !supports(contract, extent)) continue
          for (const { action } of contract.actions) {
            if (allowed.has(action)) {
              grantRow(contract, action, extent, sources, origin)
            }
          }
        }
        continue
      }
      for (const { contract, action } of resolve(grant)) {
        grantRow(contract, action, grant.extent!, sources, origin)
      }
    }
  }

  // `deny` — лише власні записи ролі (набір його не має): перевіряється як
  // грант і віднімає після розгортання й породження (спека прав §4.1).
  for (const grant of role.grants) {
    if (grant.form !== "deny") continue
    for (const { contract, action } of resolve(grant)) {
      for (const [key, row] of rows) {
        if (row.objectId !== contract.objectId || row.action !== action) {
          continue
        }
        if (grant.extent === undefined || sameExtent(row.extent, grant.extent))
          rows.delete(key)
      }
    }
  }

  // Вимога `X ⇒ Y` для обсягу e виконана, коли є `Y@e` або `Y@any` (спека прав §4.4).
  for (const row of rows.values()) {
    // Поруч є `X@any`: якщо вимога не виконана тут, то й там (немає `Y@any`),
    // і помилка вже стоїть на `any` — одна на хибу, а не на кожен обсяг.
    if (
      row.extent !== "any" &&
      rows.has(keyOf(row.objectId, row.action, "any"))
    )
      continue
    const contract = ctx.rights.get(row.objectId)!
    const action = contract.actions.find((a) => a.action === row.action)!
    for (const required of action.requires) {
      const held =
        rows.has(keyOf(row.objectId, required, row.extent)) ||
        rows.has(keyOf(row.objectId, required, "any"))
      if (held) continue
      diagnostics.push(
        diagnostic(
          "rights.requires-missing",
          row.origin.file,
          row.origin.pointer,
          {
            object: objectName(row.objectId),
            action: action.name,
            requires: actionName(contract, required),
            extent: extentName(row.extent),
            role: roleName,
          }
        )
      )
    }
  }

  return {
    rows: [...rows.values()].map((row) => ({
      roleId: role.id,
      objectId: row.objectId,
      action: row.action,
      extent: row.extent,
      sources: [...row.sources.values()].sort((a, b) =>
        compareStrings(a.id, b.id)
      ),
    })),
    diagnostics,
  }
}
