---
name: simetra-adoption
description: Use when bringing an existing live PostgreSQL database under Simetra metadata for the first time — reading its schemas into a `metadata/` directory with `simetra introspect`, then proving with `simetra diff` that the metadata and the database match. Covers choosing the scope (`--schemas`, `--tables`), the connection and shadow database settings, exit codes, and how to treat unrepresentable objects and non-empty results. Not for everyday editing of metadata (that is `simetra-metadata`).
---

# Simetra adoption — introspect a live database, then diff

Adoption is a one-time onboarding: the database already exists, and the
metadata is derived from it. `introspect` reads the database into metadata;
`diff` compares the database with the metadata through a throwaway shadow
database. Neither ever writes to the database. Run the CLI from the project root
as `pnpm exec simetra …`; every command defaults to `./metadata`. The same tools
are served by `simetra mcp` with the same input.

## The connection

- The connection string comes **only from the environment**: the variable
  `SIMETRA_DATABASE_URL`, or another one named with
  `--database-url-env <NAME>` (CLI and `simetra mcp`). Export it in the shell
  or the server's environment; never paste a connection string into a command,
  a file or a tool input. Output shows only `host:port/db`.
- Without the variable the call is refused with its name (exit 2).
- The target is only read, in short read-only transactions that leave no
  session state behind.
- `diff` builds the shadow database on the target's server by default, so the
  connecting role needs `CREATEDB`. Otherwise name a variable with
  `--shadow-url-env <NAME>` pointing at another server of the **same
  PostgreSQL major version**; a different major version is refused.
- Roles are cluster infrastructure: they are not described in metadata, and
  grants to them are. A role the database grants to is assumed to exist; a
  shadow on another server must have the same roles, or the metadata does not
  load there.

## Steps

1. **Choose the scope.** A directory without `project.meta.json` needs
   `--schemas` (MCP: `schemas`); the first schema becomes the project's default
   schema. In an existing project the scope is the schemas of its metadata plus
   any named with `--schemas`. Provider schemas (`auth`, `storage`, …) are not
   introspected, and naming the platform's own schema `simetra` is refused. The project file is never rewritten: a `--project-name` or
   `--attribute-case` that differs from it is an error, not a silent override.
   A new project records its database provider explicitly (MCP:
   `project.database.provider`, CLI: `--database-provider`; the default is
   `supabase`); an existing project keeps the one in its file.
2. **Preview.** Run `introspect` with `--dry-run` (MCP: `dryRun: true`) and read
   the diagnostics.
3. **Unrepresentable objects are reported, not worked around.** When anything
   cannot be represented (an `EXCLUDE` constraint, an owner other than the
   session role, …), `introspect` writes nothing and the diagnostics name the
   object. Do not edit the database or the generated files to get past it;
   report the object to the owner.
4. **Introspect.** Run it without `--dry-run`. Tables become `CustomTable`,
   enum types `PgEnum`, everything else verbatim `.sql` files; ids of objects
   already described are kept, so a second run on an unchanged database
   changes nothing.
   The platform's row mechanics (`simetra.touch()`, its grants and the
   `<table>_simetra_touch` triggers calling it) are never written, even into
   a directory without metadata: the platform generates them. Another trigger
   that calls `simetra.touch()` is the table's own and is written.
5. **Diff.** Run `diff` on the same directory. **An empty diff right after
   introspect is the baseline; any non-empty result is a finding** — report it
   instead of editing the metadata until it disappears.
   The one expected exception: adopting from scratch a database that
   Simetra deployed shows the removal of each `<table>_simetra_touch`
   trigger, a step that needs a permission, because a kind table comes back
   as a `CustomTable` without the row mechanics (the adoption row of the
   system schema and users spec in the Simetra repository,
   `docs/superpowers/specs/2026-10-07-system-schema-users-design.md`).
6. **Narrow when reconciling part of the schema.** `--tables` (MCP: `tables`)
   narrows the plan, the differences and the diagnostics to the named tables
   (`schema.table` or `table`) together with their enum types and sequences;
   an unknown table is refused. A diagnostic that cannot be tied to a table
   (one about the whole schema, a function, a view) stays, so a narrowed run
   can still exit 1 because of an object outside the tables: judge the plan
   and the differences, not the exit code alone.

