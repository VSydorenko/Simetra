// Хуки T4 над ядром. Єдиний міст у React — useSyncExternalStore: на сервері
// й під час гідратації getServerSnapshot читає те саме гідроване ядро, тож
// серверний HTML, getServerSnapshot і перший getSnapshot дають ті самі дані.
// Власність на рядки дає лише subscribe хендла (React балансує її сам).
import { createContext, createElement, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react'
import type { CoreSession, ViewHandle, ViewSnapshot, ViewSpec } from '../core'
import { cardSpec, LIST, linesSpec, writerOf } from './facade'
import type { RuntimeHolder } from './runtime'

const HolderContext = createContext<RuntimeHolder | null>(null)

export function RuntimeProvider(props: { holder: RuntimeHolder; children: ReactNode }) {
  return createElement(HolderContext.Provider, { value: props.holder }, props.children)
}

export function useHolder(): RuntimeHolder {
  const h = useContext(HolderContext)
  if (!h) throw new Error('T4: RuntimeProvider is missing')
  return h
}

export function useCore(): CoreSession | null {
  const holder = useHolder()
  return useSyncExternalStore(holder.subscribe, holder.getSnapshot, holder.getSnapshot)
}

const EMPTY: ViewSnapshot = Object.freeze({ status: 'loading', rows: [], hasNewRows: false, needsRefresh: false })
const NOOP: ViewHandle = { getSnapshot: () => EMPTY, subscribe: () => () => {}, refresh() {}, showNew() {}, loadAfter() {} }

export function useView(spec: ViewSpec): [ViewSnapshot, ViewHandle] {
  const core = useCore()
  const key = JSON.stringify(spec)
  const handle = useMemo(() => (core ? core.view(spec) : NOOP), [core, key])
  return [useSyncExternalStore(handle.subscribe, handle.getSnapshot, handle.getSnapshot), handle]
}

export const useRows = () => useView(LIST)
export const useCard = (key: string) => useView(cardSpec(key))[0]
export const useLines = (key: string) => useView(linesSpec(key))[0]

export function useWriter() {
  const core = useCore()
  return useMemo(() => (core ? writerOf(core) : null), [core])
}
