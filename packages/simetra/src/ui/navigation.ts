import { createContext, createElement, useContext, type ReactNode } from "react"

/**
 * Шов між T5 і маршрутизатором: T5 не знає TanStack Router, адаптер дає T6.
 * `object` — логічне ім'я об'єкта, `key` — ключ рядка.
 */
export interface NavigationAdapter {
  /** Opens the card of the row `key` of `object`. */
  openCard(object: string, key: string): void
  /** Opens the list of `object`. */
  openList(object: string): void
  /** Blocks navigation while `dirty` is true (an unsaved draft). */
  useBlockWhile(dirty: boolean): void
}

// Немає типового адаптера: хост без навігації — помилка збірки застосунку,
// а не мовчазний «нічого не відкривається».
const NavigationContext = createContext<NavigationAdapter | null>(null)

/** Provides the router adapter to T5 hosts. */
export function NavigationProvider(props: {
  adapter: NavigationAdapter
  children?: ReactNode
}) {
  return createElement(
    NavigationContext.Provider,
    { value: props.adapter },
    props.children
  )
}

/** The current adapter; throws `Error` without a `NavigationProvider`. */
export function useNavigation(): NavigationAdapter {
  const adapter = useContext(NavigationContext)
  if (adapter === null) {
    throw new Error("useNavigation requires a NavigationProvider")
  }
  return adapter
}
