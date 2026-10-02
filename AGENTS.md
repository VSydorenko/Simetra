# Simetra

Simetra is an open-source (Apache-2.0) platform for business applications
described by metadata, in the spirit of 1C:Enterprise: an application declares
its objects (catalogs, documents, registers, …), and the platform derives
everything mechanical from them — database schema, permissions, server
commands, data runtime, standard screens, shell and tooling. It is meant for
**any** business application. MetaHub is the first consumer, not the goal:
its experience extends the concept but must never narrow it.

## Language policy

- **Talk to the owner in Ukrainian**, even when the request is in English.
- **Code comments — Ukrainian**, and they explain **why**, not what.
- **Internal docs — Ukrainian:** specs, plans, BRD, ROADMAP.
- **Everything a consumer or contributor reads — English:** README, public API
  names, JSDoc on exported API, skills shipped inside packages, CLI and
  validation messages, and this harness itself (`AGENTS.md`, `CLAUDE.md`,
  bodies of harness skills, agents and commands).
- **Commits:** Conventional Commits prefix, description in Ukrainian —
  `fix(cli): …`, `docs(spec): …`.
- Slash-command file names stay Ukrainian: the owner types them.

## What this file is

The rules shared by every agent harness. It changes rarely and holds only what
is stable: boundaries, invariants, discipline. Deliberately absent: code
examples, counts, directory trees, line anchors and retellings of the spec —
they rot within weeks while agents keep reading them as truth. Current state
comes from the code (code-research tooling below); current design — from the
specs. Claude Code specifics live in `CLAUDE.md`.

## Sources of truth

1. **Platform spec** `docs/superpowers/specs/2026-09-24-simetra-platform-design.md`
   and the sub-specs next to it in `docs/superpowers/specs/` — the **how**:
   architecture, mechanisms, decisions. A sub-spec refines the platform spec;
   it does not contradict it silently.
2. **Code** — the real state. Where code and spec disagree, that is a defect:
   either the code is fixed or the spec is amended with the owner. Silent drift
   is not acceptable.
3. **BRD** (`docs/BRD.md`) — vision and domain model: **what** and **for whom**.
   No technical mechanisms there; it points to the spec.
4. **ROADMAP** (`docs/ROADMAP.md`) — the one place for status of milestones.
5. `docs/research/` — background for past decisions, not rules. The index and
   the rules for adding new research are in `docs/research/README.md`.

Decisions that change the platform spec go through the owner. If you need to
deviate from a spec, stop and report the deviation — never decide it silently.

## Platform / consumer boundary

