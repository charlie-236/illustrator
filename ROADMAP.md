# ROADMAP.md

Two-tier intent → queued. **Intent** lives here as an unstructured
list of ideas, problems, and directions the project may take.
**Queued tasks** live in `BACKLOG.md` as `[ ]` items with task prompt
files in `tasks/`. The promotion handshake between the two is
documented at the bottom.

This file is the User's, but the multi-role workflow reads it too:
the Architect consults it when designing, the Historian updates it
at phase boundaries, and the Operator can run a Path 2 promotion
handshake when BACKLOG is empty.

---

## Phase 1 — Stand up the multi-role workflow (current)

The objective of this phase is to migrate the illustrator from a
single-Architect, manual-Charlie workflow into the multi-role
autonomous pattern from the long-form-writing project. Phase 1
ends when the loop has cleanly run several real backlog items
end-to-end on both stacks.

**Sub-items:**
- *Migrate role docs from top-level into `agents/` (this file's
  parent batch).*
- *Add `tasks/` folder (rename of `prompts/`), `decisions/` folder,
  ROADMAP.md, and the two stacks' `*_cowork.md` companion files.*
- *Update `run-next-batch.sh` to read from `tasks/` instead of
  `prompts/`.*
- *Run a smoke item end-to-end on each stack:*
  - *VS Code stack: pick one queued item, drive Architect →
    Reviewer → QA → synchronous Phase C → PR Review → merge.*
  - *Cowork stack: same flow, async Phase C via
    `run-next-batch.sh` subprocess.*
- *Run the first Historian checkpoint after the third real item
  merges (or after the third doc-pass batch, whichever comes
  first).*

When Phase 1 closes, the Historian writes the first real snapshot
into `agents/ARCHITECT.md`'s "Merged PRs" section, and Phase 2
opens.

## Phase 2+ — Substantive work

(Intentionally empty at the time of this file's creation. The User
will populate this section as ideas accumulate. The promotion
handshake below describes how items move from intent here to
queued tasks in `BACKLOG.md`.)

Candidate themes that may seed Phase 2 items, listed for context
only (not commitments):
- Storyboard generation quality / consistency
- Generation queue durability and crash recovery
- LoRA / checkpoint management UX (Civitai ingest workflow,
  download status surfacing)
- Tablet UI polish on existing surfaces
- ComfyUI workflow library — making custom workflows easier to
  test without losing disk-avoidance guarantees

When a theme produces concrete enough work to write a task prompt,
the User (or the Architect, via the Path 2 promotion handshake)
moves it from a Phase 2+ intent here into a `[ ]` line in
`BACKLOG.md` plus a `tasks/<short-name>.md` file.

---

## Backlog format reminder

In `BACKLOG.md`:

```
- [ ] One-sentence description — see tasks/short-name.md
```

Status legend:
- `[ ]` queued, task prompt exists
- `[~]` in flight, PR opened
- `[x]` merged

`ROADMAP.md` (this file) holds intent that hasn't been turned into
a task prompt yet. Intent items use italicized bullets, no
checkbox.

---

## Promotion handshake — Path 1 and Path 2

When something moves from intent (here) to queued (in `BACKLOG.md`
+ `tasks/`), it goes through one of two paths.

### Path 1 — User-driven (default)

The User notices something on this roadmap they want to do next,
talks it through with the Architect in a regular session, the
Architect produces a task prompt, the User stages it. This is the
normal workflow.

### Path 2 — Operator-initiated when BACKLOG is empty

The Operator can promote a ROADMAP intent into a queued task when:

- `BACKLOG.md` has no `[ ]` items
- The User has not explicitly halted the autonomous loop
- The next intent item in ROADMAP is concrete enough to design
  against without further User input

The handshake:

1. **Operator** posts a Path 2 promotion proposal to the Architect:

   ```
   ## Operator → Architect (Path 2 promotion)

   BACKLOG.md is empty. The next intent item in ROADMAP.md is:

   > <verbatim quote of the ROADMAP entry>

   Please draft a task prompt for this intent, OR respond with
   STOP — needs human design input if the intent isn't concrete
   enough to design against without me.

   Treat your response as Phase A (Design). Reviewer is NOT
   invoked for this handshake — its sole purpose is to confirm
   the intent is concrete enough to enter the standard loop.
   ```

2. **Architect** responds with one of:
   - A task prompt draft, formatted the same way as any Phase A
     output. The Operator then routes this to Reviewer at Phase A
     of the standard loop, as if it were a normal Architect-
     initiated design proposal.
   - `STOP — needs human design input`, with one paragraph on
     what's unclear. The Operator writes a SESSION-SUMMARY noting
     the User must intervene, then exits.

3. If the Architect produces a draft, **the rest of the loop
   proceeds normally**: Reviewer → QA → Build → PR Review →
   Merge. The only difference from Path 1 is that the User wasn't
   in the loop for the initial intent-to-design step.

Path 2 is conservative by design: the Architect can always
decline by saying "needs human design input." When in doubt,
decline. The cost of waiting for the User is low; the cost of
building the wrong thing autonomously is high.

---

## Updating this file

- The User edits this file freely; ideas go here in any shape.
- The Historian updates the phase headers at checkpoint boundaries
  and may promote completed phases to "Completed" sections.
- The Architect doesn't usually edit this file — it consults it
  but writes new work into `tasks/` and `BACKLOG.md` instead.
- The Operator doesn't edit this file (except possibly via a
  Historian-staged commit at a checkpoint).
