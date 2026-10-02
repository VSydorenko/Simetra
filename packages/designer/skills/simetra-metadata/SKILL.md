---
name: simetra-metadata
description: Use when you need to create, change, validate or explain Simetra metadata (a `metadata/` directory) with the `simetra` tools — compile it, read a compiler diagnostic (`file:line:col`, `--format json`, `--locale`), explain the compiled picture of an object, fix missing ids and `physicalName`, create, add, rename or delete elements through checked operations, or expose them to an agent with `simetra mcp --allow-write`. Also use when a pre-commit or CI metadata check fails.
---

# Simetra metadata — compile, explain, fix, create, add, rename, delete

The tools are one catalog served by the command line and by the MCP server,
with the same tool names and the same input in both. Run the CLI
from the project root as `pnpm exec simetra …` (or `node_modules/.bin/simetra …`).
Every command defaults to `./metadata`.

This skill covers how to use the tools. What the metadata model means is
described by the schemas in `node_modules/simetra/schemas/` and by the
diagnostics themselves.

## Which tool when

| Task | Tool | CLI | MCP call |
| --- | --- | --- | --- |
| Is the metadata accepted by the compiler? | `compile` | `simetra compile [dirs...]` | `compile` with `{}` |
| What does the compiler derive for one object (tables, columns, keys, queries)? | `explain` | `simetra explain <Kind>.<Name> [dir]` | `explain` with `{kind, name}` |
| New elements miss `id` / `physicalName`, or files are not canonical | `fix` | `simetra fix [dir]` | `fix` with `{}` |
| New object | `create` | `simetra create '<json>' [dir]` | `create` with `{kind, name, data?}` |
| New element in a collection of an object or of the project root | `add` | `simetra add '<json>' [dir]` | `add` with `{target, collection, element}` |
| Rename an object or a nested element | `rename` | `simetra rename '<json>' [dir]` | `rename` with `{target, newName}` |
| Remove an object or a nested element | `delete` | `simetra delete '<json>' [dir] --yes` | `delete` with `{target, confirm}` |

`compile`, `explain` only read. `fix`, `create`, `add`, `rename`, `delete`
change files.

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
```

An input that does not match the tool's schema is refused with the path of the
offending field (for example `target.kind`); nothing is written.

## Reading the result

- Exit code: `0` ok (warnings allowed), `1` the result has error diagnostics
  (this includes refused operations such as `operation.delete-referenced`),
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
- Rename never changes `physicalName` (no DDL). Do not edit ids or `physicalName`
  of existing elements by hand.
- Never pass an `id` to `create` or `add`: ids are assigned by the operation, and
  an input carrying one gets `operation.input-invalid` (exit 1, nothing written).

## Agents over MCP

```sh
pnpm exec simetra mcp
pnpm exec simetra mcp --allow-write
```

- Without `--allow-write` the server is read-only: every tool is listed, but a
  write tool is refused with a hint to restart the server with `--allow-write`.
  Ask the owner before restarting it in write mode.
- With `--allow-write` the write tools change files in the served directory,
  under the same rules as the CLI.
- The server reads the disk on every call, so edits made by hand between calls
  are seen.

## Pre-commit and CI

Check every metadata directory under the current directory with
`simetra compile --all`; add `--staged` to compile the Git **index** instead of
the working tree (what a pre-commit hook wants):

```sh
pnpm exec simetra compile --all
pnpm exec simetra compile --all --staged
```

A rejected commit means the staged content does not compile: run
`simetra compile --all` for the working tree, fix, `git add`, commit again. Do
not bypass the hook with `--no-verify`.