- The platform knows no consumer vocabulary (a consumer's "company" or "hub").
  Tenant scope is optional and generic: the application defines its scope
  kinds; a single-tenant application declares none.
- Consumer-specific behaviour belongs in the consumer's repo, reached through
  platform extension points — never as a special case inside the platform.
- **This repo is public.** Never commit a consumer's private material: schema
  dumps, generated types from a real database, project refs, deployment IDs,
  tenant or customer names, secrets. Spikes against real consumer data keep
  their results out of git.

## Target architecture vs. the prototype

**Target** (platform spec §3): one flagship package `simetra` with tier folders
under lint zones — T0 `model`, T1 `compiler`, T2 `schema`, T3 `server`,
T4 `data`, T5 `ui`, T6 `shell`. **Imports go only downward.** A separate package
exists only for a unit with its own life cycle (CLI, studio, app template);
versions are lockstep. Both this tier order and the framework boundary below are
enforced by `packages/simetra/eslint.tier-zones.js` with the negative test
`packages/simetra/test/tier-boundary.test.ts`; changing the tier table is an
owner decision.

**Framework boundary** (a lint zone): T5 imports only React, T4 contracts and
the navigation adapter interface; framework adapters live in T6; the host
template and the studio are the only places that import TanStack Start. It is
held by the same `packages/simetra/eslint.tier-zones.js` and its negative test.
In `@simetra/designer` the studio is `src/studio` and nothing else there imports
TanStack Start; that zone is held by `packages/designer/eslint.zones.js` and its
negative test `packages/designer/test/studio-boundary.test.ts`.

**Engine adapter boundary.** Production sources of `simetra` do not import `pg`
or the pg-delta engine package: the schema-engine adapter lives in `@simetra/designer`
and is passed into the T2 port from outside. It is held by
`packages/simetra/eslint.tier-zones.js` and its negative test
`packages/simetra/test/tier-boundary.test.ts`.

**Consumer skills** ship inside their package and never live in
`.agents/skills`, which holds only skills for developing the platform itself.
Platform agents never load a consumer skill.

**Current code is a prototype.** The prototype metamodel lives in T0
(`packages/simetra/src/model`) and is rebuilt in place (P2 spec M9). The rest
of the prototype (CLI, generators, UI, web configurator) is frozen in
`legacy/`: read it, but do not build, test, import or extend it. Platform spec §14 sets the fate (becomes T0, stays as reference,
is deleted) of the parts it names — read it there, do not restate it. A package
§14 does not name has an **open** fate: treat it as neither slated for deletion
nor adopted, and ask the owner before investing in it or removing it.
Consequences:

- Do not extend a package slated for deletion; touch it only to keep the gates
  green.
- Code from `legacy/` is taken only as a reference for a new implementation.
- Treat prototype behaviour as a reference, not as a contract, unless the spec
  adopts it.

## Metamodel rules (T0 `packages/simetra/src/model`)

These hold for T0 and for every tier that reads metadata:

- **Zod schemas in T0 `simetra/model` are the single source of truth** for
  metadata types. TypeScript types are `z.infer` of them; other packages
  import schemas and types from `simetra/model` and never re-declare them.
- **T0 `simetra/model` has no runtime dependency except `zod`.** No React, no UI, no Node
  APIs in library source (tests may use Node).
- Every kind schema carries a `kind` literal; no `z.any()` in schemas.
- **Standard attributes are derived from the kind** and its settings; the
  kind registry (`packages/simetra/src/model/kinds/`) is their single source
  of truth. They are never stored as custom attributes in metadata files, and
  derivation rules change only together with the spec.
- **Every branch on the kind reads the kind registry.** Code that behaves
  differently per kind takes the fact from the kind's registry entry instead
  of switching on the kind name; a new kind is a new registry entry plus tests.
- **One reference type, `Ref`.** A single target is `ref`, a polymorphic one is
  `allowedTypes`; the two are mutually exclusive. Every cross-object reference
  uses the same `MetadataRef` shape — no per-kind reference types.
- **Register field roles:** dimensions (key), resources (values), attributes
  (extra info). Accumulation register resources are `Integer` or `Numeric` only.
- Metadata files are diff/merge-friendly JSON: no volatile data (timestamps,
  checksums) inside them.
- New or changed schemas come with tests.
- **Identity is a UUID, not a name** (platform spec decisions Р4, Р5). Every
  named element — object, attribute, tabular section, enumeration value,
  `CustomTable` column — carries a UUID `id` that is never reused. References
  in files use the logical name, `{ kind, name }`; the compiler resolves them
  to ids. `physicalName` is assigned once at creation and never changes, so a
  rename emits no DDL. The style of logical attribute names is the project's
  `naming.attributeCase`. Never build a mechanism on the name as identity.

## Behavioural principles

1. **Think before coding.** Don't assume; surface trade-offs; if a simpler
   solution exists, say so.
2. **Simplicity.** Minimum code. No features, abstractions or error handling
   nobody asked for.
3. **Surgical changes.** Change only what the task needs; keep the style of the
   file you are in.
4. **Goal, not process.** Define the success criterion, then work until it is
   verified. Tests first where possible.
5. **No backwards-compatibility shims.** Pre-release: when something is
   replaced, delete the old path in the same change — no aliases, re-exports or
   "deprecated" wrappers.
6. **Report, don't silently decide.** Uncertainty, a conflict between sources,
   or a needed deviation from the plan — stop and report it to the owner.
7. Dead code you notice outside your task — mention it, don't delete it.

## Commands and gates

```bash
pnpm install                              # pnpm via corepack (packageManager)
pnpm --filter <pkg> test                  # during work — scoped
pnpm --filter <pkg> test <pattern>        # vitest filter
pnpm --filter <pkg> typecheck
pnpm --filter <pkg> lint

pnpm format:check && pnpm lint && pnpm typecheck && pnpm test   # before a PR
pnpm format:fix                           # fixes what format:check reports

python3 scripts/check-doc-anchors.py      # dead paths / § pointers in docs
pnpm metadata:check                       # simetra compile --all via packages/designer/bin; pre-commit runs it with --staged

pnpm db:start                             # local Supabase stack (needs Docker)
pnpm test:db                              # provider base-state pgTAP tests + Vitest DB tests (*.db.test.ts) of simetra and @simetra/designer against the local stack
pnpm db:stop
```

- 🔴 **No `--` before a vitest pattern** with `pnpm --filter`: the pattern is
  then silently ignored and the whole suite runs, so a "green" filtered run
  proves nothing.
- The local stack is started only through `pnpm db:*` (pinned CLI version),
  never through a global `supabase`.
- CI (`.github/workflows/ci.yml`) runs the same four gates plus
  `pnpm metadata:check` and a `db` job that starts the stack and runs `pnpm test:db`. It does not run
  the anchor check — run it yourself whenever you edit docs or skills, or
  rename or move a file.
- Versions live in `.node-version` and `package.json`, not here.
- `tsc` is TypeScript 7 (native); the `typescript` package is aliased to
  TypeScript 6 because typescript-eslint needs its JS API. Don't "fix" the
  aliases.
- Formatting belongs to Prettier (`.prettierrc`); don't argue with it by hand.
- Naming: `camelCase` variables and functions, `PascalCase` types and
  components, `UPPER_SNAKE_CASE` constants, `kebab-case` files. Strict
  TypeScript: no `any` — use `unknown` or a concrete type.

## Git discipline

- Conventional Commits with a Ukrainian description.
- 🔴 **Never add `Co-Authored-By`, "Generated with" or any other trailer** to
  commits or PRs — they are authored by the owner. The one exception is the
  author's own DCO `Signed-off-by`, added by `git commit -s` under the author's
  git identity; an agent never adds it on its own or signs off for the owner.
- Commit or push **only when the owner asks**.
- A fix branch in the middle of a session starts from the **current** working
  branch, not from `main` — the working branch may hold unpushed commits.
- Don't rewrite history (rebase, amend, reset, force-push) on a shared branch
  without a backup ref. A commit you didn't make may come from a parallel
  session on the same checkout — find out where it came from first.
- Never stage build output, `temp/`, local snapshots or secrets.

## Reuse and licensing

- Before copying code from another project or adding an alpha, beta or 0.x
  dependency, read [CONTRIBUTING.md](CONTRIBUTING.md) § "Copying code from
  other projects" and § "Dependencies" — the allowed licences live only there.
- Never read NocoBase code: its licence forbids building low-code platforms on it.
- Check a licence in the source repository's `LICENSE` file, not in npm or
  GitHub metadata.

## Documentation style

Applies to this file, `CLAUDE.md`, skills, BRD, README and specs. Specs and
plans are dated decision records by nature (file name, status line); their
bodies still follow the rules.

1. **No counters and no completeness claims.** "N kinds", "all pickers
   migrated" rot silently, and a fresh agent can't verify "all". Write the
   rule, not the state; if state is needed, give the command that recomputes
   it.
2. **Code is the SSOT; docs point, not copy.** Lists of kinds, attributes or
   helpers live in schemas and registries; a doc holds the rule, one or two
   examples and a pointer to the full list.
3. **One fact — one doc.** Everything else links to it; duplicates diverge.
4. **Docs describe state; git holds history.** No phase narrative, PR numbers
   or "updated on" footers. A past incident stays only as a rule for the
   future. ROADMAP is the one place for status.
5. **Anchors without line numbers or SHAs.** Point to a file, not
   `file.ts:171`. A code example only when the rule is unclear without it — a
   short shape with placeholders plus `Reference: <path>`. After writing an
   anchor, run `scripts/check-doc-anchors.py`.
6. **Three layers, each fact in one of them.** Specs answer **what and why**
   (model, invariants, boundaries, trade-offs). Skills (`.agents/skills/<name>/`)
   answer **how to do a task** (trigger, branches, steps, checklist) and link to
   the spec instead of retelling it. Code is the truth. A model explanation in
   a skill or a step-by-step recipe in a spec is a duplicate — move it to its
   layer and leave a link.

## Code research

Start from a question in human words, not a symbol name. The procedure, the
report format and the degradation rules are in the `codebase-research` skill.
Docs and plan anchors are checked by one agent-neutral script:

```bash
.agents/skills/codebase-research/scripts/orient --map "<topic>"   # ranked docs for a topic
.agents/skills/codebase-research/scripts/orient --plan <plan-file> # plan anchors vs. code
```

- A recon agent in an unfamiliar area uses the harness code tooling plus
  `orient --map`.
- **A task executor re-checks its plan with `orient --plan` before starting its
  block** — a map handed over in a prompt is stale by the time work starts.
- Reviewers and verifiers read freely; code tooling only for coverage.

Which code-graph tool a harness has, and who gets it, lives in the
harness-specific file (`CLAUDE.md` for Claude Code).

## Where to look next

- **Platform spec** and sub-specs — `docs/superpowers/specs/`. Read the section
  relevant to your task, not everything.
- **Plans** — alongside specs under `docs/superpowers/`.
- **BRD** and **ROADMAP** — `docs/`.
- **Skills** — `.agents/skills/<name>/SKILL.md`. Load the matching one **before**
  implementing, not after.
- **Library APIs** — check current docs through tooling, not from memory.

<!-- intent-skills:start -->

# Skill mappings - when working in these areas, load the linked skill file into context.

skills:

- task: "find where code lives, what a change affects, whether a plan still matches the code, or how an unfamiliar subsystem works"
  load: ".agents/skills/codebase-research/SKILL.md"
- task: "review landed work before merge: choosing lenses, severity x confidence scale, adversarial verification of findings"
  load: ".agents/skills/code-review/SKILL.md"
<!-- intent-skills:end -->
