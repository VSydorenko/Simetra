import {
  KIND_REGISTRY,
  type CustomAction,
  type Project,
  type ScopeKind,
} from "simetra/model"
import { diagnostic, type Diagnostic } from "../diagnostics"
import { PROJECT_FILE, type ParsedObject } from "../stages/files"
import type { ResolvedReference } from "../stages/identity"
import type { ModelStageResult } from "../stages/model"
import {
  carrierTarget,
  elementField,
  resolveCarrier,
  type CarrierContext,
} from "./carriers"
import {
  accessCarrier,
  accessDimensionId,
  accessOf,
  bindingOf,
  customActionsOf,
  ownershipOf,
} from "./contracts"

/** Вхід правил прав стадії 4: усе, що вже знає цілісність. */
export interface RightsCheckContext {
  objects: readonly ParsedObject[]
  references: readonly ResolvedReference[]
  model: ModelStageResult
  scopeKinds: readonly ScopeKind[]
  project: Project
  byId: ReadonlyMap<string, ParsedObject>
}

/**
 * Правила прав стадії 4 (спека прав §3): кастомні дії не повторюють
 * стандартних, вимоги називають відомі дії й не замикаються в цикл, а
 * колонки ефектів — власні колонки об'єкта. Контракт будується лише після
 * них, тож замикання вимог там не зустріне циклу.
 */
export function checkRights(ctx: RightsCheckContext): Diagnostic[] {
  const diagnostics: Diagnostic[] = []
  for (const object of ctx.objects) {
    const def = KIND_REGISTRY[object.kind]
    if (def.rightsExtents.length === 0) continue
    const standard = new Set<string>(
      def.actions(object.data).map((a) => a.name)
    )
    const actions = customActionsOf(object)
    const custom = new Set(actions.map((a) => a.name))
    actions.forEach((action, index) => {
      const at = `/customActions/${index}`
      if (standard.has(action.name)) {
        diagnostics.push(
          diagnostic(
            "rights.custom-action-reserved",
            object.file,
            `${at}/name`,
            {
              action: action.name,
              kind: object.kind,
            }
          )
        )
      }
      action.requires.forEach((name, i) => {
        if (standard.has(name) || custom.has(name)) return
        diagnostics.push(
          diagnostic(
            "rights.action-unknown",
            object.file,
            `${at}/requires/${i}`,
            { action: name, object: object.name }
          )
        )
      })
      diagnostics.push(...unknownHeader(object, action, index, ctx.references))
    })
    diagnostics.push(...requiresCycles(object, actions, standard))
    if (def.rightsExtents.includes("own")) {
      diagnostics.push(...checkOwnership(object, ctx))
    }
    if (def.rightsBinding) diagnostics.push(...checkBinding(object, ctx))
    if (def.rightsExtents.includes("dimension")) {
      diagnostics.push(...checkAccess(object, ctx))
    }
  }
  diagnostics.push(...checkDimensions(ctx))
  return diagnostics
}

/** Контекст резолву носія з контексту правил стадії 4. */
export function carrierContext(ctx: RightsCheckContext): CarrierContext {
  return {
    references: ctx.references,
    physical: ctx.model.physical,
    project: ctx.project,
    byId: ctx.byId,
  }
}

/**
 * Правило цілі власності (спека прав §4.2, Р1a-11): кінцевий `Ref` носія —
 * на довідник членства того самого виду скоупу, що й об'єкт, і в межах
 * скоупу (інакше власник з чужого тенанта відкрив би рядок), або на
 * «Користувачі» — там простий FK, бо предикат власності йде AND зі скоупами.
 * Ключ (`ref`) — власник лише рядка самих «Користувачів».
 */
function checkOwnership(
  object: ParsedObject,
  ctx: RightsCheckContext
): Diagnostic[] {
  const carriers = carrierContext(ctx)
  const scopeOf = (o: ParsedObject) => scopeKindOf(o, ctx.references)
  return ownershipOf(object).flatMap((carrier, index) => {
    const pointer = `/ownership/${index}`
    const resolved = resolveCarrier(
      object,
      carrier,
      { pointer, field: "ownership" },
      carriers
    )
    if (!resolved.ok) return [resolved.diagnostic]
    const at = typeof carrier === "string" ? pointer : `${pointer}/1`
    const { object: holder, field } = resolved.terminal
    const target = (reason: "key" | "target") => [
      diagnostic("rights.ownership-target", object.file, at, {
        attribute: field.name,
        reason,
      }),
    ]
    if (field.key) return isUsers(holder) ? [] : target("key")
    const owner = field.target!
    if (isUsers(owner)) return []
    const membership =
      (owner.data as { membership?: unknown }).membership !== undefined
    if (!membership || scopeOf(owner) !== scopeOf(object)) {
      return target("target")
    }
    return field.inScope
      ? []
      : [
          diagnostic("rights.carrier-cross-tenant", object.file, at, {
            attribute: field.name,
          }),
        ]
  })
}

