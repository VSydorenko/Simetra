---
name: simetra-metadata
description: Use when you need to create, change, validate or explain Simetra metadata (a `metadata/` directory) with the `simetra` tools — compile it, read a compiler diagnostic (`file:line:col`, `--format json`, `--locale`), explain the compiled picture of an object, fix missing ids and `physicalName`, create, add, rename or delete elements through checked operations, compare a database with the metadata (`diff`), or expose the tools to an agent with `simetra mcp` (`--read-only` to refuse writes). Also use when a pre-commit or CI metadata check fails. For bringing an existing database under metadata (`introspect`), use `simetra-adoption`.
---

# Simetra metadata — compile, explain, fix, create, add, rename, delete, introspect, diff

The tools are one catalog served by the command line and by the MCP server,
with the same tool names and the same input in both. Run the CLI
from the project root as `pnpm exec simetra …` (or `node_modules/.bin/simetra …`).
Every command defaults to `./metadata`.

This skill covers how to use the tools. What the metadata model means is
described by the schemas in `node_modules/simetra/schemas/` and by the
diagnostics themselves.

## Which tool when

| Task                                                                           | Tool         | CLI                                      | MCP call                                   |
| ------------------------------------------------------------------------------ | ------------ | ---------------------------------------- | ------------------------------------------ |
| Is the metadata accepted by the compiler?                                      | `compile`    | `simetra compile [dirs...]`              | `compile` with `{}`                        |
| What does the compiler derive for one object (tables, columns, keys, queries)? | `explain`    | `simetra explain <Kind>.<Name> [dir]`    | `explain` with `{kind, name}`              |
| New elements miss `id` / `physicalName` / `kindLabel`, or files are not canonical | `fix`        | `simetra fix [dir]`                      | `fix` with `{}`                            |
| New object                                                                     | `create`     | `simetra create '<json>' [dir]`          | `create` with `{kind, name, data?}`        |
| New element in a collection of an object or of the project root                | `add`        | `simetra add '<json>' [dir]`             | `add` with `{target, collection, element}` |
| Rename an object or a nested element                                           | `rename`     | `simetra rename '<json>' [dir]`          | `rename` with `{target, newName}`          |
| Remove an object or a nested element                                           | `delete`     | `simetra delete '<json>' [dir] --yes`    | `delete` with `{target, confirm}`          |
| Read a live database into metadata                                             | `introspect` | `simetra introspect [dir] --schemas a,b` | `introspect` with `{schemas?, project?}`   |
| Does the database match the metadata?                                          | `diff`       | `simetra diff [dir] --tables a,b`        | `diff` with `{tables?}`                    |

`compile`, `explain`, `diff` only read files. `fix`, `create`, `add`,
`rename`, `delete`, `introspect` change files. `introspect` and `diff` read
the database; neither ever writes to it.

## Examples

Create an object (ids and physical names are assigned for you):

```json simetra:create
{ "kind": "Catalog", "name": "Currency" }
```

Add an attribute to it:

```json simetra:add
{
  "target": { "kind": "Catalog", "name": "Currency" },
  "collection": "attributes",
  "element": { "name": "symbol", "type": "String", "length": 5 }
}
```

Rename it; references are rewritten, `physicalName` stays:

```json simetra:rename
{
  "target": { "kind": "Catalog", "name": "Currency", "element": ["symbol"] },
  "newName": "sign"
}
```

Preview a deletion without writing and without confirmation:

```json simetra:delete
{
  "target": { "kind": "Catalog", "name": "Currency", "element": ["sign"] },
  "dryRun": true
}
```

The same calls from a shell. A mutation takes its JSON as an argument, as
`--input`, or as `-` for stdin:

```sh
pnpm exec simetra compile
pnpm exec simetra explain Catalog.Currency
pnpm exec simetra create '{"kind":"Catalog","name":"Currency"}' --dry-run
pnpm exec simetra delete --input '{"target":{"kind":"Catalog","name":"Currency"}}' --yes
pnpm exec simetra diff
```

An input that does not match the tool's schema is refused with the path of the
offending field (for example `target.kind`); nothing is written.

## Reading the result

- Exit code: `0` ok (warnings allowed), `1` the result has error diagnostics
  (this includes refused operations such as `operation.delete-referenced`)
  or, for `diff`, differences or errors — `0` from `diff` means the database
  matches the metadata,
  `2` the call itself was refused: input that does not match the tool's schema
  (bad JSON, unknown field), a missing `--yes`, a usage or I/O error (bad flag,
  missing directory) or an unknown `explain` target. In MCP the same cases are
  `isError`, with diagnostics for the exit-1 ones.
- Text diagnostics look like `path/File.meta.json:LINE:COL severity code message`.
  A diagnostic without a position (the input as a whole, a missing file) has no
  `LINE:COL`. The code (`file.kind-mismatch`, …) is the stable handle; do not
  match on message text.
