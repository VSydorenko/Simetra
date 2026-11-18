import {
  isObjectTable,
  type DatabaseProvider,
  type PhysicalTable,
} from "simetra/model"
import { compile } from "../compile"
import { PROJECT_FILE } from "../stages/files"
import { grantObjects, type SqlUnit } from "../sql/units"

/**
 * What the platform installs in every database of a provider: the snapshot
 * tables with a platform origin (no owner object) and the units the compiler
 * generates for a project without any object.
 */
export interface PlatformInstall {
  tables: readonly PhysicalTable[]
  units: readonly SqlUnit[]
}

const installs = new Map<DatabaseProvider, Promise<PlatformInstall>>()

/**
 * The platform install of `provider`, derived from the compiled empty project
 * — the same generators that put it into every project, not a list per
 * object: a new platform table or unit appears here without a second edit.
 * Readers that must tell platform content of schema `simetra` from the
 * application's (reverse generation, tests of `diff`) recognise it through
 * this one notion.
 */
export function platformInstall(
  provider: DatabaseProvider
): Promise<PlatformInstall> {
  const cached = installs.get(provider)
  if (cached !== undefined) return cached
  const derived = compileEmpty(provider)
  installs.set(provider, derived)
  return derived
}

async function compileEmpty(
  provider: DatabaseProvider
): Promise<PlatformInstall> {
  const compiled = await compile(
    new Map([
      [
        PROJECT_FILE,
        JSON.stringify({ name: "PlatformInstall", database: { provider } }),
      ],
    ])
  )
  if (compiled.model === undefined)
    throw new Error(
      `internal: the empty project of provider ${provider} does not compile`
    )
  return {
    tables: compiled.model.physical.tables.filter((t) => !isObjectTable(t)),
    // Порожній проєкт не має файлів, тож усі його одиниці — згенеровані
    units: compiled.model.sqlUnits.filter((u) => u.file === undefined),
  }
}

/** A unit of a live catalog or of a folder, as the recogniser reads it. */
type RecognisedUnit = Pick<SqlUnit, "class" | "identity" | "name">

/**
 * Recogniser of the platform install among the objects of a catalog: a table
 * of the install, a unit with the identity of an install unit, or a grant
 * whose every target is an install object (a table, its identity sequence, a
 * function or sequence unit). The platform owns the whole ACL of its objects,
 * and the catalog keeps a grant in its own form (one unit per column, merged
 * privileges), so a grant is recognised by its targets, not by its identity.
 */
export interface PlatformInstallRecogniser {
  table(schema: string, name: string): boolean
  unit(unit: RecognisedUnit): boolean
}

export function platformInstallRecogniser(
  install: PlatformInstall
): PlatformInstallRecogniser {
  const tables = new Set(install.tables.map((t) => `${t.schema}.${t.name}`))
  const identities = new Set(install.units.map((u) => u.identity))
  const objects = new Set([
    ...install.tables.flatMap((t) => [
      `table|${t.schema}.${t.name}`,
      ...t.columns.flatMap((c) =>
        c.identity === undefined
          ? []
          : [`sequence|${t.schema}.${c.identity.sequence}`]
      ),
    ]),
    ...install.units
      .filter((u) => u.class !== "grant")
      .map((u) => u.identity.replace(":", "|")),
  ])
  return {
    table: (schema, name) => tables.has(`${schema}.${name}`),
    unit: (unit) => {
      if (identities.has(unit.identity)) return true
      if (unit.class !== "grant") return false
      // Ідентичність гранту: `grant:<grant|revoke>:<клас>:<об'єкти>:…`
      const kind = unit.identity.split(":")[2]
      const targets = grantObjects(unit.name)
      return (
        targets.length > 0 &&
        targets.every((target) => objects.has(`${kind}|${target}`))
      )
    },
  }
}
