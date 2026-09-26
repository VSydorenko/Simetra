---
name: simetra-cli
description: "Use when running, explaining or debugging the prototype Simetra CLI (`pnpm simetra`): generating PostgreSQL DDL from a metadata directory (`simetra generate`), applying it to a database or previewing the migration (`simetra apply`, `--dry-run`, `--allow-destructive`, `SIMETRA_DATABASE_URL`), choosing `--schema`, `--enum-strategy`, `--constants-strategy`, `--output-mode`, laying out `project.meta.json` and kind folders, or reading CLI validation, snapshot and destructive-change errors."
argument-hint: "What do you need to do with the Simetra CLI?"
---

# Simetra CLI (prototype)

This skill documents the **prototype** CLI in `packages/cli`: two subcommands,
`generate` and `apply`, over the PostgreSQL generator in `packages/generator-pg`.
It is not the target CLI. The target `@simetra/cli` (compile, plan, apply,
`explain`, `fix`, `studio`) is defined in
`docs/superpowers/specs/2026-09-24-simetra-platform-design.md` §3.2 and will
replace this one; the fate of the generator it wraps is in the same spec §14.
Do not design new features on top of the prototype command surface — use it to
run and debug what exists.

The source of truth is the code: `packages/cli/src/index.ts` (command list),
`packages/cli/src/commands/generate.ts` and `packages/cli/src/commands/apply.ts`
(options and flow). When this skill and the code disagree, the code wins —
check `pnpm simetra <command> --help` and fix the skill.

## Invocation

From the repository root:

```bash
pnpm simetra <command> [options]
pnpm simetra --help
pnpm simetra <command> --help
```

The root script runs `packages/cli/bin/simetra.mjs`, which spawns `tsx` on the
TypeScript entry — there is no build step. For package-local debugging:

```bash
pnpm --filter @simetra/cli exec tsx src/index.ts <command> [options]
```

## Input layout

`--input` points to the directory that holds `project.meta.json`. Kind folders
live either directly next to it or under a `metadata/` subfolder of it:

```text
<input>/
  project.meta.json
  [metadata/]
    catalogs/<kebab-name>/<kebab-name>.meta.json
    catalogs/<kebab-name>/forms/*.form.json
    documents/…  enumerations/…  information-registers/…
    accumulation-registers/…  custom-tables/…     (same per-object shape)
    constants/constants.meta.json                (one wrapper file)
```

- Only these kind folders are read; any other folder is ignored **silently**.
- A per-object file must be named after its folder, otherwise it is not read.
- Parsing and validation go through `@simetra/core` in strict mode: invalid JSON
  or a schema violation stops the command with a non-zero exit.

## `generate` — write DDL to disk

| Option | Values | Default |
| --- | --- | --- |
| `--input` | metadata directory | `.` |
| `--output` | output directory (created if missing) | `./output` |
| `--target` | `postgresql` only | `postgresql` |
| `--schema` | SQL schema name | `public` |
| `--enum-strategy` | `pgEnum`, `lookupTable` | `pgEnum` |
| `--constants-strategy` | `singleTable`, `separateTables` | `singleTable` |
| `--output-mode` | `singleFile`, `perObject` | `singleFile` |

Behaviour to know before promising a result:

- The generator writes **one file**, `<project name>.sql`, whatever
  `--output-mode` says: `perObject` is accepted but not implemented, and an
  unknown `--output-mode` value is not rejected either.
- `--enum-strategy` and `--constants-strategy` are validated; a wrong value
  exits with the list of allowed values.
- Generator warnings are printed but do not fail the command.
- The CLI always passes explicit schema and strategies, so the
  `database`/`generation` defaults in `project.meta.json` never take effect
  through the CLI — pass the flags explicitly.

## `apply` — execute DDL or a migration

| Option | Meaning | Default |
| --- | --- | --- |
| `--connection-string` | `postgres://` or `postgresql://` URL; falls back to `SIMETRA_DATABASE_URL` | — |
| `--input` | metadata directory | `.` |
| `--schema` | SQL schema name | `public` |
| `--enum-strategy` | `pgEnum`, `lookupTable` | `pgEnum` |
| `--constants-strategy` | `singleTable`, `separateTables` | `singleTable` |
| `--dry-run` | print the SQL instead of executing it | `false` |
| `--allow-destructive` | allow `DROP TABLE` / `DROP COLUMN` changes | `false` |

Flow:

1. Without `--dry-run` the connection string is required and must be a valid
   `postgres(ql)://` URL with a host.
2. The metadata is loaded exactly as for `generate`.
3. The applied-schema snapshot is read from `<input>/.simetra/applied-schema.json`.
   - **No snapshot** → the full DDL is used (first apply).
   - **Snapshot present** → a diff migration is computed. No changes → the
     command reports that the schema matches and exits successfully.
     Destructive changes without `--allow-destructive` → the command lists them
     and exits with an error **before** `--dry-run` is honoured.
4. `--dry-run` prints the SQL (and the diff summary for a migration) and stops:
   no connection, no snapshot write.
5. Otherwise the SQL runs in a single transaction; on success the new snapshot
   is written. Credentials are masked in connection and execution errors.

Snapshot pitfalls — the prototype keeps the snapshot next to the metadata, not
in the database:

- The snapshot describes **the last database this metadata was applied to**.
  Applying the same `--input` to another database diffs against the wrong
  state. Use a separate metadata copy per database, or delete the snapshot
  before a first apply to a fresh database.
- Deleting the snapshot while the database already has the tables makes the
  next apply run the full DDL again; it fails inside the transaction and is
  rolled back.
- A snapshot of an unknown version or missing required fields aborts the
  command with an uncaught error (a stack trace, not a formatted message)
  whose text says to delete the file.

## Workflow

1. Confirm the input directory holds `project.meta.json` and the expected kind
   folders.
2. Run `generate` into a scratch output directory and read the SQL, or run
   `apply --dry-run` to see exactly what would execute.
3. Only then run `apply` against a database, passing the connection string via
   `SIMETRA_DATABASE_URL` rather than on the command line, so it stays out of
   shell history.
4. Review printed warnings; treat validation errors as metadata problems, not
   CLI problems.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `project.meta.json` not found | `--input` points to a nested folder instead of the project root |
| An object is missing from the SQL | its folder is not a known kind folder, or its file is not named `<folder>.meta.json` |
| Validation error with a file path | that metadata file violates the core schema — fix the metadata |
| Unsupported target | only `--target postgresql` exists |
| `perObject` still gives one file | expected: not implemented in the prototype generator |
| Apply refuses destructive changes | re-run with `--allow-destructive` only after reading the listed drops |
| Apply fails with "already exists" | no snapshot for a database that already has the schema |
| Unknown or corrupted snapshot | delete `<input>/.simetra/applied-schema.json` and re-apply deliberately |

Ready-to-copy commands: [command-recipes.md](./references/command-recipes.md).