- `--format json` carries the same diagnostics as data; use it when a program,
  not a human, reads the output.
- `--locale en|uk` picks the message language (default `en`); code and
  location are identical in both.
- Start from the first error: one root cause often produces several follow-ups.
- Artifacts (`snapshot.json`, `desired-state.sql`, `entities.d.ts`) are written
  only with `compile --out <dir>`, and `--out` takes one metadata directory per run.

## Mutations are checked, never raw

- Every mutation writes files **only when the result compiles without errors**;
  otherwise nothing is written and the diagnostics are returned.
- `create`, `add`, `rename`, `delete` also need the current metadata to compile
  cleanly (`operation.input-invalid` otherwise): run `fix` or repair the file by
  hand first.
- `--dry-run` (MCP: `dryRun: true`) reports the changes without writing. Use it
  before the real run.
- `delete` is destructive: it needs `--yes` (MCP: `confirm: true`) and is refused
  while anything references the target: the result then carries
  `operation.delete-referenced` listing every reference (exit 1, nothing
  written). A dry run needs no confirmation; it reports `would write <file>` for
  a file that changes and `would delete <file>` only for a file that is removed.
- Rename never changes `physicalName` or `kindLabel` (no DDL). Do not edit ids,
  `physicalName` or `kindLabel` of existing elements by hand: they are assigned
  once (by `fix`, `create`, `add`), and in a Git repository `compile` checks
  them, together with an object's PG schema, against `HEAD`
  (`identity.assigned-once-changed`). Outside Git that check is skipped with a
  warning.
- Never pass an `id` to `create` or `add`: ids are assigned by the operation, and
  an input carrying one gets `operation.input-invalid` (exit 1, nothing written).

## Declare, don't write SQL

A rule the platform can derive is a property in the metadata, not a statement
in a `.sql` file. The schemas in `node_modules/simetra/schemas/` describe each
property; some that replace hand-written SQL are listed below.

Attribute properties (an element of `attributes`):

- `defaultValue`: `{ "fill": "now" | "today" | "newUuid" }` on a scalar of the
  matching type, `{ "empty": true }` on an array (`"array": true`), or
  `{ "empty": "object" | "array" }` on a scalar `Json`.
- `unique`: `true`, or `"ignoreCase"` on a scalar String or Text. `uniqueWithin`: `"owner"` or `"parent"`,
  only on a catalog's own attributes and only when the catalog has owners or a
  hierarchy.
- Numbers (scalar only): `nonNegative`, `positive`, `minValue`, `maxValue`.
- Strings and text (scalar only): `minLength`, `pattern`. The pattern must
  mean the same in JavaScript and Postgres: no named groups, `\p{}`, `\k<>`,
  `\b`, `\B`, `\x`, `\u{}` or inline flag groups such as `(?i:…)`. Write a
  character as itself or as `\uXXXX`.
- `personalData: true` marks personal data (a name, a phone, an address):
  anonymization sets the attribute to `NULL`, so it cannot also be
  `required`.

Object properties:

- `indexes` on a Catalog, a Document and their tabular sections: a list of
  composite indexes, each `{ "attributes": [name | { "name": …, "order": "desc" }] }`.
- `publicRead`: `"authenticated"` or `"anon"`, on kinds that have row-level
  security.
- Project file: `storageBuckets`, a list of `{ "bucket": …, "scopeKind": … }`.

An attribute with properties, added through the tool:

```json simetra:add
{
  "target": { "kind": "Catalog", "name": "Currency" },
  "collection": "attributes",
  "element": {
    "name": "isoCode",
    "type": "String",
    "length": 3,
    "unique": "ignoreCase",
    "minLength": 3
  }
}
```

An event subscription is a file per subscription in `event-subscriptions/`,
created with `create` like any object (kind `EventSubscription`):

- `sources`: one or more metadata refs `{ kind, name }` or
  `{ "providerTable": "<schema>.<table>" }`.
- `event`: `beforeWrite`, `onWrite`, `beforeDelete` or `onDelete`.
- `whenChanged` (optional, write events only): attribute names.
- `handler`: `{ schema?, name }`, a function without arguments that
  `RETURNS trigger`, declared in the closed shell below.

## Users, authorship and membership

People are platform data, not tables you write yourself:

- **Users catalog.** A Catalog with `"role": "users"` is the project's users
  catalog: at most one per project, `scope: "none"`, a description (the
  display name filled from the account). The compiler adds the standard
  `userKind` and `invalid` attributes. Every account of the identity provider
  gets a row through the platform's provisioning, which inserts only the key
  and the description, so the catalog's own attributes must accept that
  insert: a `required` attribute needs a `defaultValue` that passes the
  attribute's own checks, a unique attribute takes no default other than
  `{ "fill": "newUuid" }`, and its module has no row rule
  (`users.provision-unsafe` names the reason).
