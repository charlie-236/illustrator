# MIGRATION-NOTES.md — apply these changes to the illustrator repo

This file is a one-shot checklist for migrating the illustrator
repo from the early-days single-role layout to the multi-role
workflow. Once you've worked through it, **delete this file**
(or move it to `decisions/migration-2026-05-port.md` for the
historical record).

The new doc tree the port produces:

```
illustrator/
├── CLAUDE.md                      ← keep (load-bearing; Claude Code reads it)
├── BACKLOG.md                     ← keep (queued items)
├── ROADMAP.md                     ← NEW (phased intent)
├── agents/                        ← NEW (all role briefs live here)
│   ├── ARCHITECT.md
│   ├── ROLES.md
│   ├── OPERATOR.md
│   ├── OPERATOR_cowork.md
│   ├── REVIEWER.md
│   ├── QA.md
│   ├── HISTORIAN.md
│   ├── DIAGNOSTICIAN.md
│   ├── USER_BOOTSTRAP.md
│   ├── USER_BOOTSTRAP_cowork.md
│   └── CLAUDE_CODE.md
├── tools/                         ← NEW (browser MCP helpers)
│   ├── browser_helpers.md
│   └── browser_helpers_cowork.md
├── tasks/                         ← RENAMED from prompts/
│   └── *.md
├── decisions/                     ← NEW
│   └── (initially empty)
├── runs/                          ← NEW (gitignored)
│   └── (initially empty)
└── (everything else unchanged)
```

## Step 1 — Drop the new files into place

Copy the entire contents of this output bundle into the illustrator
repo root. Result:

- `agents/` populated with 11 role briefs
- `tools/` populated with 2 browser helper docs
- `ROADMAP.md` at repo root
- `MIGRATION-NOTES.md` at repo root (this file — delete when done)

## Step 2 — Rename prompts/ → tasks/

```
cd <illustrator-repo-root>
git mv prompts tasks
```

Then update every reference inside the existing prompt files
(if any reference each other or reference `prompts/` in their
text) — `grep -rn 'prompts/' tasks/` to find them.

## Step 3 — Update run-next-batch.sh

The wrapper script currently reads from `prompts/`. Change every
reference to `tasks/`:

```
sed -i 's|prompts/|tasks/|g' run-next-batch.sh
```

Then read the script end-to-end and confirm nothing weird happened
(e.g., a comment that mentioned "task prompts" wasn't supposed to
become "task tasks"). The replacement should land on:

- The path it reads to find the prompt file
- Any greps that look for `see prompts/`
- Any echo'd help text that mentions the folder

The script's own filename stays `run-next-batch.sh` — that's the
illustrator's name (LFW uses `run-next-batch-long-form-writing.sh`).
The role docs in this port reference your script by its actual
name throughout.

## Step 4 — Update BACKLOG.md line references

Every line currently of the form `... — see prompts/foo.md` needs
to become `... — see tasks/foo.md`:

```
sed -i 's|see prompts/|see tasks/|g' BACKLOG.md
```

Run `grep 'prompts/' BACKLOG.md` afterwards to confirm zero
matches.

## Step 5 — Update CLAUDE.md if it references prompts/

```
grep -n 'prompts/' CLAUDE.md
```

If any results, change them to `tasks/`.

## Step 6 — Delete the old top-level role files

These are now superseded by `agents/`:

```
rm AGENTS.md ARCHITECT.md COWORK.md DEBUGGER.md QA.md
```

The replacements:
- `AGENTS.md` → `agents/CLAUDE_CODE.md` (refocused around Claude
  Code CLI guardrails; the workflow intro that used to live in
  the top-level AGENTS.md is now distributed across `agents/ROLES.md`
  and the two `OPERATOR*.md` files)
- `ARCHITECT.md` → `agents/ARCHITECT.md` (rewritten following the
  LFW pattern with full hard rules, verdict vocabulary, fix-forward
  defaults, diagnostic file inventory)
- `COWORK.md` → split across `agents/OPERATOR_cowork.md`,
  `agents/USER_BOOTSTRAP_cowork.md`, and
  `tools/browser_helpers_cowork.md`. The keychain limitation note
  is removed — it was stale.
- `DEBUGGER.md` → `agents/DIAGNOSTICIAN.md` (rename + adopt the
  LFW ground-truth methodology, preserves the illustrator-specific
  debugging knowledge: mawk vs gawk, Prisma logs, tunnel check,
  HTTP 500 disk-avoidance assertion, chain-head wedge, refresh
  survivability)
- `QA.md` → `agents/QA.md` (expanded to include pre-merge A-gate
  design before Build, in addition to post-merge PR review)

`CLAUDE.md` and `BACKLOG.md` stay at top level — both are
referenced by Claude Code from the repo root.

## Step 7 — Create the empty decisions/ and runs/ folders

```
mkdir -p decisions runs
touch decisions/.gitkeep runs/.gitkeep
```

Add `runs/` to `.gitignore` if not already there (the script log
files and PID sentinels under `runs/` should not be committed):

```
echo 'runs/' >> .gitignore
```

`decisions/` IS committed — it holds SESSION-STALL,
SESSION-SUMMARY, Historian snapshots, and overrule logs.

## Step 8 — Verify nothing else references prompts/

```
grep -rn 'prompts/' . \
  --exclude-dir=node_modules \
  --exclude-dir=.next \
  --exclude-dir=.git
```

Expected output: nothing. If anything's left, fix it.

## Step 9 — Commit the migration

