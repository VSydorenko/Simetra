---
name: simetra-cli
description: Use when you need to validate, inspect, repair or edit Simetra metadata (a `metadata/` directory) with the `simetra` CLI or its MCP server — running `compile` or `pnpm metadata:check`, reading a diagnostic (`file:line:col`, `--format json`, `--locale`), asking `explain` for the compiled picture of an object, running `fix` for missing ids and `physicalName`, or exposing mutations through `simetra mcp --allow-write`. Also use when a pre-commit or CI metadata check fails.
---

# Simetra CLI — compile, explain, fix, mcp

The design (commands, MCP operations, safety rules) is in the P2 spec,
`docs/superpowers/specs/2026-09-28-p2-metamodel-compiler-design.md` § 8.6.
This skill is the how-to; do not restate the spec here.

The CLI is a thin wrapper over the T1 compiler and its operations
(`packages/simetra/src/compiler/`); it holds no stage logic of its own. Entry:
`packages/cli/bin/simetra.mjs` (runs from sources, no build step). Every
command defaults to `./metadata`.

## Which command when

| Goal | Command |
| --- | --- |
| Is the metadata accepted by the compiler? | `simetra compile [dirs...]` |
| Same over every metadata directory of the repo (what pre-commit and CI run) | `pnpm metadata:check` |
| What does the compiler derive for one object (standard attributes, tables, queries, references)? | `simetra explain <Kind>.<Name> [dir]` |
| New elements miss `id` / `physicalName`, or files are not canonical | `simetra fix [dir]` (`--dry-run` first) |
| Let an agent edit metadata through checked operations | `simetra mcp [dir]` (read-only), `--allow-write` for mutations |

Artifacts (`snapshot.json`, `desired-state.sql`, `entities.d.ts`) are written
only with `compile --out <dir>`, and `--out` takes exactly one directory.

## Reading the result

- Exit code of `compile`: `0` no errors (warnings allowed), `1` errors,
  `2` usage or I/O error. `pnpm metadata:check` passes it through.
- Text diagnostics look like `path/File.meta.json:LINE:COL severity code message`.
  A diagnostic without a position (the operation input as a whole, a missing
  file) prints `dir:` or `path:` with no `LINE:COL`. The code
  (`file.kind-mismatch`, …) is the stable handle — search for it in the
  compiler rules rather than matching message text.
- `--format json` carries the same diagnostics as data; use it when a tool,
  not a human, reads the output.
- `--locale en|uk` picks the message language (default `en`); the code and
  location are identical in both.
- Start from the first error: one root cause often produces several follow-up
  diagnostics.

## Mutations are checked, never raw

- `fix`, and every MCP mutation (create, add attribute, rename with cascade,
  delete), write files **only when the result compiles without errors**;
  otherwise nothing is written and the diagnostics of the result are returned.
- Mutations other than `fix` also require the input to compile cleanly
  (`operation.input-invalid` otherwise); run `fix` or repair the file by hand
  first.
- `--dry-run` (CLI `fix`) and `dryRun` (MCP) report the changes without
  writing. Use them before the real run.
- MCP `delete` needs `confirm: true` and refuses to delete a referenced object,
  listing every place that references it.
- Rename never changes `physicalName` (no DDL); do not edit ids or
  `physicalName` of existing elements by hand.

## Pre-commit and CI

`.husky/pre-commit` runs `pnpm metadata:check --staged`, which compiles the Git
**index** content (not the working tree) of every metadata directory found by
`git ls-files -- '*metadata/project.meta.json'`. CI runs the same without
`--staged`. A rejected commit means the staged content does not compile: run
`pnpm metadata:check` for the working tree, fix, `git add`, commit again. Do not
bypass the hook with `--no-verify`.
