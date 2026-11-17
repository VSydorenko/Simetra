import { createContext, createElement, useContext, type ReactNode } from "react"

/**
 * Шов між T5 і маршрутизатором: T5 не знає TanStack Router, адаптер дає T6.
 * `object` — логічне ім'я об'єкта, `key` — ключ рядка.
 */
export interface NavigationAdapter {
  openCard(object: string, key: string): void
  openList(object: string): void
  /** Блокує перехід, поки `dirty` істинне (незбережена чернетка). */
  useBlockWhile(dirty: boolean): void
}

// Немає типового адаптера: хост без навігації — помилка збірки застосунку,
// а не мовчазний «нічого не відкривається».
const NavigationContext = createContext<NavigationAdapter | null>(null)

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

export function useNavigation(): NavigationAdapter {
  const adapter = useContext(NavigationContext)
  if (adapter === null) {
    throw new Error("useNavigation requires a NavigationProvider")
  }
  return adapter
}
