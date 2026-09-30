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

The repository currently contains a **prototype** that predates the platform
design. The platform itself is being built according to the
[platform design spec](docs/superpowers/specs/2026-09-24-simetra-platform-design.md);
the prototype packages are reference material, and the spec decides which parts
carry over and which are removed. Progress is tracked in the
[roadmap](docs/ROADMAP.md).

## Core ideas

- **Metadata is the source of truth.** JSON declarations plus TypeScript
  behaviour modules; types are generated from them.
- **One compiler, one door.** The CLI, the Vite plugin, MCP and the configurator
  all load a configuration through the same compiler — it is either accepted or
  rejected with diagnostics.
- **The schema is derived, not hand-written.** Stable ids for every object and
  attribute let the schema engine tell a rename from a drop-and-add, and schema
  changes roll out without downtime.
- **Tenancy is optional and generic.** The application defines its own scope
  kinds; a single-tenant application declares none. The platform knows no
  consumer vocabulary.
- **One flagship package** with tier folders — model, compiler, schema, server,
  data, UI, shell — where imports go only downward.

The full design, with the reasoning behind each decision, is in the platform
design spec.

## Repository layout

- **Prototype** — the packages under `packages/` and the apps under `apps/`: a
  Zod metamodel, a PostgreSQL DDL generator with a CLI, a web-based metadata
  configurator and an experimental runtime. Useful to read and run; not the
  target architecture.
- **Target** — the flagship `simetra` package plus a few separate packages (CLI,
  studio, app template), described in the platform design spec. The
  reorganisation into it is a roadmap milestone.

## Getting started

Prerequisites: the Node.js version in [`.node-version`](.node-version) and pnpm
via Corepack (the exact version is pinned in `package.json`).

```bash
corepack enable
pnpm install
pnpm test           # run the test suites
pnpm dev:web        # run the prototype metadata configurator
```

Before opening a pull request, run the same gates as CI:

```bash
pnpm format:check && pnpm lint && pnpm typecheck && pnpm test
```

## Documentation

- [docs/BRD.md](docs/BRD.md) — vision and domain model: what Simetra is and for
  whom.
- [Platform design spec](docs/superpowers/specs/2026-09-24-simetra-platform-design.md)
  — architecture and mechanisms: how it works.
- [docs/ROADMAP.md](docs/ROADMAP.md) — milestones and their status.
- [docs/research/README.md](docs/research/README.md) — the research behind
  past decisions: 1C metadata model, analogues, schema engine, licensing, stack.
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
