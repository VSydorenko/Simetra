import { randomUUID } from "node:crypto"
import type pg from "pg"
import { expect } from "vitest"
import type { CompiledModel } from "simetra/compiler"
import {
  RIGHTS_ADMIN_ID,
  ROLE_FILE,
  adminRoles,
  catalog,
  compileRights,
  grant,
  objects,
  policyDomain,
  refAttribute,
  role,
  type Layer,
} from "../../src/compiler/__tests__/fixtures/rights"
import { uuid } from "../../src/compiler/__tests__/helpers"
import { signUp } from "./auth"
import { type Seed, assignmentRow, insert, profileLayer } from "./rights-seed"

/**
 * Модель і засів опису «умовний `publicRead`» (D1): два умовні довідники —
 * `Notice` (гість, ТЧ `items`, прив'язка до контейнера `project`) і `Memo`
 * (роль `authenticated`, без ТЧ) — поверх домену політик. Спільне для
 * `public-read-published.db.test.ts` і гейта планів.
 */

export const NOTICE_TABLE = "notice"
export const NOTICE_ITEMS_TABLE = "notice_items"
export const MEMO_TABLE = "memo"

export const NOTICE_ID = uuid(9850)
export const MEMO_ID = uuid(9860)
export const NOTICE_READER_ID = uuid(9870)
export const NOTICE_WRITER_ID = uuid(9871)
export const NOTICE_PUBLISHER_ID = uuid(9872)
export const NOTICE_PROJECT_READER_ID = uuid(9873)

const ref = (kind: string, name: string) => ({ kind, name })
const CONDITION_ANON = { role: "anon", published: true }
const CONDITION_AUTHENTICATED = { role: "authenticated", published: true }

/** Функція запобіжника читання `Notice`: її кличе тест гілки `rowBranch`. */
export const NOTICE_GUARD = "guard_notice_read"

/** Довідники й ролі D1 поверх `policyDomain()`. */
export function publicReadPublishedLayer(): Layer {
  const notice = objects(["Catalog", "Notice"])
  const memo = objects(["Catalog", "Memo"])
  return {
    [`catalogs/Notice/Notice.meta.json`]: catalog(
      NOTICE_ID,
      "Notice",
      NOTICE_TABLE,
      {
        publicRead: CONDITION_ANON,
        containerBinding: "project",
        attributes: [
          refAttribute(
            9851,
            "project",
            "project_id",
            ref("Catalog", "Project")
          ),
          {
            id: uuid(9852),
            name: "headline",
            physicalName: "headline",
            type: "String",
            length: 100,
          },
        ],
        tabularSections: [
          {
            id: uuid(9853),
            name: "items",
            physicalName: NOTICE_ITEMS_TABLE,
            attributes: [
              {
                id: uuid(9854),
                name: "text",
                physicalName: "text",
                type: "String",
                length: 100,
              },
            ],
          },
        ],
      }
    ),
    [`catalogs/Memo/Memo.meta.json`]: catalog(MEMO_ID, "Memo", MEMO_TABLE, {
      publicRead: CONDITION_AUTHENTICATED,
    }),
    [ROLE_FILE("NoticeReader")]: role(
      NOTICE_READER_ID,
      "NoticeReader",
      { scopeKind: "org" },
      { grants: [grant([...notice, ...memo], ["read"], "any")] }
    ),
    // Без `publish`: «публікація — окреме право».
    [ROLE_FILE("NoticeWriter")]: role(
      NOTICE_WRITER_ID,
      "NoticeWriter",
      { scopeKind: "org" },
      {
        grants: [
          grant(notice, ["read", "create", "update", "markDeletion"], "any"),
        ],
      }
    ),
    // Без `update`: `publish` не вимагає зміни змісту.
    [ROLE_FILE("NoticePublisher")]: role(
      NOTICE_PUBLISHER_ID,
      "NoticePublisher",
      { scopeKind: "org" },
      {
        grants: [
          grant(
            notice,
            ["read", "publish", "unpublish", "markDeletion"],
            "any"
          ),
        ],
      }
    ),
    // Контейнерна роль: її гранти до членства не прив'язані (Р-D1-16).
    [ROLE_FILE("NoticeProjectReader")]: role(
      NOTICE_PROJECT_READER_ID,
      "NoticeProjectReader",
      { container: ref("Catalog", "Project") },
      { grants: [grant(notice, ["read"], "any")] }
    ),
  }
}

