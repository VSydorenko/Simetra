---
name: writing-tests
description: "Use when you add or change tests in this repo (Vitest unit tests, DB tests `*.db.test.ts`, pgTAP), write the test steps of a plan, or review test form. Sets the level to test at (unit before DB), how to build fixtures (shared builders, not inline metadata JSON), when to table-drive, what to assert (diagnostic codes, not message text), the DB-time budget and the boy-scout rule for existing test files. Complements the `vitest` skill (library API) and the `test-honesty` lens of `code-review` (does the test prove anything)."
---

# Writing tests — Simetra

A test earns its place by **proving a behaviour that could break**: it fails
when the behaviour breaks and passes otherwise. Its cost is not the lines but
the run time, the setup a reader must parse, and the edits it forces when the
behaviour has not changed. Keep the proof, cut the cost.

Most test bloat here is setup, not checks: metadata spelled inline, the same
fixture copied between files, near-identical cases written by hand. The rules
below stop it from growing; an existing file is brought in line only where you
touch it (§ 6).

## 1. Prove behaviour, red first

- Write the test before the change and see it fail for the reason you expect.
- A guard against data loss or a security hole (rights, promotion, apply,
  generated SQL) gets a test that a **mutation of the guard** turns red — one
  per guard, not one per syntactic variant of the same input.
- Do not test a temporary state of the process ("rejects a field until it has
  a consumer"): when the state ends the test is deleted, and until then it
  proves nothing about the product.
- Do not restate a Zod schema case by case. One table-driven test per schema
  covers its accept and reject forms (§ 3); behaviour that the schema enables
  is tested where it is consumed.

## 2. Pick the cheapest level that proves it

| Behaviour | Level |
| --- | --- |
| metamodel, compiler stages, contracts, diagnostics, rendered SQL text | unit (`*.test.ts`) |
| that Postgres accepts, executes or plans the SQL (RLS outcome, DDL apply, engine plans, EXPLAIN shape, locks) | DB (`*.db.test.ts`) |
| provider base state | pgTAP |

**A DB test needs a reason the unit level cannot give** — state it in the test
name or a one-line comment. The full `pnpm test:db` run is a shared, serialized
resource (one run at a time on the machine); every DB case is paid by every
later run of every session. Prefer one DB case that walks a scenario over
several that each rebuild the same database. Name stack objects only through
the run-tag helpers (`AGENTS.md` § "Commands and gates").
Seed users only through provisioning or `signUp` (`packages/simetra/test/db/auth.ts`):
a bare row in the users catalog has no identity, so `current_user_id()` returns
`NULL` and every command fails with a misleading `no-right`.

Designer DB files run one after another (`fileParallelism: false` in
`packages/designer/vitest.config.ts`: roles are cluster-wide and the catalog
extract sees them). Inside a file, tests run concurrently only after the file
passes an isolation audit; then it opts into `describe.concurrent`, capped by
`maxConcurrency`. The audit checklist:

- every test works in its own shadows or copies;
- no mutable file-level state, and no shared `vi.spyOn` / `vi.mock` whose call
  counts a test reads;
- cluster state (roles, role grants, `alter system`) changes only in
  `beforeAll`;
- no `toMatchSnapshot`, `expect.assertions` or `expect.hasAssertions` through
  the global `expect` — a concurrent test takes that `expect` from its context;
- tests sensitive to timing or to other sessions (lock holders,
  `pg_stat_activity`) sit in a separate sequential `describe`;
- a file that is unstable in three runs in a row stays sequential.

## 3. Fixtures: builders, not inline metadata

- Build metadata through the shared fixture modules next to the tests
  (`packages/simetra/src/compiler/__tests__/fixtures/`, `helpers.ts`;
  designer DB support in `packages/designer/src/__tests__/support/`). Start
  from the minimal stable default of a fixture and override only what the case
  is about — the reader should see the one property under test, not forty
  lines of a project.
- When the same setup appears in a second test file, move it into a builder
  in the fixtures module instead of copying it.
- Shared fixtures keep stable defaults; a later task never changes what an
  earlier assertion relies on — it adds an override in its own test.
- A catalog of cases (diagnostics of one rule, accepted forms of one schema,
  kinds × facts) is one `it.each` / `describe.each` table, not N hand-written
  `it` blocks.

## 4. Assert the contract, not the wording

- Assert diagnostic **codes**, pointers and parameters. Message text is
  asserted only by the tests that own the message catalog
  (`packages/simetra/src/compiler/__tests__/messages.test.ts`) or where the text
  itself is the contract (a CLI output format).
- Assert outcomes (the plan, the compiled contract, the rows the role sees), not
  the internal calls that produce them.
- For generated SQL, compare parsed trees or whole statements;
  `toContain` on a fragment proves presence, not the statement.

## 5. Size signals that trigger a rethink

- one test longer than the code it checks;
- the same metadata literal in more than one file;
- more than a handful of near-identical `it` blocks (→ table);
- a new DB test whose assertions read only compiler output (→ unit).

None of these is forbidden; each needs a reason you could say in review.

## 6. Existing tests: the boy-scout rule

Feature work does not rewrite tests it does not touch. In a file you touch,
the tests you add or change follow this skill, and setup you would otherwise
copy goes into a builder. Wholesale cleanup of old files is a separate task,
not a side effect of a feature.

## 7. In plans and reviews

- A plan's test steps name the level (unit or DB) and, for DB, the reason;
  they reuse or add builders instead of spelling metadata inline.
- The `test-honesty` lens of `code-review` checks both questions: does the
  test prove the behaviour (mutation), and does its form follow § 2–§ 4.
