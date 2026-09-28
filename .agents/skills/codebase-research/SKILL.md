---
name: codebase-research
description: Use when you need to locate code in the Simetra repo, find out what a change will affect, check that a plan's or spec's file/line/symbol anchors still match the code, or map an unfamiliar area (metamodel, compiler, generators, CLI, runtime) — before grepping or reading files. Covers the `orient` entry point, the codebase-memory-mcp code layer, and the expected report format. Degrades gracefully without MCP or without the code layer (cloud sessions, fresh clones).
---

# Codebase Research — Simetra

Goal: find the **right places** in the code in the fewest steps and return
**verified facts**, not a retelling.

The model everything follows from:

> **Code — through the code layer. Docs and plan anchors — through `orient`.**
> Both surfaces give you a MAP: where a symbol lives, who calls it, where the
> canon talks about it. **Files give you the TRUTH**: signatures, types,
> behaviour, what a test mocks. A map without the truth is a guess; the truth
> without a map is reading at random.

Write the final report for the owner in Ukrainian (see `AGENTS.md`); keep
identifiers, paths and quotes verbatim.

---

## 1. Two surfaces

**Code layer** — `codebase-memory-mcp` (cbm): an index of symbols with
**separate** edge types (`CALLS` apart from `IMPORTS`). MCP tools
(`search_graph`, `trace_path`, `get_code_snippet`, `query_graph`,
`get_architecture`, `search_code`, `check_index_coverage`, …) — which agents get
them is stated in `CLAUDE.md`. The same engine backs `orient <Symbol>` through
its CLI, so agents without the MCP tools still reach it.

**An empty result is not absence.** Before claiming "there is no such thing"
from cbm tools, call `check_index_coverage` on the paths you rely on: a clean
result means "no gap recorded", not "everything was checked". If coverage is
partial, missing or stale, fall back to `Grep`/`Read` over the named scope and
say in the report what you proved with grep rather than with the graph.

The index deliberately leaves out markdown, build output and the agent harness
(`.cbmignore`): docs are the job of `orient --map`, and `.agents/` scripts are
read directly.

**`orient`** — this skill's agent-neutral script, full path from the repo root:

```bash
.agents/skills/codebase-research/scripts/orient <args>
```

It works from any directory (it resolves the repo root itself) and in any agent.

| Question | Tool |
| --- | --- |
| **Topic in plain words, names still unknown** ("figure out how X works") | `orient --map "<theme>"` |
| Where does a symbol live? Who **actually calls** it (no transitive barrels)? | `orient <Symbol> [<Symbol>…]` |
| Do a plan's anchors (paths, `:lines`, symbols) still match the code? | `orient --plan <file.md>` |
| **What the code does**: signatures, type fields, behaviour, test mocks | **`Read` the file** — no surface knows this |
| No terminal available | the editor's find-references (language server) — the nearest thing to the code layer |

`orient` flags: `--depth N` (depth of the inbound call walk, default 1 — direct
callers only; N>1 is transitive, grouped by hop), `--max N` (rows printed per
symbol and per hop). Run `orient --help` for the environment variables
(cbm project override, lemma venv).

🔴 **Degradation boundary — the main rule: fall back to lexical search ONLY
where lexical search is honest, never where it lies.**

- `<Symbol>` without the code layer **does not silently fall back to grep** —
  it exits non-zero and says the code layer is unavailable. Reason: on "who
  calls X" grep systematically lies through barrel files — it counts a
  transitive re-export the same as a real call, so "consumers" come out
  inflated.
- `--plan` degrades softly: the filesystem checks paths and line numbers
  (always works); without the code layer `rg` checks symbols by DECLARATION
  only, and the report names exactly what was not verified (types, usages,
  renames).
- `--map` does not depend on the code layer at all — BM25 over the doc corpus
  works the same everywhere, cloud sessions included.

**`--map` is the entry point for the phase where a task really starts.** A task
starts with a topic in plain words, not a symbol name; the other modes need as
input the result of the very reconnaissance you are about to do. `--map` takes
**only the theme** — extra positional words are ignored.

🔴 Next to each path the output shows the **normalisation level** — `lemmas`
or `raw tokens`. On raw tokens the search does not see Ukrainian word forms
(`проведення` will not match `проведенням`), so hits are worse. It is a working
mode, not a failure. To enable lemmas, create a venv with `pymorphy3` and
`pymorphy3-dicts-uk` — the exact commands are printed by `--map` when lemmas are
missing; point `ORIENT_DOC_VENV` at an existing venv to reuse it.

