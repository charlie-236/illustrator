# ROLES.md — How the roles compose

This project uses multiple specialized roles instead of asking one AI
to do everything. Each role has a tightly-scoped responsibility, a
defined information access pattern, and a well-known invocation
trigger. This document is the index — each role has its own brief
(`QA.md`, `HISTORIAN.md`, `DIAGNOSTICIAN.md`) and the Architect /
Operator / Reviewer have `ARCHITECT.md`, `OPERATOR.md` (or
`OPERATOR_cowork.md`), and `REVIEWER.md` respectively. The Claude
Code CLI guardrails are in `CLAUDE_CODE.md`.

## Two orchestration stacks, one workflow

The project supports two parallel orchestration stacks:

- **VS Code stack** — single Operator chat using Microsoft Playwright
  MCP to drive Copilot M365 (Claude roles) and Gemini (Gemini roles)
  tabs. Phase C builds happen synchronously inside the same chat
  (the Operator switches to a Claude Code hat). See
  `agents/OPERATOR.md` and `agents/USER_BOOTSTRAP.md`.
- **Cowork stack** — Cowork desktop agent using Claude in Chrome MCP
  to drive claude.ai (Claude roles) and gemini.google.com (Gemini
  roles) tabs. Phase C builds run asynchronously via
  `run-next-batch.sh`, launching a separate Claude Code process.
  See `agents/OPERATOR_cowork.md` and
  `agents/USER_BOOTSTRAP_cowork.md`.

Everything else in this document — the role inventory, the
collaboration loop, the verdict semantics, the spawn patterns,
the checkpoint triggers — is **the same in both stacks**. The
shared role briefs (`ARCHITECT.md`, `REVIEWER.md`, `QA.md`,
`HISTORIAN.md`, `DIAGNOSTICIAN.md`) apply verbatim to both.

### Operator must self-validate stack before reading its brief

The Operator role has two stack-specific brief files
(`agents/OPERATOR.md` for VS Code, `agents/OPERATOR_cowork.md` for
Cowork). Reading the wrong one routes the Operator into the wrong
Phase C workflow. Both files open with a "STACK VALIDATION" header
listing the signals (system prompt, tool surface, browser MCP,
Phase C synchrony) that confirm which stack the Operator is running
in. The Operator must read that header and confirm the match before
reading the rest of its brief. If the signals are ambiguous, the
Operator halts and asks the User explicitly. This validation is
unconditional, regardless of which filename the User mentioned in
the bootstrap message.

## Where the role briefs live

All role briefs are in the `agents/` folder at the repo root:

```
agents/ARCHITECT.md             (stack-agnostic)
agents/ROLES.md                 (this file — stack-agnostic)
agents/OPERATOR.md              (VS Code variant)
agents/OPERATOR_cowork.md       (Cowork variant)
agents/REVIEWER.md              (stack-agnostic)
agents/QA.md                    (stack-agnostic)
agents/HISTORIAN.md             (stack-agnostic)
agents/DIAGNOSTICIAN.md         (stack-agnostic)
agents/USER_BOOTSTRAP.md        (VS Code variant)
agents/USER_BOOTSTRAP_cowork.md (Cowork variant)
agents/CLAUDE_CODE.md           (CLI guardrails — read by Claude Code at the start of every Build)
```

From this point forward, references to a brief by bare name (e.g.
"see QA.md") mean the file in `agents/`. Pointers to stack-specific
docs use the explicit name (e.g. `OPERATOR_cowork.md`).

How the role-side Claudes (Architect, QA, Historian, Diagnostician)
read these briefs and other repo files depends on the stack:

- **VS Code stack:** the Operator attaches a fresh `repomix` archive
  of the repo to each role's Copilot M365 chat at bootstrap. The
  role searches within the attached archive.
- **Cowork stack:** the repo is synced into the "Illustrator"
  claude.ai project. Roles use `project_knowledge_search` over the
  synced repo.

The workflow ("short keyword queries, don't speculate, search first")
is identical in both stacks; only the tool surface changes. Each
role brief documents both options in its "Reading the repo" section.

## The principle

