import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { installedPackageDir } from "../io/package-path"
import { schemaPathResolver } from "../io/schema-path"
import { UsageError } from "../io/usage-error"
import { toolByName } from "../tools/catalog"
import { invoke } from "../tools/invoke"
import { opts } from "./helpers/catalog"

const roots: string[] = []
const tmp = async () => {
  const root = await mkdtemp(join(tmpdir(), "simetra-designer-"))
  roots.push(root)
  return root
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true })))
})

describe("installedPackageDir", () => {
  it("resolves through node_modules/<pkg>, not through the symlink target", async () => {
    const root = await tmp()
    const store = join(root, "store/simetra")
    const proj = join(root, "proj")
    await mkdir(join(store, "schemas"), { recursive: true })
    await writeFile(join(store, "package.json"), "{}")
    await writeFile(join(store, "schemas/catalogs.schema.json"), "{}")
    await mkdir(join(proj, "node_modules"), { recursive: true })
    await symlink(store, join(proj, "node_modules/simetra"), "dir")
    expect(
      installedPackageDir(join(proj, "metadata/catalogs"), "simetra")
    ).toBe(join(proj, "node_modules/simetra"))
    expect(
      schemaPathResolver(join(proj, "metadata"))(
        "catalogs/A/A.meta.json",
        "catalogs.schema.json"
      )
    ).toBe("../../../node_modules/simetra/schemas/catalogs.schema.json")
  })

  it("names the package and the dir when it is not installed", async () => {
    const root = await tmp()
    const dir = join(root, "metadata")
    await mkdir(dir)
    expect(() => installedPackageDir(dir, "simetra")).toThrow(UsageError)
    expect(() => installedPackageDir(dir, "simetra")).toThrow(
      `simetra is not installed in node_modules above ${dir}`
    )
  })

  it("fix in a project without simetra installed is refused, not thrown", async () => {
    const root = await tmp()
    const dir = join(root, "metadata")
    await mkdir(dir)
    await writeFile(
      join(dir, "project.meta.json"),
      JSON.stringify({ name: "p", kind: "Project" })
    )
    const r = await invoke(toolByName("fix")!, {}, opts(dir))
    expect(r.refusal).toMatchObject({ reason: "refused" })
    expect(r.refusal?.message).toContain("simetra is not installed")
  })
})
