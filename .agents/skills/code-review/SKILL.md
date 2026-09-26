---
name: code-review
description: Use when reviewing landed work before merge — a branch, an implementation phase, a plan's execution, or another agent's changes in this repo. Defines the relevance gate and diff boundary, the fixed severity × confidence scale with an 80 threshold, the review lenses chosen by what the diff touches, the mandatory adversarial refutation of every finding, the report format and known false-review patterns. Use INSTEAD of the generic code-review plugin: that one targets GitHub PR comments, this one reviews a local branch against Simetra's platform rules.
---

# Code Review — Simetra

The goal is **not to find as much as possible**. It is to miss nothing that would
cost a separate fix phase, and not to bury the owner in noise.

> A large share of first-pass findings do not survive an honest refutation
> attempt. Once false positives pass roughly one in five, people stop reading the
> report, and the review becomes theatre.

So exactly two things are mandatory: **the confidence filter** and **an attempt
to refute every finding**. Everything else is tuning.

| Your task | Where |
| --- | --- |
| decide whether this diff is worth reviewing and what it is measured against | § «0. Relevance gate» |
| assign severity and confidence, decide what goes into the report | § «1. Scale» |
| pick lenses for a concrete diff | § «2. Lenses» |
| refute a finding — your own or someone else's | § «3. Adversarial step» |
| shape the output and know what is not a finding | § «4. Report format» |
| calibrate against known classes of false review | § «5. Anti-patterns» |
| how many passes and who consolidates them | § «6. Orchestration» |
| Simetra domain criteria: tiers, platform/consumer boundary, metamodel, generated SQL, test honesty, doc style | `references/simetra-domain-criteria.md` |

**Language.** This skill is English; the report is read by the owner and is
written **in Ukrainian**. Severity tokens (`blocker`/`major`/`minor`), verifier
verdicts (`CONFIRMED`/`REFUTED`/`PARTIAL`) and lens names stay as written here.

---

## 0. Relevance gate

Do not review what is not worth reviewing. Skip it (and say so in one line) when
the diff is only: a rename with unchanged semantics and green gates, a lockfile
update, formatting, or a docs-only change with no code. (A docs-only change can
still get the `drift` lens alone when the docs are the deliverable.)

This is the wrong skill when **the code has not landed yet** (that is design
review or planning) or when the target is **someone else's GitHub PR** — use the
built-in `/review` there.

Before starting, fix the **boundary**: `git diff <base>...HEAD` or an explicit
commit range. A review without a boundary turns into a repo audit and drowns in
pre-existing problems the diff has nothing to do with.

**Prototype vs target.** The packages in this repo are a prototype; the target is
the platform spec, `docs/superpowers/specs/2026-09-24-simetra-platform-design.md`
(tiers T0–T6). Pre-existing prototype divergence from the
target is outside the boundary. What the diff *adds* is judged by the rules in
`references/simetra-domain-criteria.md`, which says when target rules apply and
when prototype rules do.

---

## 1. Scale — fixed, no variations

Severity has exactly three values: free text cannot be aggregated.

| Severity | Criterion |
| --- | --- |
| `blocker` | broken behaviour, data loss, an access hole, a private detail leaked into this public repo, or the task not done in substance |
| `major` | a defect that will surface in use or at the next phase; debt that multiplies (a second code path, a boundary crossed "just this once") |
| `minor` | local untidiness; cheap to fix, does not block |

Confidence 0–100 — use this rubric, and hand it to the executor verbatim:

| Confidence | Exactly when |
| --- | --- |
| **0** | does not survive a light check, or is a pre-existing defect outside the diff |
| **25** | possibly real, but could not be confirmed; style not named in the canon |
| **50** | real, but rare or minor relative to the rest of the diff |
| **75** | checked, very likely to fire in practice; or directly contradicts `AGENTS.md`, the platform spec or the domain criteria |
| **100** | proven by code: there is a concrete input or state under which it breaks |

**Threshold: findings with confidence < 80 do not enter the report** — they go
into the "below threshold" list, one line each.

