import type {
  DataRequest,
  DataResponse,
  WireReadQuery,
  WireReadResult,
} from "./envelope"

/**
 * A wire read query a source adapter can serve: both count forms are left
 * out, because counting goes through the data transport, not the adapter.
 */
export type WireRowsQuery = Exclude<WireReadQuery, { count: true }>

/** A wire read result an adapter returns: rows only, never a count. */
export type WireRowsResult = Exclude<WireReadResult, { count: unknown }>

/** Reads rows from one source (a server, a local store, a fake). */
export interface SourceAdapter {
  read(query: WireRowsQuery): Promise<WireRowsResult>
  /** `include: false` means the source cannot join related rows. */
  capabilities: { include: boolean }
}

/** Why a signal subscription failed: rejected credentials or a broken link. */
export type SignalErrorKind = "auth" | "transport"

export type Unsubscribe = () => void

/** Delivers change signals for channel topics (see `channelTopic`). */
export interface SignalTransport {
  subscribe(
    channels: readonly string[],
    onSignal: (topic: string, payload: unknown) => void,
    onError: (kind: SignalErrorKind) => void
  ): Unsubscribe
  /** Fires on every (re)subscription, so the client can resync. */
  onSubscribed(handler: () => void): Unsubscribe
}

/** Carries one request to the data handler and returns its response. */
export type DataTransport = (request: DataRequest) => Promise<DataResponse>
