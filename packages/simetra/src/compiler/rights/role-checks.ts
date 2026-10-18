import type { Role } from "simetra/model"
import { diagnostic, type Diagnostic } from "../diagnostics"
import type { ParsedObject } from "../stages/files"
import { membershipOfScopeKind, type RightsCheckContext } from "./checks"
import {
  declarationsOf,
  includedSets,
  isRightsContainer,
  levelKey,
  roleLevel,
  sourceLevel,
} from "./facts"
import { objectTarget } from "./references"

/**
 * Правила ролей і наборів прав стадії 4 (спека прав §4.1, §4.7, Рх7, Рх19):
 * рівень ролі має ціль, придатну для призначень; повні права й творець кореня —
 * лише на своїх рівнях; ключ ролі в джерелі — того самого рівня й
 * однозначний; включення наборів не замикаються в цикл. Контракт ролей
 * будується лише після них, тож замикання включень там не зустріне циклу.
 */
export function checkRoles(ctx: RightsCheckContext): Diagnostic[] {
  const diagnostics: Diagnostic[] = []
  const known = new Set(ctx.scopeKinds.map((k) => k.name))
  const sourceLevels = new Map(
    ctx.project.assignmentSources.flatMap((source, index) => {
      const level = sourceLevel(ctx.project, index, ctx.references)
      return source.id === undefined || level === undefined
        ? []
        : [[source.id, levelKey(level)] as const]
    })
  )
  // Один творець кореня на вид скоупу: команда створення кореня призначає
  // творцю одну роль, і вибір між двома був би довільним.
  const rootCreators = new Map<string, string>()
  // Ключ у джерелі називає одну роль: інакше рядок призначення дав би дві.
  const keys = new Map<string, string>()
  for (const object of declarationsOf(ctx.objects, "role")) {
    const role = object.data as Role
    const report = (
      code: Parameters<typeof diagnostic>[0],
      pointer: string,
      params: Record<string, string>
    ) => diagnostics.push(diagnostic(code, object.file, pointer, params))
    const declared = role.assignedOn
    const level = roleLevel(object, ctx.references)
    const kind =
      typeof declared === "string"
        ? declared
        : "scopeKind" in declared
          ? "scope"
          : "container"
    const scopeKind =
      typeof declared === "object" && "scopeKind" in declared
        ? declared.scopeKind
        : undefined
    if (scopeKind !== undefined) {
      if (!known.has(scopeKind)) {
        report("rights.scope-kind-unknown", "/assignedOn/scopeKind", {
          scopeKind,
        })
      } else if (
        level?.level === "scope" &&
        membershipOfScopeKind(level.scopeKindId, ctx.objects, ctx) === undefined
      ) {
        // Роль рівня скоупу призначають учаснику: без членства учасників
        // виду немає, і роль нікому не дісталася б (Рх7).
        report("rights.scope-without-membership", "/assignedOn/scopeKind", {
          scopeKind,
        })
      }
    }
    if (level?.level === "container") {
      const target = ctx.byId.get(level.containerId)
      if (target !== undefined && !isRightsContainer(target)) {
        report("rights.container-target", "/assignedOn/container", {
          role: object.name,
          name: target.name,
        })
      }
    }
    // Повні права обходять перевірки на об'єктах свого рівня (Рх5): у
    // контейнера й «кожного користувача» такого рівня об'єктів немає.
    if (role.fullAccess && (kind === "container" || kind === "everyUser")) {
      report("rights.full-access-level", "/fullAccess", { level: kind })
    }
    if (role.rootCreator) {
      if (kind !== "scope") {
        report("rights.root-creator-level", "/rootCreator", { level: kind })
      } else if (level?.level === "scope" && scopeKind !== undefined) {
        const firstFile = rootCreators.get(level.scopeKindId)
        if (firstFile === undefined) {
          rootCreators.set(level.scopeKindId, object.file)
        } else {
          report("rights.root-creator-duplicate", "/rootCreator", {
            scopeKind,
            firstFile,
          })
        }
      }
    }
    role.sourceKeys.forEach((entry, index) => {
      const at = `/sourceKeys/${index}`
      const sourceId = objectTarget(
        object,
        `${at}/source`,
        "role.sourceKey",
        ctx.references
      )
      if (sourceId === undefined) {
        report("rights.source-unknown", `${at}/source`, {
          source: entry.source,
        })
        return
      }
      // Рядок джерела дає роль на рівні джерела: роль іншого рівня з нього
      // не призначити, а «кожному користувачу» рядки не потрібні.
      const source = sourceLevels.get(sourceId)
      if (
        kind === "everyUser" ||
        (level !== undefined &&
          source !== undefined &&
          source !== levelKey(level))
      ) {
        report("rights.source-key-level", `${at}/source`, {
          source: entry.source,
        })
      }
      const key = `${sourceId}\u0000${entry.key}`
      const firstFile = keys.get(key)
      if (firstFile === undefined) {
        keys.set(key, object.file)
      } else {
        report("rights.source-key-duplicate", `${at}/key`, {
          source: entry.source,
          key: entry.key,
          firstFile,
        })
      }
    })
  }
  diagnostics.push(...includeCycles(ctx))
  return diagnostics
}

/**
 * Цикл включень між наборами (роль включити не можна — `rights.include-target`,
 * тож роль у цикл не входить). Діагностика стоїть на ребрі, що виходить з
 * першого набору циклу на шляху обходу, і називає весь ланцюжок.
 */
function includeCycles(ctx: RightsCheckContext): Diagnostic[] {
  const diagnostics: Diagnostic[] = []
  const sets = declarationsOf(ctx.objects, "set")
  const byId = new Map(sets.map((set) => [set.id, set]))
  const state = new Map<ParsedObject, "open" | "done">()
  // `edges[k]` — позиція в `include`, якою обхід перейшов з `path[k]` у `path[k + 1]`.
  const path: ParsedObject[] = []
  const edges: number[] = []
  const visit = (node: ParsedObject) => {
    state.set(node, "open")
    path.push(node)
    includedSets(node, ctx.references).forEach((id, at) => {
      const next = id === undefined ? undefined : byId.get(id)
      if (next === undefined) return
      if (state.get(next) === "open") {
        const start = path.indexOf(next)
        const edge = start === path.length - 1 ? at : edges[start]!
        const chain = [...path.slice(start), next].map((s) => s.name)
        diagnostics.push(
          diagnostic("rights.include-cycle", next.file, `/include/${edge}`, {
            chain: chain.join(" → "),
          })
        )
        return
      }
      if (state.get(next) === "done") return
      edges.push(at)
      visit(next)
      edges.pop()
    })
    path.pop()
    state.set(node, "done")
  }
  for (const set of sets) {
    if (!state.has(set)) visit(set)
  }
  return diagnostics
}