---

## 2. Lenses — pick by what the diff touches

Lenses are not "quality dimensions" but **different signal sources**: one lens =
one independent pass (a separate agent where possible). Usually 3–4 of the six
fire.

| Lens | Mandatory when | What it looks for |
| --- | --- | --- |
| **correctness** | always | bugs in the changes themselves: edge cases, `null`/`undefined`, bounds, wrong conditions, unhandled schema branches. Reads **only the diff** plus minimal context — deep immersion here produces nitpicks |
| **test-honesty** | the diff touches tests, fixtures or test/lint config | would the test actually fail if the code broke (mutation check); do fixtures and mocks match the **real** schema shapes and call forms; were tests skipped, loosened or suppressed to go green |
| **drift** | there is a plan, spec, skill or doc in play | divergence between what is written and the code: unfulfilled items, `[X]` without code, stale claims in specs, `AGENTS.md`, skills, READMEs; doc-style and language-placement rules. **Start with `./scripts/check-doc-anchors.py`** — it reports dead paths and `§` pointers in seconds, the cheapest drift class; then look for what the guard cannot see: claims that lie rather than point |
| **architecture** | more than two packages touched, a shared package, or anything tier-shaped | import direction and tiers, platform/consumer boundary, module boundary, client/server split, legacy and dual "old + new" code paths, dead code, investment in packages slated for deletion |
| **data-layer** | the metamodel, serialization, generators, SQL, schema plans, RLS, grants, write paths | metamodel invariants (Zod as source of truth, standard attributes, the Ref model, naming), generated DDL/RLS/triggers/grants, identifier and literal escaping, identity and rename safety, write patterns |
| **history** | old or hot code changed | `git log -p` / `git blame` on the changed places: what was already fixed here and whether that fix is being rolled back |

**Read `references/simetra-domain-criteria.md` when you work the
`architecture`, `data-layer`, `test-honesty` or `drift` lens** — it holds the
Simetra-specific checks for each of them. `correctness` and `history` do not
need it.

**`history` is the lens people forget most**, and the context "this was broken
before, here is how it was fixed, and the fix is now being reverted" comes from
no other lens.

**React memoization changes are not gated.** A diff that adds or removes
`useMemo`/`useCallback` or disables `react-hooks/*` rules is caught by neither
lint nor tests in this repo. The platform spec plans a compiler cache-size gate
for hosts; until such a gate exists here, a claim that such a change is
performance-neutral is **NOT COVERED**, not accepted on reasoning.

---

## 3. Adversarial step — mandatory, not optional

Every finding goes to a **refutation attempt** — a separate pass, preferably a
separate agent that did not see how the finding was formulated. The task is
phrased as "**refute this**", not "check this". **Default is refuted:** no
evidence — the finding does not pass. Evidence = a concrete code fragment, a
concrete input, or a reproduced run. Verdict: `CONFIRMED` (with confidence) /
`REFUTED` (with reason) / `PARTIAL` — real, but not how or where it was
described, with a restatement.

Order of attempts — cheapest first:

1. **Does the described place exist** and look as claimed? No → `REFUTED`.
2. **Is it inside the diff?** Pre-existing outside the boundary →
   `REFUTED (pre-existing)`.
3. **Is there a guard higher up the stack** that makes the scenario unreachable —
   a Zod refinement, a `superRefine`, a caller that validates first?
4. **Is the described input or state possible** — by the types, the schema, the
   caller's guarantees?
5. **Does the finding contradict the repo canon** (`AGENTS.md`, the platform
   spec, the domain criteria) that deliberately prescribes exactly this? Does it
   judge prototype code by a target rule, or the reverse?
6. **Does it reproduce?** A mutation (break → test goes red → restore) or a run
   outweighs reasoning; after a mutation return the tree to a clean state and
   confirm with `git status`.

Separately verify **the synthesiser's own findings**: what the consolidation
added "on its own" was checked by nobody — the classic source of hallucination.
Unanimity among reviewers is not evidence: all passes are the same model, so
agreement can be a shared bias.