Different decisions need different information. Asking one AI to
handle architecture, test design, and root-cause diagnosis means
context bloat (every chat carries everything), self-grading (the
Architect can't objectively review its own prompts), and degraded
quality as conversations age.

The roles below split the work so each chat stays focused, fresh,
and aligned to a single decision type.

## The Operator is an implementer, not a designer

A general principle that applies to **both** stacks, with the
strongest emphasis in the Cowork variant where the failure has been
observed in practice on the related long-form-writing project:

The Operator's job is to **execute** the decisions other roles make,
not to second-guess them. The Operator does not rewrite prompts,
expand scope during builds, or opine on PR quality. The full
failure-mode history and the canonical statement live in
`agents/OPERATOR.md` (VS Code) and `agents/OPERATOR_cowork.md`
(Cowork) under the section of that name.

## The roles

### Architect (Claude in its own tab — Copilot M365 in VS Code, claude.ai in Cowork)
- Has: full project context, conversation history, all docs read at
  bootstrap, evolving understanding from prior rounds, and repo
  access (via repomix archive in VS Code, `project_knowledge_search`
  in Cowork)
- Doesn't have: the actual diff bytes (only what Operator pastes),
  the filesystem, ability to run code
- Strong at: diagnosing recurring issues, designing fixes, reading
  PR diffs the Operator pastes, holding the long arc of the project
- Brief: `agents/ARCHITECT.md`

### Operator (VS Code chat or Cowork chat)
- Has: filesystem, git, terminal, browser tabs (via Playwright MCP
  in VS Code, Claude in Chrome MCP in Cowork), the actual diff
  bytes, build/test execution
- VS Code variant additionally: writes Phase C code in the same chat
- Cowork variant additionally: runs `run-next-batch.sh` which spawns
  a separate Claude Code process
- Doesn't have: persistent context across sessions unless docs
  preserve it
- Brief: `agents/OPERATOR.md` or `agents/OPERATOR_cowork.md`

### Reviewer (Gemini Pro in its own browser tab)
- Has: whatever Operator pastes into the chat
- Doesn't have: filesystem, codebase, ability to run anything,
  project knowledge or repomix archive (the Reviewer is on Gemini)
- Strong at: prompt-clarity audits, architectural sanity, catching
  ambiguities and undefined references before Claude Code sees them
- Weak at: code review on snippets without context, anything
  requiring filesystem inspection
- Brief: `agents/REVIEWER.md`

### QA (Claude in a fresh chat per item)
- Has: the proposed prompt, ARCHITECT.md, the diagnostic file
  inventory, and repo access (via repomix archive in VS Code,
  `project_knowledge_search` in Cowork)
- Doesn't have: filesystem during design phase; can request specific
  files from Operator if a search isn't enough
- Strong at: designing verification gates (pre-merge A1–An,
  post-merge B1–Bn, negative C1–Cn), identifying what would prove
  the fix works, adversarial test cases
- Brief: `agents/QA.md`

### Historian (Claude in a fresh chat per checkpoint)
- Has: read access to everything in the repo and decisions log
  (via repomix archive in VS Code, `project_knowledge_search` in
  Cowork), plus whatever the Operator pastes from `gh pr list`,
  recent SESSION-SUMMARYs, etc.
- Doesn't have: opinions about ongoing work; produces only summaries
- Strong at: synthesizing project state into a clean snapshot,
  identifying what's resolved vs. open, updating the canonical docs
- Brief: `agents/HISTORIAN.md`

### Diagnostician (Claude in a fresh chat per investigation)
- Has: the specific diagnostic packet Operator assembles (relevant
  files from the diagnostic inventory, DB rows queried, the symptom
  description), plus repo access for verifying code paths
- Doesn't have: full project context (Operator scopes it to the
  investigation)
- Strong at: ground-truth verification (code path + DB rows + server
  logs), root cause analysis, distinguishing model error from
  configuration error, pushing back on misdescribed symptoms
- Brief: `agents/DIAGNOSTICIAN.md`

### Output Critic (not currently invoked — slot reserved)

