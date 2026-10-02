import { defineCommand } from "citty"
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio"
import { DEFAULT_DIR, trimSlash } from "../io/default-dir"
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
    "allow-write": {
      type: "boolean",
      default: false,
      description: "Also expose the tools that change files",
    },
  },
  async run({ args }) {
    const dir = trimSlash(args.dir ?? DEFAULT_DIR)
    // Stdout — канал протоколу, тож нічого зайвого в нього не друкуємо.
    await createMcpServer({
      dir,
      allowWrite: args["allow-write"],
      launchArgs: process.argv.slice(2),
    }).connect(new StdioServerTransport())
  },
})
