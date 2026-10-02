---
name: consumer-reconciliation
description: "Use when running the private reconciliation of the first consumer's database against Simetra metadata — restoring a schema-only dump of its database into a local stack database, the sanitary introspect-then-diff round-trip, and the diff of hand-written metadata of the smallest document with register movements against that copy (spec P2 §10.3). Covers where the outputs go and the ban on committing any consumer artefact to this public repo. Not for ordinary compile/diff of the platform's own synthetic domain."
---

# Private reconciliation of the first consumer

The first consumer's schema is private and this repo is public. The procedure
proves the platform's reverse generation and plan against a real schema without
a byte of it entering git. The **what and why** is the platform's P2 spec
`docs/superpowers/specs/2026-09-28-p2-metamodel-compiler-design.md` § 10.3
(expected plan: § 10.2 and M4); this skill is only the **how**. Tool syntax and
exit codes: the consumer skill `packages/designer/skills/simetra-metadata/SKILL.md`.

## Hard rules

- **Nothing from the consumer enters this repo** — not the dump, not metadata
  introspected from it, not hand-written metadata, not plans, diffs or logs, not
  table or column names pasted into docs, tests or commit messages (AGENTS.md
  § "Platform / consumer boundary"). Before any commit, check `git status` for
  strays.
- **Outputs go outside this repo:** the consumer's repo (metadata of the
  document) or a scratch directory outside the checkout (introspection output,
  plans, logs). Say so in the prompt of any agent you delegate to.
- **A separate database, never the test one.** The dump is restored into its
  own database of the local stack; `pnpm test:db` databases are not touched.
- **Local stack only through `pnpm db:*`** (`pnpm db:start`, `pnpm db:stop`),
  never a global `supabase`.
- **The connection string comes only from the environment.** Export it in the
  shell (`SIMETRA_DATABASE_URL`, or another name via `--database-url-env`); never
  paste it into a command, a file or a report.
- The Postgres major version of the stack must equal the dump's (spec § 10.4);
  if it differs, stop and tell the owner.

## Prerequisites

The owner provides a schema-only dump (`pg_dump --schema-only`) of the first
consumer's database. Without it, stop and ask; do not synthesise one.

## Procedure

1. **Restore.** `pnpm db:start`; create a new database (a name not used by the
   tests) on the stack and restore the dump into it with `psql`/`pg_restore`.
   Roles or extensions the dump expects but the stack lacks are reported to the
   owner, not worked around by editing the dump.
2. **Sanitary round-trip (decision: introspection must be lossless).**
   - Export the connection variable for the new database.
   - `simetra introspect <scratch-dir-outside-repo> --schemas <schemas> --project-name <name>`
     (add `--attribute-case …` if the consumer's style is known). Run with
     `--dry-run` first: any diagnostic is an unrepresentable object (an
     `EXCLUDE` constraint, a foreign owner, …) — report it, do not edit around
     it.
   - `simetra diff <scratch-dir-outside-repo>` — the plan and differences must
     be **empty**. Anything else is a platform defect in reverse generation:
     report it with the object named in a private note, not in this repo.
3. **Reconciliation proper.** In the consumer's repo, write by hand the metadata
   of the smallest document with register movements (the document, its
   tabular sections, its registers). Then, from that repo,
   `simetra diff <metadata-dir> --tables <document table, tabular-section tables, register tables>`.
4. **Judge the plan against the spec, not against taste.** The plan from the
   copy to the metadata must be exactly what § 10.2 and M4 list: the standard
   elements of the kind (additions) and the replacement of a simple FK or
   reference index by a composite one led by the scope carrier, on the same
   columns. Any other addition, removal or change is a finding: either the
   hand-written metadata is wrong, or the platform is — decide which, and take
   a platform deviation to the owner (AGENTS.md "Report, don't silently
   decide"). Only classes the paper test compares (tables, columns,
   constraints, indexes, enum types, comments) are in scope; policies, grants,
   triggers and functions belong to P3.
5. **Record the outcome** where the owner keeps private notes (consumer repo),
   not here. What may come back to this repo is only a generic, de-identified
   statement of a platform defect (a rule or a test on the synthetic domain),
   never an excerpt of the consumer's schema.
6. **Clean up.** Drop the separate database (or leave it, if the owner wants to
   keep it) and `pnpm db:stop` if you started the stack. Orphan shadow
   databases left by a failed run are reported, not hand-dropped blindly.

## Exit conditions

- Sanitary round-trip empty and reconciliation plan equal to the expected set —
  report "match" without details.
- Otherwise report the discrepancy class (not the consumer's names) and stop.
