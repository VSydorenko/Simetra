import { useMemo, useSyncExternalStore } from "react"
import type { CoreSession } from "../store/core"
import type {
  CloseReason,
  ViewHandle,
  ViewSnapshot,
  ViewSpec,
} from "../store/types"
import type { CoreSource } from "./provider"

/** The store of a hook: one or several views read as one snapshot. */
interface ViewsStore {
  subscribe(listener: () => void): () => void
  getSnapshot(): readonly ViewSnapshot[]
  readonly handles: readonly ViewHandle[]
}

const LOADING: ViewSnapshot = {
  status: "loading",
  rows: [],
  hasNewRows: false,
  needsRefresh: false,
}
const NO_SNAPSHOTS: readonly ViewSnapshot[] = []
const IDLE: ViewsStore = {
  subscribe: () => () => {},
  getSnapshot: () => NO_SNAPSHOTS,
  handles: [],
}

// Знімок «сесії немає» — один на причину: незмінна посилка, інакше
// `useSyncExternalStore` зациклився б на кожному кадрі.
const closedSnapshots = new Map<CloseReason, readonly ViewSnapshot[]>()
function closedSnapshot(reason: CloseReason | undefined) {
  if (reason === undefined) return [LOADING]
  let snapshot = closedSnapshots.get(reason)
  if (snapshot === undefined) {
    snapshot = [{ ...LOADING, status: "purged", reason }]
    closedSnapshots.set(reason, snapshot)
  }
  return snapshot
}

function combine(handles: readonly ViewHandle[]): ViewsStore {
  let last: readonly ViewSnapshot[] | undefined
  return {
    handles,
    subscribe(listener) {
      const releases: (() => void)[] = []
      try {
        for (const handle of handles) releases.push(handle.subscribe(listener))
      } catch (error) {
        // `data.views-limit` на другому вигляді не лишає перший утриманим.
        for (const release of releases) release()
        throw error
      }
      return () => {
        for (const release of releases) release()
      }
    },
    getSnapshot() {
      const next = handles.map((handle) => handle.getSnapshot())
      if (
        last !== undefined &&
        last.length === next.length &&
        last.every((snapshot, i) => snapshot === next[i])
      ) {
        return last
      }
      last = next
      return next
    },
  }
}

/**
 * Reads the views `specs` of the core as one snapshot array. A synchronous
 * refusal of a spec (`DataError`, `TypeError`) is thrown while rendering, to
 * the error boundary (P4-B spec §6.4).
 */
export function useViews(
  source: CoreSource,
  specs: (core: CoreSession) => readonly ViewSpec[],
  specKey: string
): { snapshots: readonly ViewSnapshot[]; handles: readonly ViewHandle[] } {
  const { core } = source
  const reason = core === undefined ? source.reason : undefined
  const store = useMemo(
    // Хендл ядра мемоізований за формою, тож повторне створення сховища
    // (StrictMode, відкинутий `useMemo`) нового вигляду й запиту не дає.
    () =>
      core === undefined ? IDLE : combine(specs(core).map((s) => core.view(s))),
    // `specs` залежить лише від `specKey`: він і є канонічним образом входу.
    [core, specKey]
  )
  const snapshots = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot
  )
  return {
    snapshots: core === undefined ? closedSnapshot(reason) : snapshots,
    handles: store.handles,
  }
}
