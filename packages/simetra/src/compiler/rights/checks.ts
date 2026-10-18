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
import { customActionsOf } from "./contracts"

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
  }
  return diagnostics
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
