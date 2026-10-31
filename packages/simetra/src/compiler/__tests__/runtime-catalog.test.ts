import { beforeAll, describe, expect, it } from "vitest"
import { canonicalSnapshot, type CompiledModel } from "simetra/compiler"
import { modelHash } from "../canonical"
import {
  adminRoles,
  commandCoreLayer,
  compileRights,
  policyDomain,
  ticketNoticeHandler,
  withSql,
  writeRoles,
} from "./fixtures/rights"

const files = () =>
  withSql(
    policyDomain(
      writeRoles(),
      adminRoles(),
      commandCoreLayer(),
      ticketNoticeHandler().layer
    ),
    ticketNoticeHandler()
  )

async function compiled(): Promise<CompiledModel> {
  const { model, diagnostics } = await compileRights(files())
  expect(diagnostics).toEqual([])
  return model!
}

let model: CompiledModel
beforeAll(async () => {
  model = await compiled()
})

describe("CompiledModel.catalogCommands", () => {
  it("is the set the core SQL is generated from", () => {
    const saves = model.sqlUnits
      .filter((u) => u.generator === "catalogCommand" && u.class === "function")
      .map((u) => u.identity)
      .filter((identity) => identity.includes("_save("))
      .sort()
    expect(
      model.catalogCommands
        .map(
          (c) =>
            `function:${c.functions.save.schema}.${c.functions.save.name}(jsonb,int8)`
        )
        .sort()
    ).toEqual(saves)
    expect(saves.length).toBeGreaterThan(0)
  })

  // Похідне поле не входить у знімок: інакше хеш залежав би від форми
  // контракту, якої застосування не бачить.
  it("stays outside the canonical snapshot and the hash", async () => {
    expect(canonicalSnapshot(model)).not.toHaveProperty("catalogCommands")
    expect(await modelHash({ ...model, catalogCommands: [] })).toBe(model.hash)
  })
})
