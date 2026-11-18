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
- Run a mutation only on a committed tree and undo it with a reverse patch.
  Never `git stash` (the stash is shared by every worktree) and never
  `git checkout -- <file>` on a file with uncommitted work.
- The oracle is a literal, not the constant the mutation changes. A mutation
  that stays green may be equivalent: first check whether the form can tell
  the behaviours apart.
- A test of a lint rule on a virtual fixture outside `allowDefaultProject`
  gets a `Parsing error` with `ruleId: null`, so both the "refused" and the
  "allowed" (`toEqual([])`) cases pass falsely. The helper fails on `fatal`
  or `ruleId === null`.
- Time-dependent code is tested with fake `performance` / `setTimeout`; real
  timers flake under load.
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
| the same, bound to Supabase (criterion: postgres-profile spec `docs/superpowers/specs/2026-11-08-postgres-profile-design.md` §10.5) | DB (`*.supabase.db.test.ts`, project `db-supabase`) |
| provider base state | pgTAP |

**A DB test needs a reason the unit level cannot give** — state it in the test
name or a one-line comment. A full DB run is a shared, serialized
resource (one run at a time per stack); every DB case is paid by every
later run of every session. Prefer one DB case that walks a scenario over
several that each rebuild the same database. Name stack objects only through
the run-tag helpers (`AGENTS.md` § "Commands and gates").
Provider split (spec `docs/superpowers/specs/2026-11-08-postgres-profile-design.md`
§10.5): a case whose intent carries over to both profiles goes to
`*.postgres.db.test.ts` or the default `*.db.test.ts` and takes provider data
from the profile helpers; a provider-only variant goes to
`*.supabase.db.test.ts`. No expected value branches on the provider inside one
file.
Connection model (same spec, §10.3): tests connect through the stack
superuser with the session role set to the owner. Leave the owner role only
through the helpers (`restoreOwnerRole`, `asSessionLogin`, `asStackSuperuser`
in `packages/simetra/test/db/connection.ts`), and use the superuser only as an
observer or for setup the owner cannot do (`CREATE ROLE`, `CREATE EXTENSION`);
name each such use in the report. Never `GRANT … TO CURRENT_USER`. A test role
granted to the owner needs `WITH INHERIT TRUE`, because `simetra_owner` is
`NOINHERIT`. A case that needs a service role goes to `db-supabase`.
A login role a test creates gets a unique name: a pooler caches the secret by
role name, so a role re-created with the same name and a new password fails
with `28P01`, and a retry does not help.
A test never changes a role the stack already has: no password, membership or
setting on a platform role (`simetra_signals`, `simetra_signal_consumer`, …),
not even with a reset in `afterAll`. Another session sees the change while the
run lasts and after a SIGKILL; a tagged member of a platform group also makes
the role gate refuse every `plan` on the stack. Create a run-tagged copy of
the same shape instead, derive its shape from the T0 role data
(`LOGIN_ROLE_PARENTS`, `LOGIN_ROLE_SETTINGS`), and pin that shape with one case
that compares the copy with T0.
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
- Compare structures with structural equality, not the shape of a projection:
  a shape check stays green under mutations.
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