/** Запобіжник читання `Notice` із декларацією виклику ролі користувача. */
function guardFiles(): Map<string, string> {
  return new Map([
    [
      "sql/public/pub-guards.sql",
      `CREATE FUNCTION public.${NOTICE_GUARD}(p_row uuid) RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$BEGIN PERFORM simetra.rights_require('read', '${NOTICE_TABLE}', p_row); END$$;\n`,
    ],
    [
      "sql/public/pub-guards.functions.json",
      JSON.stringify({
        functions: [
          {
            id: uuid(9880),
            function: { name: NOTICE_GUARD },
            callers: ["user"],
            check: {
              action: "read",
              object: { kind: "Catalog", name: "Notice" },
              row: "p_row",
            },
          },
        ],
      }),
    ],
  ])
}

/** Модель під профіль прогону; `extra` — шари поверх (гейт планів). */
export async function publicReadPublishedModel(
  ...extra: Layer[]
): Promise<CompiledModel> {
  const files = policyDomain(
    adminRoles(),
    publicReadPublishedLayer(),
    profileLayer(),
    ...extra
  )
  for (const [path, text] of guardFiles()) files.set(path, text)
  const result = await compileRights(files)
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
  return result.model!
}

/** Стани рядка шапки: ключ засіву → тенант, публікація, позначка. */
export const NOTICE_STATES = [
  // [ключ, тенант, published, deletion_mark, проєкт]
  ["dA", "A", false, false, "P1"],
  ["dB", "B", false, false, null],
  ["pA", "A", true, false, null],
  ["pB", "B", true, false, null],
  ["mA", "A", true, true, null],
  // Чернетка з позначкою: база для «позначений не публікується».
  ["kA", "A", false, true, null],
] as const

/**
 * Засів: тенанти A і B; користувачі `rA` (читання), `rB` (читання в B), `wA`
 * (запис без публікації), `pU` (публікація без `update`), `nobody` (без
 * членства), `admin` (адміністратор прав і читання A), `cA` (учасник A з
 * контейнерною роллю на P1 без ролей скоупу). Рядки `Notice` — усі стани
 * `NOTICE_STATES`, кожен з рядком ТЧ `<ключ>.l1`; `Memo` — чернетка `mdA` і
 * опублікований `mpA` тенанта A.
 */
export async function seedPublicRead(client: pg.Client): Promise<Seed> {
  const ids: Seed = {}
  const create = async (
    key: string,
    table: string,
    values: Record<string, unknown> = {}
  ) => {
    ids[key] = randomUUID()
    await insert(client, table, { id: ids[key], ...values })
  }
  for (const user of ["rA", "rB", "wA", "pU", "nobody", "admin", "cA"])
    ids[user] = await signUp(client)
  await create("A", "organization")
  await create("B", "organization")
  await create("P1", "project", { org_id: ids.A })
  const roles: [user: string, org: string, archetypes: string[]][] = [
    ["rA", "A", [NOTICE_READER_ID]],
    ["rB", "B", [NOTICE_READER_ID]],
    ["wA", "A", [NOTICE_WRITER_ID]],
    ["pU", "A", [NOTICE_PUBLISHER_ID]],
    ["admin", "A", [RIGHTS_ADMIN_ID, NOTICE_READER_ID]],
    ["cA", "A", []],
  ]
  for (const [user, org, archetypes] of roles) {
    const member = `${user}@${org}`
    await create(member, "org_member", {
      org_id: ids[org],
      user_id: ids[user],
    })
    for (const archetype of archetypes)
      await insert(client, "org_role_assignments", {
        org_id: ids[org],
        ...assignmentRow(ids[member]!, { archetype }),
      })
  }
  await insert(client, "org_role_assignments", {
    org_id: ids.A,
    ...assignmentRow(ids["cA@A"]!, {
      archetype: NOTICE_PROJECT_READER_ID,
      container: ids.P1,
    }),
  })
  for (const [key, org, published, mark, project] of NOTICE_STATES) {
    await create(key, NOTICE_TABLE, {
      org_id: ids[org],
      published,
      deletion_mark: mark,
      headline: key,
      project_id: project === null ? null : ids[project],
    })
    await create(`${key}.l1`, NOTICE_ITEMS_TABLE, {
      org_id: ids[org],
      parent_id: ids[key],
      line_number: 1,
      text: key,
    })
  }
  await create("mdA", MEMO_TABLE, { org_id: ids.A })
  await create("mpA", MEMO_TABLE, { org_id: ids.A, published: true })
  return ids
}