- **Scope root.** The users catalog may be the `root` of a scope kind
  (`{ "object": { "kind": "Catalog", "name": "<users catalog>" } }`) while
  staying `scope: "none"`; references to it from any scope kind are plain
  references, without `crossScope`. Do not point a root or a foreign key at
  the provider's account table.
- **Authorship.** `trackAuthor: true` on a Catalog or a Document adds the
  standard `createdBy` and `updatedBy` references to the users catalog;
  without a users catalog it is an error (`users.catalog-missing`).
- **Membership.** A scoped catalog with `membership: { "user": "<attribute>" }`
  is the membership of its scope kind: the attribute is a scalar `Ref` to the
  users catalog, nullable for an invited member without an account. The
  compiler derives one member per user and scope value and generates a
  "my member" function; a scope kind with `"setFunction": "membership"` gets
  its scope set function from that catalog. Use it instead of a hand-written
  member table and set function. One membership catalog per scope kind.

The platform layer (identities, the current user, provisioning) lives in the
PG schema `simetra`, generated when a users catalog exists. The schema is
reserved: no object, `defaultSchema`, set function, external reference,
event handler or SQL unit may use it, and there is no `metadata/sql/simetra/`
folder (`schema.reserved`). In SQL, the
current user is `(select simetra.current_user_id())`, written exactly so in a
policy (`sql.bare-current-user` rejects a bare call there); it is `NULL` for
an anonymous or service session and for an invalid user.

## The SQL module: closed forms only

The `.sql` module of an object of a 1C kind accepts only:

- Functions in the closed shell: `LANGUAGE sql` or `plpgsql`, an explicit
  volatility, and `SET search_path = ''` for every `SECURITY DEFINER`. No
  overloads.
- Row rules: `ALTER TABLE <own table> ADD CONSTRAINT <name> CHECK (<rule>)`
  within a small grammar. The constraint needs a name and must target the
  object's own table or one of its own tabular-section tables.
- Movement query blocks in a document module.

Any other statement is rejected (`sql.statement-not-allowed`, `sql.closed-shell`,
`sql.row-rule-grammar`, …) with a hint that names the property that replaces it.
Follow the hint instead of rewording the statement. `CustomTable` and `PgEnum`
modules and the shared `metadata/sql/` folder are not closed: their content is
debt (below).

A row rule shape:

```sql
ALTER TABLE <schema>.<own_table> ADD CONSTRAINT <rule_name> CHECK (<rule>);
```

## SQL debt

`metadata/sql-debt.json` lists the verbatim SQL units that the compiler still
tolerates. It only shrinks:

- Only `introspect` writes it, from the database. Never add an entry by hand.
- An entry that is no longer debt (its unit is gone or now has a closed form)
  fails `compile` with `sql.debt-stale`; `fix` removes exactly such entries
  and never adds one. A removed entry comes back only through `introspect`.
- A debt unit that is not in the list fails `compile` with `sql.debt-grows`.
  Express the statement as a property, an `EventSubscription` or a closed-shell
  function; moving it to another file does not make it acceptable.
- A project with an existing `sql/` folder and no list is seeded by running
  `introspect` again (see `simetra-adoption`).

## The database: introspect and diff

`introspect` and `diff` read a live database and never write to it. The
connection comes only from the environment (`SIMETRA_DATABASE_URL`, or the
variable named with `--database-url-env`); never paste a connection string.
Scope, the shadow database, exit codes and how to judge a result are in the
`simetra-adoption` skill.

## Agents over MCP

```sh
pnpm exec simetra mcp
pnpm exec simetra mcp --read-only
pnpm exec simetra mcp --database-url-env STAGING_DATABASE_URL
```

- By default the write tools change files in the served directory, under the
  same rules as the CLI: the metadata is in git, and nothing is written unless
  the result compiles. `--read-only` is a flag of `simetra mcp` only; the CLI
  has none (preview with `--dry-run`).
- With `--read-only` every tool is still listed, but a write tool is refused
  with a hint to remove `--read-only` from the server's args. Ask the owner
  before restarting the server without it.
- The server reads the disk on every call, so edits made by hand between calls
  are seen.

## Pre-commit and CI

Check every metadata directory under the current directory with
`simetra compile --all`; add `--staged` to compile the Git **index** instead of
the working tree (what a pre-commit hook wants). Fields assigned once are
compared with `HEAD` in both modes:

```sh
pnpm exec simetra compile --all
pnpm exec simetra compile --all --staged
```

A rejected commit means the staged content does not compile: run
`simetra compile --all` for the working tree, fix, `git add`, commit again. Do
not bypass the hook with `--no-verify`.
