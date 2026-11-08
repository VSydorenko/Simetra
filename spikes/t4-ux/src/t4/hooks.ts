// Хуки T4 над ядром. Єдиний міст у React — useSyncExternalStore: на сервері
// й під час гідратації getServerSnapshot читає те саме гідроване ядро, тож
// серверний HTML, getServerSnapshot і перший getSnapshot дають ті самі дані.
import { createContext, createElement, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react'
import type { CardSnapshot, CoreSession, WindowSnapshot } from '../core/types'
import { cardSpec, LIST, writerOf } from './facade'
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

const NOOP_SUBSCRIBE = () => () => {}

function useView<S>(core: CoreSession | null, spec: Parameters<CoreSession['view']>[0], empty: S): S {
  const handle = useMemo(() => core?.view(spec), [core, JSON.stringify(spec)])
  const get = handle ? (handle.getSnapshot as () => S) : () => empty
  return useSyncExternalStore(core ? core.subscribe : NOOP_SUBSCRIBE, get, get)
}

const EMPTY_WINDOW: WindowSnapshot = { kind: 'window', status: 'loading', rows: [], atEnd: true, loadingMore: false, hasNewRows: false, needsRefresh: false }
const EMPTY_CARD: CardSnapshot = { kind: 'card', status: 'loading', lines: [], complete: false }

export function useRows(): WindowSnapshot {
  return useView(useCore(), LIST, EMPTY_WINDOW)
}

export function useRow(id: string): CardSnapshot {
  return useView(useCore(), cardSpec(id), EMPTY_CARD)
}

export function useWriter() {
  const core = useCore()
  return useMemo(() => (core ? writerOf(core) : null), [core])
}
