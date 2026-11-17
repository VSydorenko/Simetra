import {
  createContext,
  createElement,
  useContext,
  useSyncExternalStore,
  type ReactNode,
} from "react"
import { runtimeHandleOf } from "../runtime/handle"
import type { RuntimeHolder } from "../runtime/holder"
import type { CoreSession } from "../store/core"
import type { CloseReason } from "../store/types"

const HolderContext = createContext<RuntimeHolder | undefined>(undefined)

/** Gives the hooks of `children` the runtime of `holder` (P4-B spec §6.4). */
export function DataRuntimeProvider(props: {
  holder: RuntimeHolder
  children?: ReactNode
}) {
  return createElement(
    HolderContext.Provider,
    { value: props.holder },
    props.children
  )
}

/** What a hook reads from the holder: a live core, or why there is none. */
export type CoreSource =
  | { readonly core: CoreSession }
  | { readonly core: undefined; readonly reason: CloseReason | undefined }

// Рантайм і причина закриття читаються двома окремими підписками на тримач,
// але міняються разом у `replace`: клієнт, що перерендерився між ними, бачить
// обидва вже новими, бо `useSyncExternalStore` перечитує знімки на кожен кадр.
export function useCoreSource(): CoreSource {
  const holder = useContext(HolderContext)
  if (holder === undefined) {
    throw new Error(
      "simetra/data/react: no DataRuntimeProvider above this hook"
    )
  }
  const runtime = useSyncExternalStore(
    holder.subscribe,
    holder.current,
    holder.current
  )
  const reason = useSyncExternalStore(
    holder.subscribe,
    holder.closed,
    holder.closed
  )
  return runtime === undefined
    ? { core: undefined, reason }
    : { core: runtimeHandleOf(runtime).core }
}