/**
 * Правило прив'язки до контейнера (спека прав §4.3, Р1a-10): кінцева ціль
 * носія — об'єкт із `rightsContainer`, не сам об'єкт, і в межах скоупу
 * (інакше чужий контейнер відкрив би рядок).
 */
function checkBinding(
  object: ParsedObject,
  ctx: RightsCheckContext
): Diagnostic[] {
  const carrier = bindingOf(object)
  if (carrier === undefined) return []
  const pointer = "/containerBinding"
  const resolved = resolveCarrier(
    object,
    carrier,
    { pointer, field: "containerBinding" },
    carrierContext(ctx)
  )
  if (!resolved.ok) return [resolved.diagnostic]
  const at = typeof carrier === "string" ? pointer : `${pointer}/1`
  const { field } = resolved.terminal
  const target = carrierTarget(resolved.terminal)
  if (target === object) {
    return [
      diagnostic("rights.container-self", object.file, at, {
        attribute: field.name,
        name: object.name,
      }),
    ]
  }
  if ((target.data as { rightsContainer?: boolean }).rightsContainer !== true) {
    return [
      diagnostic("rights.container-target", object.file, at, {
        attribute: field.name,
        name: target.name,
      }),
    ]
  }
  return field.inScope
    ? []
    : [
        diagnostic("rights.carrier-cross-tenant", object.file, at, {
          attribute: field.name,
        }),
      ]
}

/** Id виду скоупу об'єкта; немає — об'єкт без скоупу. */
function scopeKindOf(
  object: ParsedObject,
  references: readonly ResolvedReference[]
): string | undefined {
  return references.find(
    (r) => r.role === "object.scope" && r.from.file === object.file
  )?.to.id
}

/** Ціль посилання з файлу проєкту за вказівником і роллю. */
function projectTarget(
  pointer: string,
  role: ResolvedReference["role"],
  ctx: RightsCheckContext
): string | undefined {
  return ctx.references.find(
    (r) =>
      r.from.file === PROJECT_FILE &&
      r.from.pointer === pointer &&
      r.role === role
  )?.to.id
}

/**
 * Правила виміру доступу (спека прав §4.4, Р1a-13): довідник значень — вид,
 * що може ним бути, і скоуплений, коли в проєкті є види скоупу (інакше
 * значення одного тенанта відкривали б рядки іншого). Зв'язок — у тому самому
 * виді скоупу, що й довідник; `subject` — одиночний `Ref` на «Користувачі» чи
 * на довідник членства того самого виду, `value` — одиночний `Ref` на
 * довідник значень. Функцію значень перевіряє стадія 5.
 */
function checkDimensions(ctx: RightsCheckContext): Diagnostic[] {
  const diagnostics: Diagnostic[] = []
  const carriers = carrierContext(ctx)
  const scopeOf = (o: ParsedObject) => scopeKindOf(o, ctx.references)
  ctx.project.accessDimensions.forEach((dimension, index) => {
    const at = `/accessDimensions/${index}`
    const targetId = projectTarget(`${at}/target`, "dimension.target", ctx)
    const target = targetId === undefined ? undefined : ctx.byId.get(targetId)
    // Невідому ціль уже звітувала стадія 2 (`reference.unresolved`).
    if (target === undefined) return
    const reason = !KIND_REGISTRY[target.kind].accessDimensionTarget
      ? "kind"
      : ctx.scopeKinds.length > 0 && scopeOf(target) === undefined
        ? "unscoped"
        : undefined
    if (reason !== undefined) {
      diagnostics.push(
        diagnostic("rights.dimension-target", PROJECT_FILE, `${at}/target`, {
          dimension: dimension.name,
          reason,
        })
      )
    }
    if (!("relation" in dimension.values)) return
    const { relation } = dimension.values
    const relationAt = `${at}/values/relation`
    const broken = (
      field: "object" | "subject" | "value",
      why: "table" | "scope" | "unknown" | "target"
    ) =>
      diagnostics.push(
        diagnostic(
          "rights.dimension-relation",
          PROJECT_FILE,
          `${relationAt}/${field}`,
          { dimension: dimension.name, field, reason: why }
        )
      )
    const objectId = projectTarget(
      `${relationAt}/object`,
      "dimension.relationObject",
      ctx
    )
    const object = objectId === undefined ? undefined : ctx.byId.get(objectId)
    if (object === undefined) return
    if (KIND_REGISTRY[object.kind].materializes !== "table") {
      broken("object", "table")
      return
    }
    if (scopeOf(object) !== scopeOf(target)) broken("object", "scope")
    // Ціль одиночного `Ref` поля зв'язку; `null` — поля немає в об'єкта.
    const targetOf = (field: "subject" | "value") => {
      const id = projectTarget(
        `${relationAt}/${field}`,
        "dimension.relationField",
        ctx
      )
      if (id === undefined) return null
      return elementField(object, id, relation[field], carriers)?.target
    }
    const subject = targetOf("subject")
    const member = (o: ParsedObject) =>
      (o.data as { membership?: unknown }).membership !== undefined &&
      scopeOf(o) === scopeOf(target)
    if (subject === null) broken("subject", "unknown")
    else if (subject === undefined || !(isUsers(subject) || member(subject))) {
      broken("subject", "target")
    }
    const value = targetOf("value")
    if (value === null) broken("value", "unknown")
    else if (value !== target) broken("value", "target")
  })
  return diagnostics
}

