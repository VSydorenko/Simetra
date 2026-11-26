// Легкий модуль без `oidc-provider`: його імпортує entry (знахідка 7 F0)

/** Шлях ресурсу MCP під походженням застосунку: токен обов'язково прив'язаний до нього. */
export const AGENT_MCP_PATH = "/mcp"

/** Метадані захищеного ресурсу (RFC 9728) для `AGENT_MCP_PATH`; шлях будує адаптер MCP так само. */
export const AGENT_PRM_PATH = `/.well-known/oauth-protected-resource${AGENT_MCP_PATH}`

/** Шляхи входу MCP (Р-F4-5): їх обслуговує адаптер, а не Start і не сервер авторизації. */
export function isAgentEntryPath(pathname: string): boolean {
  return pathname === AGENT_MCP_PATH || pathname === AGENT_PRM_PATH
}

/** Сторінка взаємодії: бібліотека ставить cookie `_interaction` саме з цим шляхом. */
export const agentConnectPath = (uid: string): string => `/agent/connect/${uid}`

/** `uid` зі шляху сторінки взаємодії; інший шлях — `undefined`. */
export function agentConnectUid(pathname: string): string | undefined {
  return /^\/agent\/connect\/([^/]+)$/.exec(pathname)?.[1]
}

/** Шляхи, які віддаються сервера авторизації (спека П4-F §5.4); решта йде в Start. */
const AGENT_OAUTH_PATHS: readonly RegExp[] = [
  /^\/\.well-known\/oauth-authorization-server$/,
  /^\/authorize(\/[^/]+)?$/,
  /^\/token$/,
  /^\/revoke$/,
  /^\/jwks$/,
]

export function isAgentOauthPath(pathname: string): boolean {
  return AGENT_OAUTH_PATHS.some((p) => p.test(pathname))
}
