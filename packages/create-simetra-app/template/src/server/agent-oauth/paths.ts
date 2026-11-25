// Легкий модуль без `oidc-provider`: його імпортує entry (знахідка 7 F0)

/** Шлях ресурсу MCP під походженням застосунку: токен обов'язково прив'язаний до нього. */
export const AGENT_MCP_PATH = "/mcp"

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
