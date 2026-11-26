// Мінімальні типи `oidc-provider` 9.12.2 (пакет без власних типів): лише те,
// чим користується сервер авторизації шаблону. Розширюється разом із кодом.
declare module "oidc-provider" {
  import type { IncomingMessage, ServerResponse } from "node:http"

  export interface InteractionModel {
    uid: string
    jti: string
    params: Record<string, unknown>
    prompt: { name: string }
    result?: { consent?: { grantId?: string } }
  }

  export interface ClientModel {
    clientId: string
    clientName?: string
    clientUri?: string
    logoUri?: string
  }

  export interface GrantInstance {
    jti: string
    accountId?: string
    clientId?: string
    exp?: number
    readonly isExpired: boolean
    save(): Promise<string>
    destroy(): Promise<void>
    addOIDCScope(scope: string): void
    addResourceScope(resource: string, scope: string): void
  }

  export interface StoredToken {
    jti: string
    grantId?: string
    accountId?: string
    clientId?: string
    aud?: string | string[]
    /** Через пробіл; у токена доступу — scope ресурсу, якого він стосується. */
    scope?: string
    exp?: number
    isExpired?: boolean
    extra?: Record<string, unknown>
    jkt?: string
    "x5t#S256"?: string
  }

  export interface KoaContextWithOIDC {
    type: string
    body: unknown
    status: number
    set(field: string, value: string): void
    oidc: {
      route?: string
      session?: { destroyed?: boolean; destroy(): Promise<void> }
      result?: { login?: unknown; consent?: { grantId?: string } }
      provider: Provider
    }
  }

  export interface ProviderAdapter {
    upsert(
      id: string,
      payload: Record<string, unknown>,
      expiresIn?: number
    ): Promise<void>
    find(id: string): Promise<Record<string, unknown> | undefined>
    findByUid(uid: string): Promise<Record<string, unknown> | undefined>
    findByUserCode(
      userCode: string
    ): Promise<Record<string, unknown> | undefined>
    consume(id: string): Promise<void>
    destroy(id: string): Promise<void>
    revokeByGrantId(grantId: string): Promise<void>
  }

  export default class Provider {
    constructor(issuer: string, configuration: Record<string, unknown>)
    proxy: boolean
    issuer: string
    on(event: string, listener: (...args: never[]) => void): this
    use(
      middleware: (
        ctx: { oidc?: KoaContextWithOIDC["oidc"] },
        next: () => Promise<void>
      ) => Promise<void>
    ): void
    callback(): (req: IncomingMessage, res: ServerResponse) => Promise<void>
    interactionDetails(
      req: IncomingMessage,
      res: ServerResponse
    ): Promise<InteractionModel>
    interactionResult(
      req: IncomingMessage,
      res: ServerResponse,
      result: Record<string, unknown>,
      options?: { mergeWithLastSubmission?: boolean }
    ): Promise<string>
    Grant: {
      new (init: { accountId: string; clientId: string }): GrantInstance
      find(id: string): Promise<GrantInstance | undefined>
    }
    Client: { find(id: string): Promise<ClientModel | undefined> }
    AccessToken: { find(value: string): Promise<StoredToken | undefined> }
    AuthorizationCode: {
      find(value: string): Promise<StoredToken | undefined>
    }
    RefreshToken: { find(value: string): Promise<StoredToken | undefined> }
  }

  export const interactionPolicy: {
    Prompt: new (
      info: { name: string; requestable: boolean },
      ...checks: unknown[]
    ) => unknown
    Check: new (
      reason: string,
      description: string,
      check: (ctx: KoaContextWithOIDC) => boolean
    ) => unknown
    base(): { clear(): void; add(prompt: unknown): void }
  }

  export const errors: {
    InvalidTarget: new (description?: string) => Error
    InvalidGrant: new (description?: string) => Error
    SessionNotFound: new (description?: string) => Error
  }
}
