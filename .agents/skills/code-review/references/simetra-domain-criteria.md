# Simetra domain criteria — per lens

Contents: how to apply these rules · `architecture` · `data-layer` (metamodel,
physical naming and SQL, target schema engine) · `test-honesty` · `drift`.

**Load when** your lens is `architecture`, `data-layer`, `test-honesty` or
`drift`. `correctness` and `history` do not need this file.

This file says **what to check**. How the platform works lives in the platform
spec, `docs/superpowers/specs/2026-09-24-simetra-platform-design.md` (cited
below as "spec §N"), and in the code named in each row; the code is the truth.
A contradiction between code and a doc is itself a `drift` finding.

## How to apply these rules

Simetra is a general metadata platform for any business application, in the
spirit of 1C:Enterprise; MetaHub is its first consumer, not its goal. The
packages in this repo are a **prototype**; the target is the tier layout of the
spec, and spec §14 decides the fate of the packages it names (a package it does
not name has an open fate — the owner decides). Two rule sets follow from that:

- **Target rules** (marked *target*) apply to new platform code, to code moving
  into a tier, and to anything the diff presents as the new mechanism.
- **Prototype rules** (marked *prototype*) are what the current code enforces;
  they bind diffs that change prototype packages while those packages exist.
- Pre-existing prototype divergence from the target is **outside the boundary**
  (confidence 0). A diff that *copies* a prototype convention into target code
  where the spec replaced it is a finding.

## Lens `architecture`

| Check | Defect signal | Model |
| --- | --- | --- |
| imports go downward (*target*) | a tier imports a higher-numbered tier (T0 `model`, T1 `compiler`, T2 `schema`, T3 `server`, T4 `data`, T5 `ui`, T6 `shell`); a tier boundary crossed with no lint zone and negative test covering it | spec §3.1 |
| package direction (*prototype*) | a package imports a package that depends on it; `simetra/model` gains any workspace dependency | each package's `package.json` |
| core stays pure (carries into T0) | T0 `simetra/model` gains a runtime dependency other than `zod`, or its non-test source imports anything but `zod` and own modules (React, `node:*`, `fs`, `process`). The lint holds it; look for a bypass: dynamic `import()`, a new dependency in `packages/simetra/package.json` that T0 imports. Tests may read fixtures with Node APIs | `packages/simetra/eslint.tier-zones.js` |
| client/server split (*target*) | a server entry point or secret reachable from a client entry or the browser catalog; a static import of an implementation into runtime registration instead of a lazy thunk | spec §3.1, §3.3 |
| platform/consumer boundary | platform code names a consumer's concepts (tenant kinds such as company or hub, membership, billing, role archetypes); scope hard-coded instead of the "scope kind + id" pair the application defines; a single-tenant application forced to declare scope | spec §1, §2 (Р10) |
| public repo hygiene — `blocker` | a consumer's private detail committed: real project refs, deployment or infrastructure IDs, tenant or customer names, private domains, secrets, dumps of a consumer's schema | spec header |
| module boundary (*target*) | a module writes to an object it does not own other than through the owner module's command; a generated command without the owner runtime guard | spec §9 (Р15) |
| compiler is the only door (*target*) | code below the compiler reads raw `*.meta.json`; a second loader or validation path beside the compiler | spec §2 (Р3), §5 |
| JSON/module line (*target*) | executable behaviour placed in JSON, or tool-editable facts buried in module code | spec §4 |
| no dual code path | "old + new" mechanisms live in parallel, a migration left half done, dead code left behind | `AGENTS.md` |
| no investment in a dead path | new features or abstractions added to a package spec §14 slates for deletion, unless the task asked for it; fixes that keep gates green are fine | spec §14 |

## Lens `data-layer`

### Metamodel (*prototype*, verified in `packages/simetra/src/model`)

