import type { ArgsDef } from "citty"
import { DEFAULT_DATABASE_URL_ENV } from "../tools/hints"

/**
 * Аргументи `simetra mcp` окремим легким модулем: за цим же описом `init`
 * розбирає `args` записів MCP-конфігів, і йому не треба тягнути сервер.
 */
export const mcpArgs = {
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
  "allow-database-write": {
    type: "boolean",
    default: false,
    description:
      "Let apply write to the database (it still needs confirm and the plan hash)",
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
} satisfies ArgsDef
