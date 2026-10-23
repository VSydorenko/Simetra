import {
  KIND_REGISTRY,
  type PhysicalSnapshot,
  type RightsSystemCatalog,
} from "simetra/model"
import {
  mainTableOf,
  type CompiledRoleLevel,
  type Contracts,
  type QualifiedName,
  type RightsCatalogContract,
  type RightsLevelKey,
} from "../contracts"
import { compareStrings, diagnostic, type Diagnostic } from "../diagnostics"
import { PROJECT_FILE, type ParsedObject } from "../stages/files"
import { standardElementId, type ResolvedReference } from "../stages/identity"
import { membershipOfScopeKind, type RightsCheckContext } from "./checks"
import {
  customActionsOf,
  declarationsOf,
  levelKey,
  roleLevel,
  scopeKindOf,
  sourceLevel,
} from "./facts"
import { must } from "./references"

// Ролі системних довідників прав: `Record` тримає перелік повним, коли
// реєстр додасть роль.
const SYSTEM_CATALOGS: Record<RightsSystemCatalog, true> = {
  rightsRoles: true,
  roleAssignments: true,
}
const SYSTEMS = Object.keys(SYSTEM_CATALOGS) as RightsSystemCatalog[]

const GLOBAL: RightsLevelKey = { level: "global" }

/** Роль системного довідника прав з хука реєстру (Р2a1-23); `undefined` — ні. */
function systemOf(object: ParsedObject): RightsSystemCatalog | undefined {
  return KIND_REGISTRY[object.kind].rightsSystem?.(object.data)
}

/** Рівень системного довідника — його власний скоуп (Р2a1-5). */
function catalogLevel(
  object: ParsedObject,
  references: readonly ResolvedReference[]
): RightsLevelKey {
  const scopeKindId = scopeKindOf(object, references)
  return scopeKindId === undefined ? GLOBAL : { level: "scope", scopeKindId }
}

/** Ключ рівня зберігання для порівняння. */
function storageKey(level: RightsLevelKey): string {
  return level.level === "global" ? "global" : `scope:${level.scopeKindId}`
}

/**
 * Рівень зберігання за рівнем призначення: контейнер — вид скоупу контейнера
 * (у нескоупленого — глобальний, Р2a1-7); «кожен користувач» призначень не
 * має. `scopeOfContainer` — `undefined`, коли контейнера немає взагалі.
 */
function storageOf(
  level: CompiledRoleLevel,
  scopeOfContainer: (containerId: string) => string | undefined | null
): RightsLevelKey | undefined {
  switch (level.level) {
    case "global":
      return GLOBAL
    case "everyUser":
      return undefined
    case "scope":
      return { level: "scope", scopeKindId: level.scopeKindId }
    case "container": {
      const scopeKindId = scopeOfContainer(level.containerId)
      if (scopeKindId === null) return undefined
      return scopeKindId === undefined
        ? GLOBAL
        : { level: "scope", scopeKindId }
    }
  }
}

/**
 * Рівень зберігання ролі (Р2a1-12): у довіднику якого рівня лежать її
 * призначення. Контейнер — вид скоупу контейнера чи глобальний; «кожен
 * користувач» — `undefined`.
 */
export function rightsLevelOf(
  level: CompiledRoleLevel,
  contracts: Pick<Contracts, "rights">
): RightsLevelKey | undefined {
  return storageOf(level, (containerId) => {
    const contract = contracts.rights.find((c) => c.objectId === containerId)
    return contract === undefined ? null : contract.scopeKindId
  })
}

/**
 * Правила системних довідників прав стадії 4 (спека прав §4.6, Р2a1-5,
 * Р2a1-21, Р2a1-24): один довідник на (роль, рівень); рівень із ролями, не
 * покритий прийнятим джерелом, має обидва довідники; довідник, чий суб'єкт —
 * учасник, скоуплено видом із довідником членства; назва кастомної ролі —
 * найменування; рівень, весь покритий джерелами, довідників не має
 * (паралельна система, Рх14). Кастомна дія на довіднику прав — помилка: його
 * пише лише дія адміністрування прав. Прийняті джерела поряд із ролями ще не
 * дають прав — попередження на кожне.
 */
