import { expect } from "vitest"
import {
  applyChanges,
  buildRuntimeCatalog,
  deleteElement,
  renameElement,
  type OperationResult,
} from "simetra/compiler"
import type { RuntimeCatalog } from "simetra/model"
import { uuid } from "../helpers"
import {
  adminRoles,
  commandCoreLayer,
  compileRights,
  policyDomain,
  writeRoles,
} from "./rights"

type Files = Map<string, string>
type Json = Record<string, unknown>

/**
 * Імена каталогу `A` і їхні наступники в `A′`. Тест бере їх звідси, а не
 * повторює літерали: зміна будівника не лишає тест на старих іменах.
 */
export const EVOLUTION = {
  object: { from: "Ticket", to: "Issue" },
  attribute: { from: "region", to: "area" },
  section: { from: "checklist", to: "todo" },
  /** Новий необов'язковий реквізит і шапки, і ТЧ. */
  added: "memo",
  /** Реквізит шапки, видалений на фазі розширення. */
  removed: "subject",
} as const

const ISSUE_FILE = `catalogs/${EVOLUTION.object.to}/${EVOLUTION.object.to}.meta.json`

async function applied(
  files: Files,
  result: Promise<OperationResult>
): Promise<Files> {
  const { ok, diagnostics, changes } = await result
  expect(diagnostics.filter((d) => d.severity === "error")).toEqual([])
  expect(ok).toBe(true)
  return applyChanges(files, changes)
}

const memo = (id: number) => ({
  id: uuid(id),
  name: EVOLUTION.added,
  physicalName: EVOLUTION.added,
  type: "String",
  length: 40,
})

function withAdded(files: Files): Files {
  const meta = JSON.parse(files.get(ISSUE_FILE)!) as Json
  meta.attributes = [...(meta.attributes as Json[]), memo(6995)]
  const section = (meta.tabularSections as Json[]).find(
    (s) => s.name === EVOLUTION.section.to
  )!
  section.attributes = [...(section.attributes as Json[]), memo(6996)]
  return new Map(files).set(ISSUE_FILE, JSON.stringify(meta))
}

async function catalogOf(files: Files): Promise<RuntimeCatalog> {
  const { model, diagnostics } = await compileRights(files)
  expect(diagnostics).toEqual([])
  return buildRuntimeCatalog(model!)
}

/**
 * Catalogs before and after a compatible evolution of `Catalog.Ticket` of
 * the command-core domain: `aPrime` renames the object, a header attribute
 * and a tabular section (through `renameElement`), adds an optional
 * attribute to the header and to the section, and removes a header
 * attribute (the expansion phase: the attribute leaves the model, its column
 * stays in the database). Names are in {@link EVOLUTION}.
 */
export async function evolvedCatalogs(): Promise<{
  a: RuntimeCatalog
  aPrime: RuntimeCatalog
}> {
  const files = policyDomain(writeRoles(), adminRoles(), commandCoreLayer())
  const { object, attribute, section, removed } = EVOLUTION
  let next = await applied(
    files,
    renameElement(files, {
      target: { kind: "Catalog", name: object.from },
      newName: object.to,
    })
  )
  for (const [from, to] of [
    [attribute.from, attribute.to],
    [section.from, section.to],
  ] as const) {
    next = await applied(
      next,
      renameElement(next, {
        target: { kind: "Catalog", name: object.to, element: [from] },
        newName: to,
      })
    )
  }
  // Фаза розширення прибирає реквізит з моделі, а не з бази (платформна
  // спека §7): каталог рантайму будується з моделі, тож у ньому реквізиту
  // вже немає — окремого стану «колонка лишилась» каталог не має.
  next = await applied(
    next,
    deleteElement(next, {
      target: { kind: "Catalog", name: object.to, element: [removed] },
    })
  )
  return {
    a: await catalogOf(files),
    aPrime: await catalogOf(withAdded(next)),
  }
}
