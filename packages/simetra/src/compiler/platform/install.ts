import {
  isObjectTable,
  type DatabaseProvider,
  type PhysicalTable,
} from "simetra/model"
import { compile } from "../compile"
import { PROJECT_FILE } from "../stages/files"
import { splitIdentity } from "../sql/identity"
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
 * It is a reference of `platformRecogniser`, which tells platform content
 * from the application's by content, not by name.
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

/**
 * Atoms `<grant|revoke>|<class>|<object>|<role>|<privilege>` of a grant unit,
 * read from its identity
 * `grant:<grant|revoke>:<class>:<objects>:<roles>:<privileges>`; a column
 * privilege is one atom per column (`insert(method)`), and the grant option
 * stays on each atom (`select*`, `insert(method)*`), so a grant with the
 * option never matches an atom of the install, which gives none. Only for
 * identities without SQL (the plan of `diff`); a catalog unit is judged by
 * `platformRecogniser`, which takes its atoms from the parse tree.
 */
export function grantAtoms(identity: string): string[] {
  const [, action, kind, objects, roles, privileges] = splitIdentity(
    identity,
    ":"
  )
  const privilegeAtoms = grantObjects(privileges ?? "").flatMap((p) => {
    const columns = /^([^(]+)\((.*)\)(\*?)$/.exec(p)
    return columns === null
      ? [p]
      : splitIdentity(columns[2]!, ",").map(
          (c) => `${columns[1]}(${c})${columns[3]}`
        )
  })
  return grantObjects(objects ?? "").flatMap((object) =>
    splitIdentity(roles ?? "", ",").flatMap((role) =>
      privilegeAtoms.map((p) => `${action}|${kind}|${object}|${role}|${p}`)
    )
  )
}