export function checkSystemCatalogs(ctx: RightsCheckContext): Diagnostic[] {
  const diagnostics: Diagnostic[] = []
  const kindNames = new Map(ctx.scopeKinds.map((k) => [k.id, k.name]))
  const label = (level: RightsLevelKey) =>
    level.level === "global" ? "global" : must(kindNames.get(level.scopeKindId))
  const scopeOfContainer = (containerId: string) => {
    const container = ctx.byId.get(containerId)
    return container === undefined
      ? null
      : scopeKindOf(container, ctx.references)
  }
  const byFile = (a: ParsedObject, b: ParsedObject) =>
    compareStrings(a.file, b.file)

  const catalogs = ctx.objects
    .filter((o) => systemOf(o) !== undefined)
    .sort(byFile)
  // Перший довідник кожної (роль, рівень): дубль називає його файл.
  const first = new Map<string, ParsedObject>()
  for (const object of catalogs) {
    const system = must(systemOf(object))
    const level = catalogLevel(object, ctx.references)
    const key = `${system}\u0000${storageKey(level)}`
    const firstObject = first.get(key)
    if (firstObject === undefined) {
      first.set(key, object)
    } else {
      diagnostics.push(
        diagnostic("rights.system-catalog-duplicate", object.file, "/role", {
          role: system,
          level: label(level),
          firstFile: firstObject.file,
        })
      )
    }
    customActionsOf(object).forEach((action, index) => {
      diagnostics.push(
        diagnostic(
          "rights.system-catalog-custom-action",
          object.file,
          `/customActions/${index}`,
          { name: object.name, action: action.name }
        )
      )
    })
    // Назва кастомної ролі — найменування «Ролей» (Р2a1-6): без нього роль
    // нічим назвати в інтерфейсі адміністрування.
    if (
      system === "rightsRoles" &&
      (object.data as { descriptionLength?: number }).descriptionLength === 0
    ) {
      diagnostics.push(
        diagnostic(
          "rights.system-catalog-description",
          object.file,
          "/descriptionLength",
          { name: object.name }
        )
      )
    }
    // Суб'єкт — учасник рівня: ціль його FK дає лише довідник членства, а
    // учасників прийнятого джерела 2a1 ще не призначає (Р2a1-24, п. 4).
    const subject = KIND_REGISTRY[object.kind]
      .standardColumns(object.data)
      .some((column) => column.ref === "member")
    if (
      subject &&
      level.level === "scope" &&
      membershipOfScopeKind(level.scopeKindId, ctx.objects, ctx) !== "catalog"
    ) {
      diagnostics.push(
        diagnostic("rights.system-catalog-scope", object.file, "/scope", {
          name: object.name,
          scopeKind: label(level),
        })
      )
    }
  }

  // Рівень призначення, покритий джерелом, обслуговує прийнята таблиця
  // (Р2a1-24, п. 1): системні довідники йому не потрібні.
  const covered = new Set<string>()
  // Перше джерело кожного рівня зберігання — для тексту паралельної системи.
  const sourced = new Map<string, string>()
  ctx.project.assignmentSources.forEach((source, index) => {
    const level = sourceLevel(ctx.project, index, ctx.references)
    if (level === undefined) return
    covered.add(levelKey(level))
    const storage = storageOf(level, scopeOfContainer)
    if (storage === undefined) return
    const key = storageKey(storage)
    if (!sourced.has(key)) sourced.set(key, source.name)
  })

  const roles = declarationsOf(ctx.objects, "role").sort(byFile)
  // Рівні зберігання з ролями, яких не покриває жодне джерело.
  const uncovered = new Set<string>()
  const reported = new Set<string>()
  for (const role of roles) {
    const level = roleLevel(role, ctx.references)
    if (level === undefined || covered.has(levelKey(level))) continue
    const storage = storageOf(level, scopeOfContainer)
    if (storage === undefined) continue
    const key = storageKey(storage)
    uncovered.add(key)
    // Членство з джерела: довідників прав виду бути не може (суб'єкту немає
    // цілі до 2d), а межу називає попередження джерела. Вид зовсім без
    // членства — помилка ролі, і довідники йому все одно потрібні.
    if (
      storage.level === "scope" &&
      membershipOfScopeKind(storage.scopeKindId, ctx.objects, ctx) === "source"
    ) {
      continue
    }
    for (const system of SYSTEMS) {
      const missing = `${system}\u0000${key}`
      if (first.has(missing) || reported.has(missing)) continue
      reported.add(missing)
      diagnostics.push(
        diagnostic("rights.system-catalog-missing", role.file, "/assignedOn", {
          level: label(storage),
          missing: system,
        })
      )
    }
  }

  // Рівень, усі призначення якого дають джерела, з довідниками — дві системи
  // призначень на одному рівні (Р2a1-24, п. 3).
  for (const object of catalogs) {
    const level = catalogLevel(object, ctx.references)
    const source = sourced.get(storageKey(level))
    if (source === undefined || uncovered.has(storageKey(level))) continue
    diagnostics.push(
      diagnostic("rights.system-catalog-parallel", object.file, "/role", {
        level: label(level),
        source,
      })
    )
  }

  if (roles.length > 0) {
    const sources = [
      ["membershipSources", ctx.project.membershipSources],
      ["assignmentSources", ctx.project.assignmentSources],
    ] as const
    for (const [field, list] of sources) {
      list.forEach((source, index) => {
        diagnostics.push(
          diagnostic(
            "rights.adopted-source-unsupported",
            PROJECT_FILE,
            `/${field}/${index}`,
            { source: source.name }
          )
        )
      })
    }
  }
  return diagnostics
}

