# Simetra CLI Command Recipes

Ready-to-copy commands for common Simetra CLI scenarios.

## Discover available commands

```bash
pnpm simetra --help
```

## Show help for SQL generation

```bash
pnpm simetra generate --help
```

## Generate SQL with default PostgreSQL settings

```bash
pnpm simetra generate --input ./temp/metadata --output ./output
```

## Generate SQL into a custom output directory

```bash
pnpm simetra generate --input ./temp/metadata --output ./tmp/sql-output
```

## Generate SQL with explicit schema

```bash
pnpm simetra generate --input ./temp/metadata --output ./output --schema public
```

## Generate one file per object

```bash
pnpm simetra generate --input ./temp/metadata --output ./output --output-mode perObject
```

## Generate a single combined SQL file layout

```bash
pnpm simetra generate --input ./temp/metadata --output ./output --output-mode singleFile
```

## Generate SQL with lookup-table enums

```bash
pnpm simetra generate --input ./temp/metadata --output ./output --enum-strategy lookupTable
```

## Generate SQL with separate tables for constants

```bash
pnpm simetra generate --input ./temp/metadata --output ./output --constants-strategy separateTables
```

## Generate SQL with multiple explicit options

```bash
pnpm simetra generate \
  --input ./temp/metadata \
  --output ./output \
  --schema public \
  --output-mode perObject \
  --enum-strategy pgEnum \
  --constants-strategy singleTable
```

## Debug the CLI package directly

```bash
pnpm --filter @simetra/cli exec tsx src/index.ts generate --help
```

## When to use which recipe

- Use the default command first when the user does not need special SQL layout or strategy options.
- Use `--output-mode perObject` when the user wants file-per-object output for review or diffing.
- Use `--enum-strategy lookupTable` when PostgreSQL enums are not desired.
- Use the package-local debug command only for CLI package work, not for normal repository usage.