/**
 * Правило мапінгу `access` (спека прав §4.4): вимір відомий і названий раз,
 * кінцевий `Ref` носія — на довідник значень виміру й у межах скоупу
 * (інакше значення з чужого тенанта відкрили б рядок).
 */
function checkAccess(
  object: ParsedObject,
  ctx: RightsCheckContext
): Diagnostic[] {
  const carriers = carrierContext(ctx)
  const seen = new Set<string>()
  return accessOf(object).flatMap((mapping, index) => {
    const dimensionAt = `/access/${index}/dimension`
    const params = { dimension: mapping.dimension }
    const dimensionId = accessDimensionId(object, index, ctx.references)
    if (dimensionId === undefined) {
      return [
        diagnostic(
          "rights.dimension-unknown",
          object.file,
          dimensionAt,
          params
        ),
      ]
    }
    if (seen.has(dimensionId)) {
      return [
        diagnostic("rights.access-duplicate", object.file, dimensionAt, params),
      ]
    }
    seen.add(dimensionId)
    const { carrier, pointer } = accessCarrier(mapping, index)
    const resolved = resolveCarrier(
      object,
      carrier,
      { pointer, field: "access", role: "access.attribute" },
      carriers
    )
    if (!resolved.ok) return [resolved.diagnostic]
    const at = typeof carrier === "string" ? pointer : `${pointer}/1`
    const { field } = resolved.terminal
    const dimensionIndex = ctx.project.accessDimensions.findIndex(
      (d) => d.id === dimensionId
    )
    const targetId = projectTarget(
      `/accessDimensions/${dimensionIndex}/target`,
      "dimension.target",
      ctx
    )
    if (
      targetId !== undefined &&
      carrierTarget(resolved.terminal).id !== targetId
    ) {
      return [
        diagnostic("rights.access-target", object.file, at, {
          attribute: field.name,
          dimension: mapping.dimension,
        }),
      ]
    }
    return field.inScope
      ? []
      : [
          diagnostic("rights.carrier-cross-tenant", object.file, at, {
            attribute: field.name,
          }),
        ]
  })
}

function isUsers(object: ParsedObject): boolean {
  return (object.data as { role?: string }).role === "users"
}

/**
 * Ім'я в `effects.header`, якого індекс посилань не резолвив, — не колонка
 * об'єкта: стадія 2 мовчить про нього для видів 1С, тож звітує це правило.
 */
function unknownHeader(
  object: ParsedObject,
  action: CustomAction,
  index: number,
  references: readonly ResolvedReference[]
): Diagnostic[] {
  const { header } = action.effects
  if (header === undefined || header === "all") return []
  return header.flatMap((name, at) => {
    const pointer = `/customActions/${index}/effects/header/${at}`
    const resolved = references.some(
      (r) =>
        r.from.file === object.file &&
        r.from.pointer === pointer &&
        r.role === "customAction.header"
    )
    return resolved
      ? []
      : [
          diagnostic("rights.attribute-unknown", object.file, pointer, {
            attribute: name,
            field: "customActions.effects.header",
          }),
        ]
  })
}

/**
 * Цикл вимог між кастомними діями (стандартні дії реєстру ациклічні й
 * кастомних не вимагають). Діагностика стоїть на ребрі, що виходить з першої
 * дії циклу на шляху обходу, і називає весь ланцюжок.
 */
function requiresCycles(
  object: ParsedObject,
  actions: readonly CustomAction[],
  standard: ReadonlySet<string>
): Diagnostic[] {
  const diagnostics: Diagnostic[] = []
  const byName = new Map<string, number>()
  actions.forEach((a, i) => {
    if (!byName.has(a.name)) byName.set(a.name, i)
  })
  const state = actions.map(() => "new" as "new" | "open" | "done")
  // `edges[k]` — індекс вимоги, якою обхід перейшов з `path[k]` у `path[k + 1]`.
  const path: number[] = []
  const edges: number[] = []
  const visit = (node: number) => {
    state[node] = "open"
    path.push(node)
    actions[node]!.requires.forEach((name, at) => {
      const next = standard.has(name) ? undefined : byName.get(name)
      if (next === undefined) return
      if (state[next] === "open") {
        const start = path.indexOf(next)
        const edge = start === path.length - 1 ? at : edges[start]!
        const chain = [...path.slice(start), next].map((i) => actions[i]!.name)
        diagnostics.push(
          diagnostic(
            "rights.requires-cycle",
            object.file,
            `/customActions/${next}/requires/${edge}`,
            { actions: chain.join(" → ") }
          )
        )
        return
      }
      if (state[next] === "done") return
      edges.push(at)
      visit(next)
      edges.pop()
    })
    path.pop()
    state[node] = "done"
  }
  actions.forEach((_, i) => {
    if (state[i] === "new") visit(i)
  })
  return diagnostics
}
