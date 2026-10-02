# Simetra

Simetra is an open-source platform for business applications described by
metadata, in the spirit of 1C:Enterprise. An application declares its objects —
catalogs, documents, registers and the rest — and the platform derives
everything mechanical from them: the database schema, permissions, server
commands, the data runtime, standard screens, the application shell and the
tooling. The application keeps only its declarations, business rules and
non-standard screens.

Simetra is meant for **any** business application. MetaHub is its first
consumer, not the goal: that experience extends the concept, but does not narrow
it.

## Status

**Pre-alpha.** Nothing is published to npm yet, and there are no stable APIs.
The platform is built according to the
[platform design spec](docs/superpowers/specs/2026-09-24-simetra-platform-design.md);
progress is tracked in the [roadmap](docs/ROADMAP.md).

What exists today: the metamodel and the compiler (milestone P2), rendering of
the desired database state, a schema-engine port with a first adapter, and the
developer toolset `@simetra/designer` — command line and MCP server over one
catalog of tools. The rest of the platform (data runtime, screens, studio,
package delivery) is ahead on the roadmap.

## Core ideas

- **Metadata is the source of truth.** JSON declarations plus TypeScript
  behaviour modules; types are generated from them.
- **One compiler, one door.** Every tool loads a configuration through the same
  compiler — it is either accepted or rejected with diagnostics, and nothing is
  written unless the result compiles.
- **The schema is derived, not hand-written.** Stable ids for every object and
  attribute let the schema engine tell a rename from a drop-and-add, and schema
  changes roll out without downtime.
- **Tenancy is optional and generic.** The application defines its own scope
  kinds; a single-tenant application declares none. The platform knows no
  consumer vocabulary.
- **A clean runtime and a separate toolset.** The flagship `simetra` package is
  what an application depends on, with tier folders — model, compiler, schema,
  server, data, UI, shell — where imports go only downward. Developer tools
  live in `@simetra/designer` and never reach the application bundle.

The full design, with the reasoning behind each decision, is in the platform
design spec.

## Packages

| Package | What it is |
| --- | --- |
| `simetra` (`packages/simetra`) | The runtime and core: metamodel, compiler and metadata operations, desired-state rendering, schema-engine port |
| `@simetra/designer` (`packages/designer`) | The developer toolset, binary `simetra`: one tool catalog served by the command line and an MCP server (a visual studio follows as another mode), the schema-engine adapter, and agent skills for consumer projects |

`examples/reference` holds a synthetic reference domain used by the tests.
`legacy/` is the frozen prototype that predates the platform design: read-only
reference material, not built or tested. A map of the repository and how its
parts connect is in [docs/architecture](docs/architecture/README.md).

## Using the toolset

The tools work on a `metadata/` directory: `compile`, `explain` (the compiled
picture of an object), `fix` (missing ids and physical names), and the checked
mutations `create`, `add`, `rename` (with a cascade over every reference) and
`delete` (refused while anything references the target). A mutation writes files
only when the result compiles without errors; `--dry-run` previews, and
destructive tools need `--yes`.

Inside this repository, until the package is published:

```bash
node packages/designer/bin/simetra.mjs compile examples/reference/metadata
node packages/designer/bin/simetra.mjs explain Document.ServiceAccrual examples/reference/metadata
node packages/designer/bin/simetra.mjs mcp examples/reference/metadata    # MCP over stdio, read-only
```

The MCP server is read-only by default: every tool is listed, and a write tool
answers with how to enable writes (append `--allow-write` to the server's
arguments). It never touches a database. In a consumer project the package will
be installed as a dev dependency, and `simetra init` will link its agent skills
and write a read-only MCP configuration — that arrives with package delivery
(see the roadmap). How it works: [docs/architecture/designer.md](docs/architecture/designer.md).

## Getting started

Prerequisites: the Node.js version in [`.node-version`](.node-version) and pnpm
via Corepack (the exact version is pinned in `package.json`).

```bash
corepack enable
pnpm install
pnpm test               # unit tests
pnpm metadata:check     # compile every metadata directory in the repo
```

Database tests run against a local Supabase stack (Docker):

```bash
pnpm db:start && pnpm test:db && pnpm db:stop
```

Before opening a pull request, run the same gates as CI:

```bash
pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm metadata:check
```

## Documentation

- [docs/BRD.md](docs/BRD.md) — vision and domain model: what Simetra is and for
  whom.
- [Platform design spec](docs/superpowers/specs/2026-09-24-simetra-platform-design.md)
  — architecture and mechanisms: how it works and why; sub-specs live next to it
  in `docs/superpowers/specs/`.
- [docs/architecture](docs/architecture/README.md) — a map of the repository as
  it is now: packages, the path from metadata to the database, the toolset.
- [docs/ROADMAP.md](docs/ROADMAP.md) — milestones and their status.
- [docs/research/README.md](docs/research/README.md) — the research behind
  past decisions: 1C metadata model, analogues, schema engine, tooling,
  licensing, stack.
- [AGENTS.md](AGENTS.md) — rules for contributors and coding agents.

Internal design documents are written in Ukrainian; everything a consumer or
contributor reads first is in English.

## Contributing

Contributions are signed off under the Developer Certificate of Origin. How to
contribute — DCO, gates, the policy for copying code from other projects and
for dependencies — is in [CONTRIBUTING.md](CONTRIBUTING.md); contributor and
agent rules — language policy, boundaries, git discipline — are in
[AGENTS.md](AGENTS.md).

## License

[Apache-2.0](LICENSE)

Copied third-party code and its notices are listed in
[THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES).

Simetra is not affiliated with, endorsed by or associated with 1C Company or
its products. "1C" and "1C:Enterprise" are registered trademarks of their
respective owners. Simetra is an independent open-source project inspired by
the concepts of 1C:Enterprise.