---

## 4. Report format

The report is written in Ukrainian. Keep this section order:

```
## Вердикт
ПРИЙНЯТИ / ПРИЙНЯТИ З ЗАУВАЖЕННЯМИ / ПОВЕРНУТИ — одне речення чому.

## Знахідки (confidence ≥ 80)
### [blocker|major|minor] коротка назва — confidence NN
**Де:** файл і символ (або розділ дока)
**Що:** одне-два речення
**Доказ:** фрагмент коду / вхід, за якого ламається / вивід запуску
**Як лагодити:** конкретна дія, не «варто розглянути»

## Відкинуто на порозі
- назва — причина в піврядка (по одному рядку, без деталей)

## Не перевірено
- що лишилось поза межею рев'ю і чому
```

**Return** proven findings with evidence, the below-threshold list and the
explicit limits of the review. Do not invent empty sections. **Do not return:**

- nitpicks — style, naming, formatting not named in `AGENTS.md` or the domain
  criteria; formatting belongs to Prettier and its config, not to a reviewer;
- "it would be worth considering…" — a finding without a concrete action is not
  a finding;
- a retelling of the diff or an inventory of "what I looked at" — defects were
  asked for, not a catalogue;
- pre-existing problems outside the boundary — at most a line in "Не перевірено".

**A lens unavailable in this environment** (no terminal for `git log`, no
database, nothing to run a mutation with) → mark it **NOT COVERED** and name who
should take it; do not imitate the lens with a static guess and do not stay
silent about it. For the same reason **never omit "Не перевірено"**: a review
that does not name its limits reads as a guarantee it never gave.

**Two rules for "how to fix":** propose **one pattern for the domain** — the one
that reduces the domain's components to a single mechanism, not one more special
case; and **no wrappers over wrappers** — the fix works through existing
mechanisms, and an outdated abstraction is named outright with a migration
proposed, not layered over.

---

## 5. Anti-patterns — known ways a review goes wrong

- **Reviewing the executors' reports.** An agent was handed "executor summaries"
  and retold them as verification. Read **the diff and the code**; a report is
  only navigation through them.
- **Trusting green tests.** A test that stays green after the code is broken is
  not a test. The diff added tests and no mutation check was done → that is a
  `major`, not "ok".
- **A guarantee in a docstring ≠ a guarantee in an assertion.** The comment over
  a test claims it holds a mechanism or a number, and the assertions below never
  touch it — the suite stays green after that exact property breaks. The
  docstring promises X → mutate X and watch for red. Guards built on grep or a
  hand-kept registry promise this especially often: grep proves a call exists,
  not that its result goes anywhere.
- **Judging the prototype by the target, or the target by the prototype.** The
  prototype generator not emitting RLS is not a finding; new target-tier code
  copying a prototype convention the platform spec replaced is one.
- **A single-agent review of a large phase.** A large phase accepted after one
  pass tends to have defects that an independent audit finds the next day, and
  the separate fix phase costs far more than the review would have. Large phases
  get several independent passes.

---

## 6. Orchestration

The size of a review should match the cost of a mistake, not habit. Guide:

| What is reviewed | Lenses | Adversarial |
| --- | --- | --- |
| small fix, 1–2 files | 1 (`correctness`) | findings at `blocker`/`major` |
| a plan phase | 3–4 per the table in § «2. Lenses» | every finding |
| work before a branch merge; sensitive code (generated DDL, RLS templates, grants, schema plans, the metamodel's public contracts, tier boundaries) | all relevant + `history` | every finding; two independent skeptics per `blocker` |

Lenses run **in parallel and independently** — they must not see each other's
conclusions, or you get an agreed bias instead of independent opinions. The
adversarial step comes after. The orchestrator consolidates: deduplicates, sorts
by severity, and **itself verifies everything it added on its own**.

In Claude Code this is done by the subagents `code-review` (one lens per call)
and `code-review-verifier` (the adversarial skeptic) — both work from this skill.