```
git checkout -b batch/migrate-multi-role-workflow
git add -A
git commit -m "Migrate to multi-role agent workflow"
git push -u origin batch/migrate-multi-role-workflow
gh pr create --base main --head batch/migrate-multi-role-workflow \
  --title "Migrate to multi-role agent workflow" \
  --body "Port LFW multi-role pattern. Renames prompts/ to tasks/,
adds agents/ and tools/ folders, introduces ROADMAP.md and
decisions/, replaces AGENTS.md / ARCHITECT.md / COWORK.md /
DEBUGGER.md / QA.md with the agents/ equivalents."
```

Merge it manually (no need to drive this through the loop you're
setting up).

## Step 10 — Verify CLAUDE.md still says what you want

CLAUDE.md is referenced as load-bearing by every role brief. Open
it and check:

- The Disk-Avoidance Constraint is documented
- The IMAGE_OUTPUT_DIR rule is documented
- The forbidden node class_types list is current
- It points readers to `agents/` for role briefs (add a one-liner
  if needed: "For agent role briefs, see `agents/`. The workflow
  is described in `agents/ROLES.md`.")

## Step 11 — Sanity check on each stack

Once merged to main, do a one-item shakedown on each stack to
catch anything broken before walking away:

**VS Code stack:**
1. Pick a small queued item from BACKLOG (or write one quickly —
   a doc-only or one-file change).
2. Generate a fresh repomix archive.
3. Open Architect + Reviewer tabs per `USER_BOOTSTRAP.md`.
4. Paste the bootstrap.
5. Confirm the Operator confirms back the right tiers + that
   browser_helpers.md's selectors actually resolve (not just stub
   text) — this is the moment you'd discover any drifted
   selectors needing a probe pass.
6. Watch one full A → E loop go through.

**Cowork stack:**
1. Same item, or a new small one.
2. Mount the four directories per `USER_BOOTSTRAP_cowork.md`.
3. Trigger a project knowledge refresh.
4. Paste the bootstrap.
5. Confirm the Operator confirms back tiers + mounts + gh auth.
6. Watch one full A → E loop, paying attention to the async Phase
   C polling (PR appearance, log heartbeat).

If either stack stalls on something that isn't a one-off (e.g.,
selector drift, project knowledge sync timing, claude-auth-bridge
path issues), file the fix as a follow-up batch and run the
shakedown again. Don't walk away on the strength of a half-tested
loop.

## Step 12 — Delete this file

```
rm MIGRATION-NOTES.md
git add -A && git commit -m "Remove migration notes (port complete)"
```

Or move to `decisions/migration-2026-05-port.md` for the historical
record. Either is fine.

---

## Notes on choices made during the port

- **Story Editor role dropped.** LFW's Story Editor evaluates
  generated prose; the illustrator's primary outputs are images
  and videos, and image quality is currently your by-eye call.
  An "Output Critic" slot is mentioned in `agents/ROLES.md` for
  later use if you want LLM evaluation of polished prompts or
  storyboard scenes.
- **AGENTS.md renamed to CLAUDE_CODE.md (under agents/).** The
  Claude Code CLI guardrails are a distinct concept from the
  multi-role workflow; this name makes that explicit.
- **CLAUDE.md stays top-level.** Claude Code reads it from the
  repo root and every role brief points back to it. Moving it
  into `agents/` would require updating Claude Code's read-order
  expectations.
- **COWORK.md's keychain-limitation note is removed.** The new
  `OPERATOR_cowork.md` points at `~/claude-auth-bridge` as the
  single source of auth (Claude Code, gh, git, SSH keys), and
  treats the bridge's `README.md` as the canonical reference.
- **`prompts/` → `tasks/`.** Aligns vocabulary with LFW.
- **`run-next-batch.sh` keeps its illustrator-specific name** —
  no need to rename it.
- **Header vocabulary adopted** (`## Architect → Operator`,
  `PROCEED/REVISE/STOP`, `MERGE/REQUEST_CHANGES/CLOSE`,
  `PASS/PASS_WITH_RESERVATIONS/FAIL`). Cheap to adopt and makes
  the workflow identical across both stacks.
- **`~/gh-credentials` pattern dropped.** The auth-bridge handles
  gh / git push directly, so the older "separate gh-credentials
  mount with `GH_CONFIG_DIR` prefix" pattern from the early
  illustrator COWORK.md is gone. If the bridge's README contradicts
  this and your bridge is set up the old way, follow the README —
  this doc is wrong.
- **Cowork Phase C uses the SSH-localhost-detached pattern**,
  not direct `nohup ./run-next-batch.sh &`. The Cowork bash tool
  is bwrap-sandboxed with `--die-with-parent --unshare-pid` and a
  45s timeout; the old direct-launch pattern dies before Claude
  Code finishes its session-startup phase. SSH to `127.0.0.1:22`
  puts the worker outside the bwrap process tree where `nohup`
  actually survives. This is documented in
  `agents/OPERATOR_cowork.md` Phase C with the full procedure
  including authoritative liveness via `ps`, the never-relaunch-
  without-scan warning, pre-launch cleanup, and the Path C
  sub-phase envelope.
- **VS Code stack routes npm via SSH to mint-main** (`192.168.1.206`).
  PC1 (where the VS Code Operator runs) isn't on Tailscale to the
  Azure A100 VM, so `npm run build` and `npm run dev` MUST happen
  on mint-main where the database lives and the SSH tunnel to the
  A100 terminates. The static disk-avoidance greps and lint stay
  local on PC1. This is documented in `agents/OPERATOR.md`
  "Two-machine topology" section and Phase C steps 5–7.