The long-form-writing project includes a "Story Editor" role
(Gemini Pro) for evaluating generated prose on a per-chapter basis.
The illustrator project does not currently invoke an analogous
role. The kinds of outputs that would be candidates for AI
evaluation here are:

- LLM-generated polished prompts (the "Polish" button's output)
- LLM-generated storyboard scene descriptions and per-scene
  positive prompts
- LLM-generated chat replies (the Ghost Writing chat surface)

Image and video quality assessment is currently the User's by-eye
call, not an AI evaluator's. If any of the LLM-text outputs above
becomes a per-PR concern serious enough to warrant a fresh-chat
evaluator, this role can be introduced following the Story Editor
pattern — opened per evaluation, fed the relevant rubric and the
artifact, returns scored verdicts.

## The collaboration loop

Standard cycle for every backlog item:

```
DIAGNOSE → DESIGN → REVIEW DESIGN → QA TEST DESIGN → BUILD → PR REVIEW → MERGE → TEST → EVALUATE
```

| Stage | Architect | Operator | Reviewer | QA |
|---|---|---|---|---|
| Diagnose | leads | assists | — | — |
| Design | leads | — | — | — |
| Review design | engages | routes | reviews | — |
| QA test design | engages | routes | — | designs |
| Build | (writes prompt) | runs Claude Code (Cowork) or writes code itself (VS Code) | — | — |
| PR review | reviews diff | reports facts | — | — |
| Merge | — | executes | — | — |
| Test | (writes plan, runs from QA design) | executes | — | observes |
| Evaluate | own eval | collates | — | — |

**Key rules:**
- Every Design Review gets both Architect and Reviewer opinions
- Every Build is preceded by QA's test design
- Every PR Review is Architect-only; Operator reports facts, Reviewer
  is not invoked (PR review on code requires filesystem access that
  Reviewer doesn't have)
- Reviewer can be invoked outside Design Review on Architect's request
  for "I'm uncertain about this, second opinion?"
- Operator can spawn Diagnostician on symptom at any time
- Historian fires at phase boundaries or on context-degradation signals

## Spawn patterns

Different roles have different lifecycle patterns. Operator orchestrates:

**Long-running chats** (stay open through a phase or session):
- Architect — one chat per phase. New chat at phase boundaries via
  Historian snapshot.
- Operator — one chat per session.
- Reviewer — one chat per session, reused across items in that session.

**Per-item chats** (open at start, close at end):
- QA — fresh chat for each backlog item. Closes when verification
  gates are signed off.

**Per-event chats** (open on trigger, close after output):
- Historian — opened at checkpoint trigger; produces snapshot; closes.
- Diagnostician — opened on symptom; produces root cause; closes.

## Checkpoint triggers

The Historian is invoked when any of these fire:

1. **Phase boundary.** Each ROADMAP phase transition (Phase 1 → 2,
   Phase 2 → 3, etc.).
2. **Token-budget signal.** Operator tracks rough message counts in
   the Architect chat. At ~50 messages or visibly thick context,
   suggest a checkpoint.
3. **Architect self-flag.** The Architect notices its own context
   is getting muddy and asks for a checkpoint via `## Open issues`
   block.
4. **User-initiated.** User tells the Operator "checkpoint now."

## Cost rationale

The multi-role workflow often *decreases* total spend because the
Architect chat doesn't have to carry test design and root-cause
work simultaneously.

The expensive role is Historian, because it reads a lot to produce
a fresh snapshot. But Historian fires rarely (3–5 times across the
whole project) and pays for itself by enabling cleaner Architect
chats post-checkpoint.

## Reading order for someone joining mid-project

If a new role is being bootstrapped and needs to come up to speed:

1. `agents/ARCHITECT.md` (project context)
2. `agents/ROLES.md` (this file)
3. Their specific role brief (`agents/QA.md`, `agents/DIAGNOSTICIAN.md`,
   etc.), or `agents/OPERATOR.md` / `agents/OPERATOR_cowork.md` if
   spinning up the Operator
4. The most recent Historian snapshot if one exists
5. The current `BACKLOG.md`

That's enough to participate. No need to read the full conversation
history of other roles.
