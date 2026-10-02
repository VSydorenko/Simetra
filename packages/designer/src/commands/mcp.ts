import { defineCommand } from "citty"
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio"
import { databaseResource } from "../io/database"
import { DEFAULT_DIR, trimSlash } from "../io/default-dir"
import { DEFAULT_DATABASE_URL_ENV } from "../tools/hints"
import { createMcpServer } from "../mcp/server"

export default defineCommand({
  meta: {
    name: "mcp",
    description: "Serve the compiler operations over MCP (stdio)",
  },
  args: {
    dir: {
      type: "positional",
      description: "Metadata directory (default: ./metadata)",
      required: false,
    },
    "read-only": {
      type: "boolean",
      default: false,
      description: "Refuse the tools that write",
    },
    "database-url-env": {
      type: "string",
      default: DEFAULT_DATABASE_URL_ENV,
      description:
        "Environment variable with the connection string of the target database",
    },
    "shadow-url-env": {
      type: "string",
      description:
        "Environment variable with a connection string to another server of the same PostgreSQL major version for the shadow database",
    },
  },
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
      database: databaseResource(process.env, {
        url: databaseEnv,
        ...(shadow === undefined ? {} : { shadow }),
      }),
      databaseEnv,
      launchArgs: process.argv.slice(2),
    }).connect(new StdioServerTransport())
  },
})