/**
 * Таблиці системних довідників прав — основні й ТЧ — як `схема.ім'я`. Функція
 * значень виміру не читає їх (Р1a-14): множина значень залежала б від гранту.
 */
export function rightsCatalogTables(
  objects: readonly ParsedObject[],
  physical: PhysicalSnapshot
): ReadonlySet<string> {
  const ids = new Set(
    objects.filter((o) => systemOf(o) !== undefined).map((o) => must(o.id))
  )
  return new Set(
    physical.tables
      .filter((t) => ids.has(t.origin.objectId))
      .map((t) => `${t.schema}.${t.name}`)
  )
}

/**
 * Контракти системних довідників прав за рівнями. Викликається лише на моделі
 * без помилок: дублів немає, а рівень без одного з довідників не має ролей,
 * яким він потрібен, — такий рівень контракту не дає.
 */
export function rightsCatalogContracts(
  objects: readonly ParsedObject[],
  references: readonly ResolvedReference[],
  physical: PhysicalSnapshot
): RightsCatalogContract[] {
  const byLevel = new Map<
    string,
    { level: RightsLevelKey } & Partial<
      Record<RightsSystemCatalog, ParsedObject>
    >
  >()
  for (const object of objects) {
    const system = systemOf(object)
    if (system === undefined) continue
    const level = catalogLevel(object, references)
    const key = storageKey(level)
    byLevel.set(key, { level, ...byLevel.get(key), [system]: object })
  }
  const tableOf = (id: string, tabularSectionId?: string): QualifiedName => {
    const table = must(
      tabularSectionId === undefined
        ? mainTableOf(physical, id)
        : physical.tables.find(
            (t) =>
              t.origin.objectId === id &&
              t.origin.tabularSectionId === tabularSectionId
          )
    )
    return { schema: table.schema, name: table.name }
  }
  return [...byLevel.values()]
    .flatMap(({ level, rightsRoles, roleAssignments }) => {
      if (rightsRoles === undefined || roleAssignments === undefined) return []
      const rolesId = must(rightsRoles.id)
      // Дельта — єдина стандартна ТЧ «Ролей» (Р2a1-6).
      const delta = must(
        KIND_REGISTRY[rightsRoles.kind].standardTabularSections?.(
          rightsRoles.data
        )[0]
      )
      return [
        {
          level,
          roles: {
            objectId: rolesId,
            table: tableOf(rolesId),
            delta: tableOf(rolesId, standardElementId(rolesId, delta)),
          },
          assignments: {
            objectId: must(roleAssignments.id),
            table: tableOf(must(roleAssignments.id)),
          },
        },
      ]
    })
    .sort((a, b) =>
      a.level.level === "global"
        ? -1
        : b.level.level === "global"
          ? 1
          : compareStrings(a.level.scopeKindId, b.level.scopeKindId)
    )
}
