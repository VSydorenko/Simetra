import { defineCommand } from "citty"
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio"
import { databaseResource } from "../io/database"
import { DEFAULT_DIR, trimSlash } from "../io/default-dir"
import { createMcpServer } from "../mcp/server"
import { mcpArgs } from "./mcp-args"

export default defineCommand({
  meta: {
    name: "mcp",
    description: "Serve the compiler operations over MCP (stdio)",
  },
  args: mcpArgs,
  async run({ args }) {
    const dir = trimSlash(args.dir ?? DEFAULT_DIR)
    // Імена змінних фіксуються при запуску: агент не може спрямувати виклик
    // на іншу базу, а відмова без підключення називає саме цю змінну
    const databaseEnv = args["database-url-env"]
    const shadow = args["shadow-url-env"]
    // Stdout — канал протоколу, тож нічого зайвого в нього не друкуємо.
    await createMcpServer({
      dir,
      readOnly: args["read-only"],
      allowDatabaseWrite: args["allow-database-write"],
      database: databaseResource(process.env, {
        url: databaseEnv,
        ...(shadow === undefined ? {} : { shadow }),
      }),
      databaseEnv,
      launchArgs: process.argv.slice(2),
    }).connect(new StdioServerTransport())
  },
})
