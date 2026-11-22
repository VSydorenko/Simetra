import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  PINNED_SESSION_SETTINGS,
  PROVIDER_API_ROLES,
  PROVIDER_OWNER_ROLES,
} from "simetra/model"
import { databaseResource } from "../io/database"
import { testProvider } from "../../../simetra/test/support"
import { query } from "./support/db"
import {
  connectMcpClient,
  ENV,
  freshProject,
  inTarget,
  useDatabaseToolsCleanup,
} from "./database-tools.support"

/**
 * Прийом з нуля через каталог інструментів MCP (інваріант Б7 плану #271 Д4):
 * `introspect` → `add` виду скоупу → `declare-function` із `check` → `fix` →
 * `compile` → `plan` → `apply` → порожній наступний `plan`. Агент не пише
 * жодного файлу сам; запобіжник у тілі RPC вставляє `fix`. Спільне для файлів
 * обох профілів: ролі профілю різні, а ланцюжок однаковий.
 */

const ROLES = PROVIDER_API_ROLES[testProvider()]
/** Ролі API, що мають `EXECUTE` на RPC у джерелі: користувач і сервісна (якщо є). */
const RPC_ROLES = [
  ROLES.user,
  ...(ROLES.service === null ? [] : [ROLES.service]),
]

/** Опції `SET` закріплених налаштувань сесії кореня голови (спека декларацій функцій §5.8). */
const PINNED_SETTINGS = PINNED_SESSION_SETTINGS.map(
  (s) => `SET ${s.name} = '${s.value}'`
).join(" ")

// Тіло RPC без запобіжника й без `DECLARE` та `EXCEPTION` — єдина форма, у яку
// `fix` вставляє виклик сам. Волатильність типова (VOLATILE), без явного слова:
// каталог її не друкує, а закрита оболонка вимагає явно — `introspect` дописує
const SOURCE = `
  CREATE SCHEMA app;
  CREATE TABLE app.org (id uuid PRIMARY KEY, name text NOT NULL);
  CREATE TABLE app.item (
    id uuid PRIMARY KEY,
    org_id uuid NOT NULL REFERENCES app.org (id),
    name text NOT NULL
  );
  CREATE FUNCTION app.org_ids() RETURNS SETOF uuid LANGUAGE sql STABLE
    SECURITY DEFINER SET search_path = '' ${PINNED_SETTINGS} AS $$ SELECT id FROM app.org $$;
  CREATE FUNCTION app.rpc_post(p_id uuid) RETURNS void LANGUAGE plpgsql
    SECURITY DEFINER SET search_path = '' AS $$
  BEGIN
    PERFORM 1 FROM app.item WHERE id = p_id;
  END
  $$;
  ${RPC_ROLES.map((r) => `GRANT USAGE ON SCHEMA app TO "${r}";`).join("\n  ")}
  REVOKE EXECUTE ON FUNCTION app.org_ids() FROM PUBLIC;
  REVOKE EXECUTE ON FUNCTION app.rpc_post(uuid) FROM PUBLIC;
  ${RPC_ROLES.map((r) => `GRANT EXECUTE ON FUNCTION app.org_ids() TO "${r}";`).join("\n  ")}
  ${RPC_ROLES.map((r) => `GRANT EXECUTE ON FUNCTION app.rpc_post(uuid) TO "${r}";`).join("\n  ")}
`

interface Out {
  ok: boolean
  written: boolean
  diagnostics: { severity: string; code: string }[]
  file?: string
  planHash?: string
  requiredPermissions?: string[]
  unchanged?: true
  status?: string
}

const errorCodes = (out: Out): string[] =>
  out.diagnostics.filter((d) => d.severity === "error").map((d) => d.code)

/** Список `EXECUTE` функції в базі: `роль=X/власник`, відсортовано. */
async function executeAcl(url: string, fn: string): Promise<string[]> {
  const rows = await query<{ acl: string }>(
    url,
    `select unnest(proacl)::text as acl from pg_proc where oid = '${fn}'::regprocedure`
  )
  return rows.map((r) => r.acl).sort()
}

