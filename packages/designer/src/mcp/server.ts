import { McpServer } from "@modelcontextprotocol/server"
import { registerTools, type McpToolOptions } from "./tools"

/**
 * Сервер не знає транспорту: stdio підключає команда, тести — пару в пам'яті.
 * До бази сервер не звертається, лише до теки метаданих.
 */
export function createMcpServer(o: McpToolOptions): McpServer {
  const server = new McpServer({ name: "simetra", version: "0.0.1" })
  registerTools(server, o)
  return server
}
