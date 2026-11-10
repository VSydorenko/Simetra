import type {
  DataRequest,
  DataResponse,
  WireReadPart,
  WireReadParts,
  WireReadQuery,
} from "./envelope"

/**
 * A wire read query a source adapter can serve: both count forms are left
 * out, because counting goes through the data transport, not the adapter.
 */
export type WireRowsQuery = Exclude<WireReadQuery, { count: true }>

/**
 * A part an adapter is asked to read: a rows query part. The catalog
 * `version` part goes through the data transport, not the adapter.
 */
export type WireQueryPart = Omit<
  Extract<WireReadPart, { type: "query" }>,
  "query"
> & { query: WireRowsQuery }

/**
 * Reads parts from one source (a server, a local store, a fake): one request,
 * one outcome per part in request order. A failure of the whole request
 * rejects with `CommandFailure`.
 */
export interface SourceAdapter {
  read(items: readonly WireQueryPart[]): Promise<WireReadParts>
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