## Examples

A new project from the `app` schema:

```json simetra:introspect
{
  "schemas": ["app"],
  "project": { "name": "Shop", "attributeCase": "snake_case" }
}
```

Compare two tables of it:

```json simetra:diff
{ "tables": ["app.orders", "app.order_lines"] }
```

The same from a shell:

```sh
pnpm exec simetra introspect --schemas app --project-name Shop --dry-run
pnpm exec simetra introspect --schemas app --project-name Shop
pnpm exec simetra diff
pnpm exec simetra diff --tables app.orders,app.order_lines --format json
pnpm exec simetra diff --database-url-env STAGING_DATABASE_URL --shadow-url-env SHADOW_DATABASE_URL
```

## SQL debt

`introspect` also writes `metadata/sql-debt.json`: the verbatim SQL it could
not express through metadata (CustomTable and PgEnum modules, shared
`metadata/sql/`, statements a closed form does not accept).

- The list is a ratchet and only shrinks. `introspect` is the only writer and
  derives it from the database; `fix` only removes stale entries; `compile`
  fails with `sql.debt-grows` on a debt unit that is not listed and with
  `sql.debt-stale` on an entry that is no longer debt. Without that, verbatim
  SQL would grow back unnoticed.
- Never edit the list by hand to get a green compile. Replace the statement
  with a property, an `EventSubscription` or a closed-shell function (see
  `simetra-metadata`), then run `fix`: it removes the entry that became stale.
- A project that already has a `sql/` folder but no list is seeded by running
  `introspect` again on the same directory.

## Adopted triggers

An adopted trigger stays verbatim debt while its table is a `CustomTable`.
When `promote` turns the table into a kind, a trigger gets the
class `platform` only when the kind replaces it, and `plan` refuses
(`plan.platform-replacement-missing`) otherwise:

- `moddatetime` fired `BEFORE UPDATE … FOR EACH ROW` on the column that becomes
  `updatedAt` → the row mechanics (`<table>_simetra_touch`). The mechanics also
  fires on insert, which only makes the date and the version right there too.
- A trigger calling the same handler with the same timing, level and events →
  an `EventSubscription` with that handler (see `simetra-metadata`).
- `INSERT OR UPDATE OF <columns>` → a subscription with `whenChanged` on the
  same columns. The plan warns (`plan.update-of-narrowed`): the subscription
  fires only when a value actually changes, not on every `UPDATE` that sets
  the column.
- A trigger on `UPDATE` alone has no replacement: a write subscription fires
  on insert too. Give it the class `removed` (the plan then needs the
  `remove:` permission) and let the subscription's handler check `TG_OP`.
- A numbering trigger or default has no replacement until the platform
  generates counters: keep the table a `CustomTable`, or remove it with the
  permission and accept that the number is no longer filled.
- Anything else — another `WHEN`, other events, trigger arguments, another
  function — has no replacement either.

## Exit codes

| Code | `introspect`                          | `diff`                            |
| ---- | ------------------------------------- | --------------------------------- |
| `0`  | written (or previewed) without errors | the database matches the metadata |
| `1`  | error diagnostics, nothing written    | differences or error diagnostics  |
| `2`  | the call was refused                  | the call was refused              |

- Refused (exit 2; MCP `isError` without diagnostics): no connection variable,
  an unreachable database, a failed login, a missing database or privilege, a
  bad flag or input. Fix the connection or the call and rerun.
- A failure during the database work itself is the diagnostic
  `database.failed` with its SQLSTATE (exit 1; MCP `isError`). The driver's
  text is withheld because it may carry credentials.
- `--format json` (MCP `structuredContent`) carries the plan, the differences
  and the diagnostics as data.
- `diff` also reports `applyState`: `absent` while the database holds none of
  the platform's apply state (the first `apply` creates it, so it is not a
  difference), `present` otherwise.