export function describeAdoptionThroughMcp(): void {
  useDatabaseToolsCleanup()

  describe("adoption from scratch through the MCP tool catalog", () => {
    it("introspect, add, declare-function, fix, compile, plan and apply reach an empty plan", async () => {
      await inTarget(SOURCE, ["app"], async (url) => {
        const dir = await freshProject()
        const client = await connectMcpClient({
          dir,
          readOnly: false,
          allowDatabaseWrite: true,
          database: databaseResource({ [ENV]: url }, { url: ENV }),
          databaseEnv: ENV,
        })
        const run = async (
          name: string,
          args: Record<string, unknown> = {}
        ): Promise<Out> =>
          (await client.callTool({ name, arguments: args }))
            .structuredContent as unknown as Out

        // 1. Читання бази: тека класу ремонту — RPC без запобіжника й множина скоупу без `check`
        const read = await run("introspect", {
          schemas: ["app"],
          project: {
            name: "Adopted",
            attributeCase: "snake_case",
            database: { provider: testProvider() },
          },
        })
        expect(read.written).toBe(true)
        expect(errorCodes(read).sort()).toEqual([
          "sql.declaration-check-missing",
          "sql.declaration-check-missing",
        ])

        // 2. Вид скоупу: `app.org_ids` стає формою платформи й губить декларацію
        const scoped = await run("add", {
          target: { kind: "Project" },
          collection: "scopeKinds",
          element: {
            name: "org",
            root: { object: { kind: "CustomTable", name: "Org" } },
            setFunction: { name: "org_ids" },
          },
          scopes: {
            Org: { scope: "org" },
            Item: { scope: "org", scopeColumn: "org_id" },
          },
        })
        expect(scoped.written).toBe(true)
        expect(errorCodes(scoped)).toEqual(["sql.declaration-check-missing"])

        // 3. Об'єкт із контрактом прав: `CustomTable` його не має, а `check`
        // називає лише об'єкт з правами
        const note = await run("create", {
          kind: "Catalog",
          name: "Note",
          data: { schema: "app", scope: "none" },
        })
        expect(note.written).toBe(true)
        expect(errorCodes(note)).toEqual(["sql.declaration-check-missing"])

        // 4. Декларація RPC з перевіркою: тіло її ще не застосовує
        const label = (
          JSON.parse(
            await readFile(join(dir, "catalogs/Note/Note.meta.json"), "utf8")
          ) as { kindLabel: string }
        ).kindLabel
        const declared = await run("declare-function", {
          function: { name: "rpc_post" },
          callers: RPC_ROLES.map((r) =>
            r === ROLES.user ? "user" : "service"
          ),
          check: {
            action: "read",
            object: { kind: "Catalog", name: "Note" },
          },
        })
        expect(declared.written).toBe(true)
        expect(errorCodes(declared)).toEqual([
          "sql.declaration-check-not-applied",
        ])

        // 5. `fix` вставляє запобіжник першим оператором тіла
        const fixed = await run("fix")
        expect(errorCodes(fixed)).toEqual([])
        expect(fixed.written).toBe(true)
        const sql = await readFile(
          join(dir, "sql/app/rpc_post__uuid.sql"),
          "utf8"
        )
        expect(sql).toContain(
          `PERFORM simetra.rights_require('read', '${label}', NULL);`
        )

        // 6. Тека компілюється без помилок
        const compiled = await run("compile")
        expect(compiled.ok).toBe(true)
        expect(errorCodes(compiled)).toEqual([])

        // 7. План і застосування; `apply` без `confirm` не працює
        const planned = await run("plan")
        expect(errorCodes(planned)).toEqual([])
        expect(planned.written).toBe(true)
        const applied = await run("apply", {
          plan: planned.file,
          planHash: planned.planHash,
          allow: planned.requiredPermissions,
          confirm: true,
        })
        expect(errorCodes(applied)).toEqual([])
        expect(applied.status).toBe("committed")
        expect(existsSync(join(dirname(dir), planned.file!))).toBe(true)

        // 8. Наступний план порожній
        const next = await run("plan")
        expect(errorCodes(next)).toEqual([])
        expect(next.unchanged).toBe(true)

        // ACL RPC у цілі — буквальний перелік: власник і ролі викликачів;
        // ні `PUBLIC`, ні анонімної ролі
        const owner = PROVIDER_OWNER_ROLES[testProvider()]
        const owners = await query<{ owner: string }>(
          url,
          "select proowner::regrole::text as owner from pg_proc where oid = 'app.rpc_post(uuid)'::regprocedure"
        )
        const real = owners[0]!.owner
        expect(real).toBe(owner)
        expect(await executeAcl(url, "app.rpc_post(uuid)")).toEqual(
          [owner, ...RPC_ROLES].map((r) => `${r}=X/${owner}`).sort()
        )
      })
    })
  })
}
