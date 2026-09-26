# Simetra CLI command recipes

Copy-paste commands for the prototype CLI, run from the repository root.
`<metadata-dir>` is the directory that holds `project.meta.json`.

## Discover the command surface

```bash
pnpm simetra --help
pnpm simetra generate --help
pnpm simetra apply --help
```

## Generate DDL with defaults

```bash
pnpm simetra generate --input <metadata-dir> --output ./output
```

## Generate DDL with explicit schema and strategies

```bash
pnpm simetra generate \
  --input <metadata-dir> \
  --output ./output \
  --schema app \
  --enum-strategy lookupTable \
  --constants-strategy separateTables
```

## Preview what `apply` would execute

No database connection is needed; nothing is written.

```bash
pnpm simetra apply --input <metadata-dir> --dry-run
```

## Apply to a database

Set `SIMETRA_DATABASE_URL` in the environment beforehand (for example from an
untracked env file) so the password never lands in shell history or a
transcript.

```bash
pnpm simetra apply --input <metadata-dir> --schema public
```

## Apply a migration that drops tables or columns

Read the dropped objects in the dry-run output first.

```bash
pnpm simetra apply --input <metadata-dir> --dry-run --allow-destructive
pnpm simetra apply --input <metadata-dir> --allow-destructive
```

## Start over against a fresh database

The snapshot belongs to the last database this metadata was applied to.

```bash
rm <metadata-dir>/.simetra/applied-schema.json
pnpm simetra apply --input <metadata-dir> --dry-run
```

## Debug the CLI package directly

```bash
pnpm --filter @simetra/cli exec tsx src/index.ts generate --help
```
