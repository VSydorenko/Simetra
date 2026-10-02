import { McpServer } from "@modelcontextprotocol/server"
import { writeAccessHint } from "../tools/write-access"
import { registerCatalog, type McpToolOptions } from "./tools"

/**
 * Сервер не знає транспорту: stdio підключає команда, тести — пару в пам'яті.
 * До бази сервер не звертається, лише до теки метаданих. Інструменти запису
 * видно завжди: у режимі лише читання вони відмовляють із поясненням, а не
 * зникають, тож агент знає, що запис існує, і що саме увімкнути.
 */
export function createMcpServer(o: McpToolOptions): McpServer {
  const instructions = [
    `Metadata tools for the directory ${o.dir}: compile, explain and the editing tools.`,
    o.allowWrite
      ? "Writing is enabled; destructive tools need confirm: true, and dryRun previews any change."
      : writeAccessHint(o.launchArgs),
  ].join(" ")
  const server = new McpServer(
    { name: "simetra", version: "0.0.1" },
    { instructions }
  )
  registerCatalog(server, o)
  return server
}
