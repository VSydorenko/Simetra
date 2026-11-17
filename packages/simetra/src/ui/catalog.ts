import {
  createContext,
  createElement,
  useContext,
  useMemo,
  type ReactNode,
} from "react"
import {
  catalogIndex,
  type CatalogEntry,
  type CatalogIndex,
  type ClientCatalog,
} from "simetra/model"

// Каталог — артефакт збірки, а не стан сесії: хости читають його з власного
// контексту, тож колонки є й тоді, коли рантайму даних ще чи вже немає.
const CatalogContext = createContext<CatalogIndex | null>(null)

/** Provides the client catalog (`client-catalog.json`) to T5 hosts. */
export function CatalogProvider(props: {
  catalog: ClientCatalog
  children?: ReactNode
}) {
  const index = useMemo(
    () => catalogIndex(props.catalog.objects),
    [props.catalog]
  )
  return createElement(
    CatalogContext.Provider,
    { value: index },
    props.children
  )
}

/** Внутрішній доступ хостів до цілей `Ref` за id; не публічний API. */
export function useCatalogIndex(): CatalogIndex {
  const index = useContext(CatalogContext)
  // Без провайдера — помилка збірки застосунку, а не порожній каталог: хост
  // без колонок виглядав би як порожній список.
  if (index === null) {
    throw new Error("useCatalogEntry requires a CatalogProvider")
  }
  return index
}

/**
 * The catalog entry of `object` (`"<kind>.<name>"`). Throws `Error` without a
 * `CatalogProvider` and `TypeError` for an object outside the catalog.
 */
export function useCatalogEntry(object: string): CatalogEntry {
  const entry = useCatalogIndex().byRef.get(object)
  if (entry === undefined) {
    throw new TypeError(`useCatalogEntry: unknown object ${object}`)
  }
  return entry
}