**The corpus is the canon:** `AGENTS.md`, root `README.md`, top-level
`docs/*.md` (BRD, ROADMAP), `docs/superpowers/specs/`, `docs/research/`, every
skill's `SKILL.md` and `references/` (in `.agents/skills/` and in packages'
`skills/`), package and app READMEs. Out of the corpus: `CLAUDE.md` (already in
every Claude session's context), `docs/superpowers/plans/**` (execution plans,
not canon), skills' `assets/**` (code templates, not prose).

**Consequence for you: phrase a theme, not keywords.** A sentence in your own
words beats a bag of terms — the ranking sees how rare a word is in the corpus
and already discounts common ones. **The corpus is bilingual:** internal docs
are Ukrainian, the harness and READMEs are English, and there is no
cross-language matching. When you know both terms, put both in the theme
(`--map "posting register проведення регістр"`).

Two known limits of the cbm engine to keep in mind when reading
`orient <Symbol>`: several calls of a symbol from the same function collapse
into one edge (the graph shows fewer calls than the source has); an aliased
import (`import { X as Y }`) may drop out of "who imports" — double-check such
questions with grep.

---

## 2. Research protocol

0. **Vocabulary.** If the topic is known only in plain words —
   `orient --map "<theme>"`. Without this step grep is impossible in principle:
   to grep you must already know the word, and that is exactly what you lack.
   The output is the ranked canon where the topic is already written up. For
   Simetra, the platform spec is where target concepts (tiers T0–T6, metamodel,
   compiler, schema engine) are named; the current packages are a prototype
   whose fate the platform spec decides — do not mistake prototype code for the
   target design.
1. **Map.** `orient <Symbol>` on the key symbols (names come from the docs
   `--map` just gave you, or from the code), or `orient --plan` on the task
   file. Do not grep blind before this step: the code layer tells **real
   calls** apart from transitive barrel imports, which `grep` cannot.
2. **Truth.** Read **only** what the map pointed to, plus the places where the
   question is behavioural (types, generated SQL, library behaviour, test
   fixtures and mocks). The code layer knows nothing about behaviour.
3. **Check.** If the code layer contradicts what the plan or the requester
   expected, do not "fill in the gaps": that is drift of the **plan**, not of
   the tool. Record the discrepancy as an explicit line in the report (§3) —
   the scope decision belongs to the task owner, not the researcher.
4. **Report.** Format — §3.

A sign you are overdoing it: reading a file to **find** where something lives.
`orient` finds; reading is for **content**.

---

## 3. Report format — a delta, not a map

Write the report in Ukrainian. Return:

- **Answers** to the questions asked — one paragraph each, with `file:line`.
- **Discrepancies** with what the requester expected (plan, spec, assumptions
  in the request) — a separate list, each with evidence: what is written →
  what actually is → where it shows.
- **Anchors to read** next: `path:line` + one sentence on what is there.
- **Open questions** that need the owner's decision.

Do not return:

- file dumps and long code blocks — quote at most ~10 lines, and only when the
  quote itself is the evidence;
- an inventory of "everything I saw" — the requester asked for an answer, not a
  catalogue;
- a retelling of what the plan already says.

Why so strict: a researcher's report is pasted into other agents' prompts, and
every extra kilobyte is multiplied by their number. The executor re-reads the
files anyway, so a dump saves nobody anything.

---

## 4. Anti-patterns

- **Trusting the code layer without checking the disk.** `orient` and the code
  layer give a map, not the truth: they do not know text, types or behaviour.
  Record a mismatch with the code or plan explicitly (§2 step 3); do not
  quietly "correct" it.
- **Reading a file to locate something.** One `Read` costs thousands of tokens;
  `orient` is an order of magnitude cheaper and shows more.
- **Copying a recon dump into every executor's prompt.** It multiplies by the
  number of agents and does not spare them from reading the files.
- **Searching by a plan's line number.** Line numbers drift, even during the
  work itself. Search by unique text; a number is only a hint.

---

## 5. When to delegate to a subagent

A pinpoint question ("where does X live", "what does a change touch", "does the
plan still match") — do it **yourself**: `orient` is cheaper and faster than a
subagent round-trip.

A broad multi-file investigation of unknown size ("figure out how area X works
and what one needs to know to do Y") — delegate. The point of delegation is
**context isolation**: the subagent reads twenty files on its side and returns
a delta, and the main session stays lean. In Claude Code the
`codebase-research` subagent works by exactly this skill.
