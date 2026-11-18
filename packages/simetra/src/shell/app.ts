import { createElement, type ReactElement, type ReactNode } from "react"
import {
  createDataRuntime,
  type DataRuntime,
  type DataRuntimeOptions,
} from "simetra/data"
import {
  catalogIndex,
  type CatalogEntry,
  type ClientCatalog,
  type MetadataRef,
} from "simetra/model"
import { CatalogProvider } from "simetra/ui"

/** An object of the catalog as routes take it (P4-D spec §6). */
export interface EntityDescriptor {
  /** Logical object name `"<kind>.<name>"`. */
  readonly ref: string
  /** The object UUID. */
  readonly id: string
}

// Запис каталогу не входить у публічну форму дескриптора `{ ref, id }`
// (спека §6): маршрути беруть його з каталогу додатка, а не з пам'яті
// викликача, і цей WeakMap — єдиний шлях до нього.
const entries = new WeakMap<EntityDescriptor, CatalogEntry>()

/** The catalog entry behind a descriptor made by `simetraApp(...).object`. */
export function entryOf(entity: EntityDescriptor): CatalogEntry {
  const entry = entries.get(entity)
  if (entry === undefined) {
    throw new TypeError("not a descriptor made by simetraApp(catalog).object")
  }
  return entry
}

export interface SimetraApp {
  /**
   * The descriptor of an object; a `TypeError` for an object outside the
   * catalog, so a wrong route fails when the module is imported.
   */
  object(ref: MetadataRef): EntityDescriptor
  /** Creates the data runtime of a session over this app's catalog. */
  createRuntime(options: Omit<DataRuntimeOptions, "catalog">): DataRuntime
  /** Provides the same catalog to the T5 hosts; the only place that mounts `CatalogProvider`. */
  Provider(props: { children?: ReactNode }): ReactElement
}

/**
 * The app over one client catalog (`client-catalog.json`): the runtime and the
 * T5 hosts read the same object, so they cannot disagree (P4-D spec §5).
 */
export function simetraApp(catalog: ClientCatalog): SimetraApp {
  const index = catalogIndex(catalog.objects)
  return {
    object(ref) {
      const name = `${ref.kind}.${ref.name}`
      const entry = index.byRef.get(name)
      if (entry === undefined) {
        throw new TypeError(`simetraApp: unknown object ${name}`)
      }
      const entity: EntityDescriptor = { ref: name, id: entry.id }
      entries.set(entity, entry)
      return entity
    },
    createRuntime: (options) => createDataRuntime({ ...options, catalog }),
    Provider: (props) =>
      createElement(CatalogProvider, { catalog }, props.children),
  }
}
