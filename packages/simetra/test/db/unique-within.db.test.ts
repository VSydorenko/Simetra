import { describe, expect, it } from "vitest"
import type pg from "pg"
import { compile } from "simetra/compiler"
import { renderDesiredState } from "simetra/schema"
import {
  attribute,
  catalog,
  metaFiles,
  project,
} from "../../src/compiler/__tests__/helpers"
import { readCatalog } from "./catalog"
import { expectCatalogMatchesSnapshot } from "./compare"
import { withRollback } from "./connection"

/**
 * Унікальність реквізиту «в межах батька/власника» і без регістру на справжньому
 * Postgres: головне — верх ієрархії (`parent_id IS NULL`) теж унікальний, бо
 * звичайний UNIQUE вважає NULL різними значеннями.
 */

const slug = (extra: Record<string, unknown>) =>
  attribute("slug", { type: "String", length: 20, unique: true, ...extra })

async function deploy(client: pg.Client) {
  const result = await compile(
    metaFiles({
      "project.meta.json": project(),
      "catalogs/Folder/Folder.meta.json": catalog("Folder", {
        hierarchyType: "ItemsOnly",
        attributes: [slug({ uniqueWithin: "parent" })],
      }),
      "catalogs/Landlord/Landlord.meta.json": catalog("Landlord"),
      "catalogs/Child/Child.meta.json": catalog("Child", {
        owners: [{ kind: "Catalog", name: "Landlord" }],
        attributes: [slug({ unique: "ignoreCase", uniqueWithin: "owner" })],
      }),
    })
  )
  expect(result.diagnostics).toEqual([])
  await client.query(renderDesiredState(result.model!).sql)
  return result.model!
}

/** Вставка, яка мусить порушити унікальність, у власній точці збереження. */
async function violation(client: pg.Client, sql: string): Promise<string> {
  await client.query("SAVEPOINT attempt")
  try {
    await client.query(sql)
  } catch (error) {
    await client.query("ROLLBACK TO SAVEPOINT attempt")
    return (error as { code: string }).code
  }
  await client.query("RELEASE SAVEPOINT attempt")
  return "ok"
}

describe("uniqueWithin in Postgres", () => {
  it("deploys and the catalog matches the snapshot", async () => {
    await withRollback(async (client) => {
      const model = await deploy(client)
      expectCatalogMatchesSnapshot(
        await readCatalog(client, ["public"]),
        model.physical
      )
    })
  })

  it("parent: two top-level rows with the same value violate uniqueness", async () => {
    await withRollback(async (client) => {
      await deploy(client)
      await client.query(
        "INSERT INTO public.folder (id, slug) VALUES (gen_random_uuid(), 'a')"
      )
      expect(
        await violation(
          client,
          "INSERT INTO public.folder (id, slug) VALUES (gen_random_uuid(), 'a')"
        )
      ).toBe("23505")
      // Інше значення на верху й те саме значення під іншим батьком — можна.
      await client.query(
        "INSERT INTO public.folder (id, slug) VALUES (gen_random_uuid(), 'b')"
      )
      const { rows } = await client.query<{ id: string }>(
        "SELECT id FROM public.folder WHERE slug = 'a'"
      )
      const parent = rows[0]!.id
      expect(
        await violation(
          client,
          `INSERT INTO public.folder (id, slug, parent_id) VALUES (gen_random_uuid(), 'a', '${parent}')`
        )
      ).toBe("ok")
      expect(
        await violation(
          client,
          `INSERT INTO public.folder (id, slug, parent_id) VALUES (gen_random_uuid(), 'a', '${parent}')`
        )
      ).toBe("23505")
    })
  })

  it("parent: empty (NULL) values do not conflict, like plain unique", async () => {
    await withRollback(async (client) => {
      await deploy(client)
      const insert = (parent: string | null) =>
        `INSERT INTO public.folder (id, parent_id) VALUES (gen_random_uuid(), ${
          parent === null ? "NULL" : `'${parent}'`
        })`
      // Верх: два порожні значення поруч.
      await client.query(insert(null))
      expect(await violation(client, insert(null))).toBe("ok")
      const { rows } = await client.query<{ id: string }>(
        "SELECT id FROM public.folder LIMIT 1"
      )
      const parent = rows[0]!.id
      // Під одним батьком — теж.
      await client.query(insert(parent))
      expect(await violation(client, insert(parent))).toBe("ok")
      // А дублікат непорожнього значення на верху, як і раніше, порушення.
      const value = (slug: string) =>
        `INSERT INTO public.folder (id, slug) VALUES (gen_random_uuid(), '${slug}')`
      await client.query(value("dup"))
      expect(await violation(client, value("dup"))).toBe("23505")
    })
  })

  it("owner with ignoreCase: case differs but owner is the same", async () => {
    await withRollback(async (client) => {
      await deploy(client)
      const one = (
        await client.query<{ id: string }>(
          "INSERT INTO public.landlord (id) VALUES (gen_random_uuid()) RETURNING id"
        )
      ).rows[0]!.id
      const two = (
        await client.query<{ id: string }>(
          "INSERT INTO public.landlord (id) VALUES (gen_random_uuid()) RETURNING id"
        )
      ).rows[0]!.id
      const insert = (owner: string, value: string) =>
        `INSERT INTO public.child (id, owner_id, slug) VALUES (gen_random_uuid(), '${owner}', '${value}')`
      await client.query(insert(one, "Abc"))
      expect(await violation(client, insert(one, "aBC"))).toBe("23505")
      expect(await violation(client, insert(two, "aBC"))).toBe("ok")
    })
  })
})
