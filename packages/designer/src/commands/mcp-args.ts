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
  // Без типового значення: доступ до даних від імені користувача — явне
  // рішення людини, а не тиха змінна середовища (Р-A5-11)
  "data-url-env": {
    type: "string",
    description:
      "Environment variable with the connection string of the runtime login role to the development database; enables the data tools together with --as",
  },
  as: {
    type: "string",
    description:
      "UUID of the user the data tools act as, with that user's rights",
  },
  agent: {
    type: "string",
    description:
      "UUID of the agent, recorded as the act claim; it grants no rights",
  },
  "allow-data-write": {
    type: "boolean",
    default: false,
    description: "Let data-command change application data",
  },
  "allow-rights-write": {
    type: "boolean",
    default: false,
    description:
      "Let data-command write rights catalogs and create scope roots whose creator receives a role",
  },
} satisfies ArgsDef
