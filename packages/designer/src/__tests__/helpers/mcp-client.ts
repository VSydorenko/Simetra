import { Client } from "@modelcontextprotocol/client"
import { InMemoryTransport } from "@modelcontextprotocol/server"
import { createMcpServer } from "../../mcp/server"
import type { McpToolOptions } from "../../mcp/tools"

/**
 * Клієнт MCP, з'єднаний із сервером каталогу в пам'яті: той самий шлях, що й
 * в агента (`createMcpServer` + пара транспортів). Закриває клієнт викликач.
 * Окремий файл без залежностей від бази, щоб ним користувалися й юніт-тести
 * (`mcp.test.ts`), і DB-тести (`database-tools.support.ts`).
 */
export async function connectMcp(o: McpToolOptions): Promise<Client> {
  const server = createMcpServer(o)
  const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: "test", version: "0.0.0" })
  await server.connect(serverEnd)
  await client.connect(clientEnd)
  return client
}
