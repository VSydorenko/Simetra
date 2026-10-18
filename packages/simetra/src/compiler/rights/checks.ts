import {
  KIND_REGISTRY,
  type CustomAction,
  type Project,
  type ScopeKind,
} from "simetra/model"
import { diagnostic, type Diagnostic } from "../diagnostics"
import type { ParsedObject } from "../stages/files"
import type { ResolvedReference } from "../stages/identity"
import type { ModelStageResult } from "../stages/model"
import { carrierTarget, resolveCarrier, type CarrierContext } from "./carriers"
import { bindingOf, customActionsOf, ownershipOf } from "./contracts"

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
  }
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
  const scopeOf = (o: ParsedObject) =>
    ctx.references.find(
      (r) => r.role === "object.scope" && r.from.file === o.file
    )?.to.id
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
