# Contributing to Simetra

Thank you for considering a contribution. Simetra is pre-alpha: the platform is
being built according to the
[platform design spec](docs/superpowers/specs/2026-09-24-simetra-platform-design.md),
and the rules shared by human contributors and coding agents live in
[AGENTS.md](AGENTS.md). This file adds what a contribution needs on top of them.

## Developer Certificate of Origin

Simetra uses the [Developer Certificate of Origin](https://developercertificate.org/)
(DCO) instead of a CLA. Every commit in a pull request from a contributor must
be signed off; the owner's own commits are signed off at the owner's discretion:

```bash
git commit -s -m "fix(cli): <description>"
```

The `Signed-off-by: <Name> <email>` line certifies that you wrote the change or
otherwise have the right to submit it under the project licence
([Apache-2.0](LICENSE)).

`Signed-off-by` is the only trailer allowed in a commit, and only the author
adds it, under their own git identity. Agents acting for the owner never add
trailers and never sign off for the owner; `Co-Authored-By`, "Generated with"
and similar trailers are not accepted.

## Language

Identifiers, public API names, JSDoc on exported API and CLI and validation
messages are in English. Code comments (explaining why), specs, plans, BRD,
ROADMAP and research are in Ukrainian. Commits use a Conventional Commits
prefix with a Ukrainian description. Details are in [AGENTS.md](AGENTS.md)
§ "Language policy".

## Before opening a pull request

Run the same gates as CI; the commands are listed in [AGENTS.md](AGENTS.md)
§ "Commands and gates". If you edit docs or skills, or move or rename a file,
also run the documentation anchor check listed there.

## Copying code from other projects

Reusing good open-source code is welcome, within these rules.

**Allowed sources.** Code may be copied only from projects licensed under MIT,
Apache-2.0, BSD, ISC or the PostgreSQL License. Check the licence in the
source repository's `LICENSE` file, not in npm or GitHub metadata — they
disagree often enough.

**File header.** Every file that contains copied code starts with a header
naming the source and its licence; a modified copy says so:

```ts
// Portions copied from <project> (<source URL>, <path in source>)
// Copyright (c) <year> <copyright holder>
// Licensed under <licence>. Modified: <what changed, or "no">.
```

**Notice entry.** In the same change, add an entry for the source to
[THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES) in the format described there, or
extend the existing entry with the new files.

**Clean-room only.** Code under GPL, LGPL, AGPL, BSL, FSL, PolyForm, SSPL or a
proprietary licence is never copied: learn from its documentation and
observable behaviour, and do not reproduce its code structure. Do not read
NocoBase code at all — its licence forbids building low-code platforms on it.
For Directus and OES Enterprise, use public documentation only.

## Dependencies

A dependency in alpha, beta or 0.x status is always pinned to an exact version
and upgraded deliberately, never by a version range. When it shapes a runtime
or artifact contract (the schema engine, the collection engine, the tabular
section grid, the `Database` type generator), it also enters only behind a
Simetra port (an interface Simetra owns) and is upgraded through Simetra's
contract tests for that port. A purely tooling dependency (a CLI parser, a
build tool) needs only the exact pin.

## Disclaimer

This policy is a practical guide for contributors, not legal advice. When in
doubt about a licence, ask in the issue or pull request before copying.