| Check | Defect signal | Model |
| --- | --- | --- |
| Zod is the source of truth | a hand-written type duplicating a schema shape instead of `z.infer`; a schema or enum re-declared outside T0 instead of imported from `simetra/model`; `z.any()` in a schema | `packages/simetra/src/model/schemas/` |
| standard attributes derive from the kind | standard columns listed by hand in a generator or UI instead of reading the kind registry (`standardColumns`); standard attributes persisted as user attributes; anything but description overrides stored for them | `packages/simetra/src/model/kinds/` |
| one Ref model | a new per-kind reference type; a `Ref` attribute with both `ref` and `allowedTypes`, or neither; `ref`/`allowedTypes` on a non-`Ref` type; a reference target outside the referenceable kinds; `parent_id` modelled as a Ref | `packages/simetra/src/model/schemas/attribute.ts`, `packages/simetra/src/model/schemas/metadata-ref.ts` |
| register field roles | dimensions, resources and attributes merged or bypassed; an accumulation-register resource that is not `Integer` or `Numeric` | `packages/simetra/src/model/schemas/accumulation-register.ts` |
| names and reserved words | a new name-bearing field with its own regex instead of `TECHNICAL_NAME_PATTERNS`, or without the `isSqlReservedWord` refinement; missing uniqueness within the parent array | `packages/simetra/src/model/schemas/identity.ts`, `packages/simetra/src/model/schemas/sql-reserved-words.ts` |
| deterministic files | serializer output that depends on insertion order; volatile data (timestamps, checksums) written into metadata files | — |
| posting and condition DSL | an expression reaching SQL without passing the mapping or condition schema; the grammar widened in the generator but not in the schema and its tests | `packages/simetra/src/model/schemas/posting.ts` |

### Physical naming and SQL (*prototype*)

| Check | Defect signal | Model |
| --- | --- | --- |
| physical names come from helpers | table names built by string concatenation instead of `physicalObjectName` / `physicalTabularName` (and the generator's prefixing wrappers); column names for `Ref` attributes built by hand instead of the column-naming helpers | `legacy/generator-pg/src/column-naming.ts` |
| escaping | a metadata value interpolated into SQL without `quoteIdentifier` or `escapeLiteral` | `legacy/generator-pg/src/naming.ts` |

### Schema engine and data runtime (*target*)

| Check | Defect signal | Model |
| --- | --- | --- |
| identity (Р4) | objects or attributes matched by name where a UUID exists; an id regenerated, reused, or assigned anywhere but at creation | spec §2, §6.2 |
| name ≠ column (Р5) | a rename that emits DDL; `physicalName` re-derived from the current name instead of assigned once | spec §2, §7 |
| write pattern is a property of the kind | one entity written both through the collection and through RPC; an optimistic-pattern table with `DEFAULT` on `id`; a server-pattern document whose `id` the client generates | spec §4 |
| RLS template form | a generated scope, permission or ownership predicate in correlated per-row form instead of `column = ANY(ARRAY(SELECT fn()))` over a `SETOF uuid`, `STABLE` function; a new template without the EXPLAIN test | spec §6.8 |
| grants (Р14) | reliance on provider default privileges; a grant or `EXECUTE` that is implicit; a user-reachable `SECURITY DEFINER` function without a fixed `search_path` or without its own membership check | spec §6.7 |
| zero-downtime changes | a destructive change not explicitly allowed; a new required attribute or type change applied in one step instead of expand → contract | spec §6.6, §7 |
| accumulation registers | balances computed by window-function views over the whole movement history instead of the trigger-maintained totals table | spec §4 |
| writes | a browser write outside generated or explicit server commands; a Server Function source that serializes data before authorizing it | spec §8.3, §8.4 |

## Lens `test-honesty`

| Check | Defect signal |
| --- | --- |
| nothing silenced to go green | `.skip`, `.only` or `.todo` added; an assertion deleted or loosened; a threshold lowered; a file excluded from test, lint or typecheck config |
| no suppressions | `@ts-ignore`, `@ts-expect-error`, `eslint-disable` or `as any` added to pass a gate; an unavoidable one without a Ukrainian comment saying why |
| schema changes carry tests | a new or changed Zod schema without accept and reject cases in core's tests |
| generated SQL assertions | `toContain` on a fragment proves presence, not the statement; mutate the generator branch and confirm red |
| tests do not time the machine | an assertion that depends on wall-clock speed or contention |

## Lens `drift`

Documentation style, per `AGENTS.md`:

- no counts and no completeness claims — they rot silently;
- the code is the source of truth; a doc points at it instead of copying lists;
- one fact lives in one doc; the rest link to it;
- a doc states the current state; history belongs to git — no dates, phase
  narrative, PR numbers or version footers;
- anchors name files and sections, never line numbers or SHAs; an example shows
  the shape, not a copy of code;
- three layers: specs say *what and why*, skills say *how to do a task*, code is
  the truth; a model retold in a skill or a recipe in a spec is a duplicate.

Language placement, per `AGENTS.md`: the harness itself, README, public API
names, JSDoc on exported API, package skills, CLI and validation messages in
English; specs, plans, BRD, roadmap and code comments (which explain why) in
Ukrainian; commit descriptions in Ukrainian after a Conventional Commits prefix. Formatting is Prettier's (`.prettierrc`), never a
finding.
