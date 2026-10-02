import { McpServer } from "@modelcontextprotocol/server"
import { readOnlyHint } from "../tools/hints"
import { registerCatalog, type McpToolOptions } from "./tools"

/**
 * Сервер не знає транспорту: stdio підключає команда, тести — пару в пам'яті.
 * Інструменти запису видно завжди: з `--read-only` вони відмовляють із
 * поясненням, а не зникають, тож агент знає, що запис існує, і що саме
 * увімкнути.
 */
export function createMcpServer(o: McpToolOptions): McpServer {
  const instructions = [
    `Metadata tools for the directory ${o.dir}: compile, explain and the editing tools.`,
    o.readOnly
      ? readOnlyHint(o.launchArgs)
      : "Writing is enabled; destructive tools need confirm: true, and dryRun previews any change.",
  ].join(" ")
  const server = new McpServer(
    { name: "simetra", version: "0.0.1" },
    { instructions }
  )
  registerCatalog(server, o)
  return server
}
