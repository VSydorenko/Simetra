import { McpServer } from "@modelcontextprotocol/server"
import { databaseWriteHint, readOnlyHint } from "../tools/hints"
import { registerCatalog, type McpToolOptions } from "./tools"

/**
 * Сервер не знає транспорту: stdio підключає команда, тести — пару в пам'яті.
 * Інструменти запису видно завжди: з `--read-only` вони відмовляють із
 * поясненням, а не зникають, тож агент знає, що запис існує, і що саме
 * увімкнути.
 */
export function createMcpServer(o: McpToolOptions): McpServer {
  const instructions = [
    `Metadata tools for the directory ${o.dir}: compile, explain, the editing tools, and introspect, diff, plan and apply against the database named by the server's environment.`,
    o.readOnly
      ? readOnlyHint(o.launchArgs)
      : "Writing is enabled; destructive tools need confirm: true, and dryRun previews any file change.",
    // Запис у базу — окреме рішення людини при запуску; `dryRun` його не
    // переглядає: перегляд дає `plan`, перевірку на цілі — `rehearse`
    // Під `--read-only` речення про запис у базу пропускаємо: `readOnlyHint`
    // уже каже, що інструменти запису вимкнено, а порада додати прапорець
    // була б хибною — спершу треба зняти `--read-only`
    ...(o.readOnly
      ? []
      : [
          o.allowDatabaseWrite === true
            ? "Database writes are enabled: apply needs confirm: true and the planHash of the plan you showed."
            : databaseWriteHint(o.launchArgs, { refusal: false }),
        ]),
    "dryRun does not apply to apply: review with plan, and rehearse it before applying.",
  ].join(" ")
  const server = new McpServer(
    { name: "simetra", version: "0.0.1" },
    { instructions }
  )
  registerCatalog(server, o)
  return server
}
