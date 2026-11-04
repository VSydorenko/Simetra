import { Client } from "@modelcontextprotocol/client"
import { InMemoryTransport } from "@modelcontextprotocol/server"
import { describe, expect, it } from "vitest"
import { runTool } from "../cli/command"
import { createMcpServer } from "../mcp/server"
import { invoke } from "../tools/invoke"
import { rightsMaintenanceTool } from "../tools/rights-maintenance-tool"
import type { DatabaseResource } from "../tools/types"
import { opts, project, useTmpProjects } from "./helpers/catalog"

useTmpProjects()

const USER = "00000000-0000-4000-8000-000000009801"
const input = { action: "firstGlobalAssignment", user: USER, role: "Admin" }

/** Ресурс бази, що рахує підключення: інструмент без `--yes` його не чіпає. */
function countingDatabase(): {
  resource: DatabaseResource
  connects: () => number
} {
  let connects = 0
  return {
    resource: {
      describe: "fake:5432/db",
      connect() {
        connects++
        return Promise.reject(new Error("the test database is never opened"))
      },
    },
    connects: () => connects,
  }
}

describe("rights-maintenance tool", () => {
  it("does not connect without confirmation", async () => {
    const dir = await project()
    const database = countingDatabase()
    const r = await invoke(rightsMaintenanceTool, input, {
      ...opts(dir),
      allowDatabaseWrite: true,
      confirmed: false,
      channel: "cli",
      database: database.resource,
    })
    expect(r.refusal?.reason).toBe("unconfirmed")
    expect(database.connects()).toBe(0)
  })

  it("exits 2 without --yes", async () => {
    const dir = await project()
    const r = await runTool(
      rightsMaintenanceTool,
      { _: [JSON.stringify(input), dir] },
      async () => "",
      process.cwd(),
      { SIMETRA_DATABASE_URL: "postgres://u:p@127.0.0.1:1/db" }
    )
    expect(r.exitCode).toBe(2)
    expect(r.stderr).toContain("needs confirmation")
  })

  it("is refused on the MCP channel even with confirmation", async () => {
    const dir = await project()
    const database = countingDatabase()
    const r = await invoke(rightsMaintenanceTool, input, {
      ...opts(dir),
      allowDatabaseWrite: true,
      confirmed: true,
      channel: "mcp",
      database: database.resource,
    })
    expect(r.refusal?.reason).toBe("cli-only")
    expect(database.connects()).toBe(0)
  })

  it("is absent from MCP", async () => {
    const server = createMcpServer({
      dir: await project(),
      readOnly: false,
      allowDatabaseWrite: true,
    })
    const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: "test", version: "0.0.0" })
    try {
      await server.connect(serverEnd)
      await client.connect(clientEnd)
      const names = (await client.listTools()).tools.map((t) => t.name)
      expect(names).toContain("apply")
      expect(names).not.toContain("rights-maintenance")
    } finally {
      await client.close()
    }
  })
})
