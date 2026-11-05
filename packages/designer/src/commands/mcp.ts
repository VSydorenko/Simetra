import { defineCommand, type ParsedArgs } from "citty"
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio"
import { checkEnvName, dataResource, parseDataLaunch } from "../io/data"
import { databaseResource } from "../io/database"
import { DEFAULT_DIR, trimSlash } from "../io/default-dir"
import { UsageError } from "../io/usage-error"
import { createMcpServer } from "../mcp/server"
import type { McpToolOptions } from "../mcp/tools"
import { mcpArgs } from "./mcp-args"

/**
 * Опції сервера з argv і середовища запуску — чиста функція, щоб умови
 * запуску перевірялися без stdio. Імена змінних фіксуються тут: агент не
 * може спрямувати виклик на іншу базу чи діяти від чужого імені, а відмова
 * без підключення називає саме цю змінну. Ім'я перевіряється до будь-якого
 * тексту: підказки й `instructions` повторюють argv, тож рядок підключення,
 * переданий замість імені, потрапив би агентові.
 */
export function mcpOptionsFrom(
  args: ParsedArgs<typeof mcpArgs>,
  env: NodeJS.ProcessEnv,
  argv: readonly string[]
): McpToolOptions {
  const databaseEnv = args["database-url-env"]
  const shadow = args["shadow-url-env"]
  checkEnvName("--database-url-env", databaseEnv)
  if (shadow !== undefined) checkEnvName("--shadow-url-env", shadow)
  const launch = parseDataLaunch({
    dataUrlEnv: args["data-url-env"],
    as: args.as,
    agent: args.agent,
  })
  const data = launch === undefined ? undefined : dataResource(env, launch)
  return {
    dir: trimSlash(args.dir ?? DEFAULT_DIR),
    readOnly: args["read-only"],
    allowDatabaseWrite: args["allow-database-write"],
    allowDataWrite: args["allow-data-write"],
    allowRightsWrite: args["allow-rights-write"],
    database: databaseResource(env, {
      url: databaseEnv,
      ...(shadow === undefined ? {} : { shadow }),
    }),
    databaseEnv,
    ...(data === undefined ? {} : { data }),
    ...(launch === undefined ? {} : { dataEnv: launch.urlEnv }),
    launchArgs: argv,
  }
}

export default defineCommand({
  meta: {
    name: "mcp",
    description: "Serve the compiler operations over MCP (stdio)",
  },
  args: mcpArgs,
  async run({ args }) {
    let options: McpToolOptions
    try {
      options = mcpOptionsFrom(args, process.env, process.argv.slice(2))
    } catch (error) {
      // Помилка запуску — код 2 (як помилки використання CLI); текст не
      // містить значень прапорців
      if (!(error instanceof UsageError)) throw error
      process.stderr.write(`error: ${error.message}\n`)
      process.exitCode = 2
      return
    }
    // Stdout — канал протоколу, тож нічого зайвого в нього не друкуємо.
    await createMcpServer(options).connect(new StdioServerTransport())
  },
})
