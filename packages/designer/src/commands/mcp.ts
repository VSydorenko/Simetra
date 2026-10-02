import { defineCommand } from "citty"
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio"
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
    const dir = (args.dir ?? "./metadata").replace(/(?<=.)[\\/]+$/, "")
    // Stdout — канал протоколу, тож нічого зайвого в нього не друкуємо.
    await createMcpServer({
      dir,
      allowWrite: args["allow-write"],
    }).connect(new StdioServerTransport())
  },
})
