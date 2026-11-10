import type pg from "pg"
import { compile } from "simetra/compiler"
import { renderDesiredState } from "simetra/schema"
import {
  expectClean,
  attribute,
  catalog,
  metaFiles,
  project,
  uuid,
} from "../../src/compiler/__tests__/helpers"
import { testProvider } from "./profile"

/**
 * Спільна модель членства DB-тестів `membership` обох стеків: вид скоупу
 * `org` з довідником членства `OrgMember` у схемі `public`, скомпільований під
 * профіль прогону.
 */
export async function deployMembership(client: pg.Client): Promise<void> {
  const result = await compile(
    metaFiles({
      "project.meta.json": project({
        database: { provider: testProvider() },
        scopeKinds: [
          {
            id: uuid(80),
            name: "org",
            physicalName: "org_id",
            root: { object: { kind: "Catalog", name: "Organization" } },
            setFunction: "membership",
          },
        ],
      }),
      "catalogs/Organization/Organization.meta.json": catalog("Organization", {
        scope: "org",
      }),
      "catalogs/Users/Users.meta.json": catalog("Users", {
        role: "users",
        scope: "none",
      }),
      "catalogs/OrgMember/OrgMember.meta.json": catalog("OrgMember", {
        scope: "org",
        membership: { user: "user" },
        attributes: [
          attribute("user", {
            physicalName: "user_id",
            type: "Ref",
            ref: { kind: "Catalog", name: "Users" },
          }),
        ],
      }),
    })
  )
  expectClean(result, { allow: ["rights.scope-kind-unread"] })
  await client.query(renderDesiredState(result.model!).sql)
}

export async function organization(client: pg.Client): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    "INSERT INTO public.organization (id, description) VALUES (gen_random_uuid(), 'Org') RETURNING id"
  )
  return rows[0]!.id
}

export async function member(
  client: pg.Client,
  org: string,
  user: string | null
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    "INSERT INTO public.org_member (id, org_id, user_id) VALUES (gen_random_uuid(), $1, $2) RETURNING id",
    [org, user]
  )
  return rows[0]!.id
}
