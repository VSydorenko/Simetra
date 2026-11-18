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
type RecognisedUnit = Pick<SqlUnit, "class" | "identity">

/**
 * Recogniser of the platform install among the objects of a catalog: a table
 * of the install, a unit with the identity of an install unit, or a grant
 * whose every atom (direction, target, role, privilege) is an atom of the
 * install's own grant units. The catalog keeps a grant in its own form (one
 * unit per column, merged privileges) but keeps each atom, so the atoms
 * match where the identity does not. A grant on an install object to another
 * role, to `PUBLIC`, of another privilege or with the grant option is not
 * the platform's: the folder
 * gets it and the compiler refuses it, it is never dropped silently.
 */
export interface PlatformInstallRecogniser {
  table(schema: string, name: string): boolean
  unit(unit: RecognisedUnit): boolean
}

/**
 * Atoms `<grant|revoke>|<class>|<object>|<role>|<privilege>` of a grant unit,
 * read from its identity
 * `grant:<grant|revoke>:<class>:<objects>:<roles>:<privileges>`; a column
 * privilege is one atom per column (`insert(method)`), and the grant option
 * stays on each atom (`select*`, `insert(method)*`), so a grant with the
 * option never matches an atom of the install, which gives none.
 */
export function grantAtoms(identity: string): string[] {
  const [, action, kind, objects, roles, privileges] = identity.split(":")
  const privilegeAtoms = grantObjects(privileges ?? "").flatMap((p) => {
    const columns = /^([^(]+)\((.*)\)(\*?)$/.exec(p)
    return columns === null
      ? [p]
      : columns[2]!.split(",").map((c) => `${columns[1]}(${c})${columns[3]}`)
  })
  return grantObjects(objects ?? "").flatMap((object) =>
    (roles ?? "")
      .split(",")
      .flatMap((role) =>
        privilegeAtoms.map((p) => `${action}|${kind}|${object}|${role}|${p}`)
      )
  )
}

export function platformInstallRecogniser(
  install: PlatformInstall
): PlatformInstallRecogniser {
  const tables = new Set(install.tables.map((t) => `${t.schema}.${t.name}`))
  const identities = new Set(install.units.map((u) => u.identity))
  const atoms = new Set(
    install.units
      .filter((u) => u.class === "grant")
      .flatMap((u) => grantAtoms(u.identity))
  )
  return {
    table: (schema, name) => tables.has(`${schema}.${name}`),
    unit: (unit) => {
      if (identities.has(unit.identity)) return true
      if (unit.class !== "grant") return false
      const own = grantAtoms(unit.identity)
      return own.length > 0 && own.every((t) => atoms.has(t))
    },
  }
}
