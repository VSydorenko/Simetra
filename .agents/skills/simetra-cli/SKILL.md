---
name: simetra-cli
description: 'Use when working with the Simetra CLI for metadata-related command-line workflows. Triggers: simetra cli, generate sql, metadata to sql, pnpm simetra, output-mode, enum-strategy, constants-strategy, project.meta.json, CLI usage, CLI troubleshooting, future simetra subcommands.'
argument-hint: 'What do you need to do with the Simetra CLI?'
---

# Simetra CLI

This skill captures the standard workflow for working with the Simetra CLI from the repository root, so the agent can help without re-reading the CLI source each time.

The CLI currently exposes one main subcommand, `generate`, but this skill is intentionally broader: it defines the canonical invocation pattern, the way to inspect supported commands, and the decision points that should stay stable as new subcommands are added later.

## When to Use

Use this skill when the user:

- Wants to run SQL generation from metadata through the Simetra CLI
- Asks how to invoke the CLI from the repository root
- Needs help choosing `generate` options such as `--schema` or `--output-mode`
- Needs to understand what directory structure the CLI expects
- Hits validation or parsing errors while running `pnpm simetra generate ...`
- Wants examples or a checklist for CLI-based SQL generation
- Wants a reusable entrypoint for current or future Simetra CLI subcommands

## Canonical Invocation

From the repository root, use the root package script:

```bash
pnpm simetra <subcommand> [options]
```

For package-local debugging, the fallback command is:

```bash
pnpm --filter @simetra/cli exec tsx src/index.ts <subcommand> [options]
```

To inspect what the CLI supports right now, start with:

```bash
pnpm simetra --help
```

## What the CLI Supports Now

- The top-level binary name is `simetra`
- The currently implemented subcommand is `generate`
- The only supported target is `postgresql`
- The CLI reads JSON metadata files and writes generated SQL files into the output directory
- The output directory is created automatically if it does not exist

## Stable CLI Pattern For Future Commands

When new subcommands appear later, keep the same reasoning model:

1. Start from the repository root.
2. Discover the command surface with `pnpm simetra --help` or `pnpm simetra <subcommand> --help`.
3. Prefer the root script over direct `node packages/cli/bin/simetra.mjs ...` calls.
4. Treat command-specific validation errors as either input problems or domain-model problems first, not as runtime wrapper problems.
5. Fall back to the package-local `tsx` command only for debugging or package-focused work.

## Expected Input Layout

The input directory must contain `project.meta.json` at its root.

Typical layout:

```text
<input>/
  project.meta.json
  catalogs/
  documents/
  enumerations/
  information-registers/
  accumulation-registers/
  constants/
  custom-tables/
```

Notes:

- `constants/` uses the constants wrapper format expected by `constantsFileSchema`
- Unknown metadata directories are skipped with a warning
- Invalid JSON or schema validation errors stop execution with a non-zero exit

## Generate Workflow

1. Confirm the user is in the repository root.
2. Confirm the metadata directory contains `project.meta.json`.
3. Choose the output directory.
4. Decide whether the default options are enough or whether custom generation options are needed.
5. Run `pnpm simetra generate ...`.
6. Review warnings, if any.
7. Confirm the expected SQL files were written into the output directory.

## Command Selection Guide

### If the user only wants to know what commands exist

Use:

```bash
pnpm simetra --help
```

### If the user wants details for one command

Use:

```bash
pnpm simetra generate --help
```

### If the user wants actual SQL generation

Use the `generate` workflow below and the ready-to-copy command recipes in [command-recipes.md](./references/command-recipes.md).

## Decision Guide

### Choose the simplest command first

Use this when the default PostgreSQL configuration is fine:

```bash
pnpm simetra generate --input ./temp/metadata --output ./output
```

### Choose a schema explicitly

Use this when the user wants a non-default or explicit SQL schema:

```bash
pnpm simetra generate --input ./temp/metadata --output ./output --schema public
```

### Choose output granularity

- Use `--output-mode singleFile` when the user wants a single SQL file
- Use `--output-mode perObject` when the user wants multiple generated files

Example:

```bash
pnpm simetra generate --input ./temp/metadata --output ./output --output-mode perObject
```

### Choose enum handling

- Use `--enum-strategy pgEnum` for PostgreSQL enums
- Use `--enum-strategy lookupTable` for lookup-table based enums

Example:

```bash
pnpm simetra generate --input ./temp/metadata --output ./output --enum-strategy lookupTable
```

### Choose constants handling

- Use `--constants-strategy singleTable` for one shared table
- Use `--constants-strategy separateTables` for separate tables

Example:

```bash
pnpm simetra generate --input ./temp/metadata --output ./output --constants-strategy separateTables
```

## Supported Options for `generate`

| Option | Meaning | Default |
|---|---|---|
| `--target` | Target database | `postgresql` |
| `--input` | Metadata input directory | `.` |
| `--output` | Output directory for generated SQL | `./output` |
| `--schema` | SQL schema name | `public` |
| `--enum-strategy` | Enum strategy: `pgEnum`, `lookupTable` | `pgEnum` |
| `--constants-strategy` | Constants strategy: `singleTable`, `separateTables` | `singleTable` |
| `--output-mode` | Output mode: `singleFile`, `perObject` | `singleFile` |

## Troubleshooting Guide

### Unknown command or unsupported subcommand

Start with `pnpm simetra --help` and verify that the requested subcommand actually exists in the current CLI version.

### `project.meta.json` not found

Check that `--input` points to the metadata root, not to a nested folder.

### Invalid JSON

One of the metadata files cannot be parsed. Fix the file contents before retrying.

### Validation errors

One of the parsed metadata files does not satisfy the corresponding Zod schema. Treat this as an input-model problem, not as a CLI runtime problem.

### Unsupported target

The CLI currently accepts only `--target postgresql`.

### Unexpected output structure

Check `--output-mode`. `singleFile` and `perObject` intentionally produce different file layouts.

## Completion Checks

The task is complete when all of the following are true:

- The chosen subcommand matches the user's goal
- The command exits successfully
- The output directory contains the expected SQL files
- The chosen schema and generation strategies match the user's intent
- Any warnings were reviewed and either accepted or followed up

## References

- Ready-to-copy commands: [command-recipes.md](./references/command-recipes.md)

## Example Prompts

- `Use simetra-cli to generate SQL from ./temp/metadata into ./output`
- `Use simetra-cli and explain which options I need for per-object SQL output`
- `Use simetra-cli and troubleshoot why my metadata folder is not accepted`
- `Use simetra-cli and show the safest default command for PostgreSQL`
- `Use simetra-cli and show me which subcommands are available right now`
- `Use simetra-cli and give me a copy-paste command for per-object SQL generation`