# USER_BOOTSTRAP_cowork.md — Your 5-minute checklist (Cowork stack)

This is **your** checklist — Charlie's — for starting an autonomous
session on the Cowork stack. The Operator does the work; you spend
~5 minutes on setup, paste a bootstrap message, and walk away.

If you're on the VS Code stack, read `USER_BOOTSTRAP.md` instead.

## Prereqs (one-time, not per-session)

- Cowork desktop app installed.
- Claude in Chrome MCP enabled in your Cowork session.
- The "Illustrator" project exists on claude.ai with the illustrator
  repo synced as project knowledge (Settings → Connect to GitHub).
- `~/claude-auth-bridge/` exists on the host, contains a working
  Claude Code auth state, and has a `README.md` documenting the
  invocation pattern. This is what lets the Cowork sandbox run
  Claude Code without keychain access.
- `~/.local/share/claude/versions/<X.Y.Z>/` contains the Claude Code
  binary.
- `~/gh-credentials/` exists on the host with a working copy of
  `~/.config/gh` (run `cp -r ~/.config/gh ~/gh-credentials` after
  any `gh auth login`).
- `gh auth status` reports a valid token (use the GitHub account
  that has write access to the illustrator repo).

## Per-session setup

### Step 1 — Open the two persistent role tabs

These need to be open in the browser the Cowork agent will drive.

1. **Architect tab** — claude.ai, fresh conversation **inside the
   Illustrator project** (so `project_knowledge_search` works
   against the synced repo). Model picker: Opus 4.7 Adaptive,
   extended thinking ON.
2. **Reviewer tab** — gemini.google.com, fresh chat, Pro selected
   in the mode picker (the picker label should read "Pro", not
   "Flash" or "Fast"). Use the Gemini account you've been using
   for this project.

Per-event tabs (QA, Historian, Diagnostician) are opened by the
Operator on demand inside the Illustrator project and don't need to
exist at session start.

### Step 2 — Verify tier on each tab visually

Quick visual check before you hand off:

- Architect tab: model selector shows "Opus 4.7 Adaptive". The
  extended-thinking toggle is on (the button is in the active
  state).
- Reviewer tab: mode picker shows "Pro". Not "Flash", not "Fast",
  not "2.5 Flash".

If either is wrong, fix it before you walk away. The Operator does
a programmatic re-verify at bootstrap, but a visual check now saves
a round trip.

### Step 3 — Refresh project knowledge

In the Illustrator project's settings on claude.ai, trigger a manual
repo sync refresh so `project_knowledge_search` reflects the current
main. This is the single most important pre-session action — stale
project knowledge makes every role-side Claude work against the
wrong codebase.

### Step 4 — Paste the bootstrap message to the Cowork chat

Open a new Cowork chat. Paste this bootstrap, adapting the bracketed
bits:

```
You are the Operator for the illustrator project on the Cowork
stack. Read agents/OPERATOR_cowork.md as your full brief — the
STACK VALIDATION header at the top confirms you should be reading
this file, not OPERATOR.md.

Before doing anything else, mount these directories via
request_cowork_directory:
1. ~/illustrator (the repo)
2. ~/claude-auth-bridge (Claude Code auth state; read the
   README.md there for the invocation pattern)
3. ~/.local/share/claude (Claude Code binary location)
4. ~/gh-credentials (gh CLI auth)

Current chain head: <main, OR a batch/... branch if mid-chain>
Current phase: <Phase 1 — multi-role workflow standup, OR whatever
                ROADMAP.md says>
Backlog state: see BACKLOG.md (first [ ] line is the next item)

Browser tabs already open in the Claude-in-Chrome browser:
1. Architect tab (claude.ai, in the Illustrator project, Opus 4.7
   Adaptive + extended thinking)
2. Reviewer tab (gemini.google.com, Pro)

You will spawn additional claude.ai tabs (inside the Illustrator
project, for project_knowledge_search access) for QA, Historian,
and Diagnostician as needed. Use the model-check helpers in
tools/browser_helpers_cowork.md.

At bootstrap:
1. Confirm STACK VALIDATION matches (Claude in Chrome MCP, Cowork
   sandbox, async Phase C via subprocess). If not, halt and tell
   me.
2. Mount all four directories above. Confirm all mounts succeeded.
3. Read the README.md at the root of ~/claude-auth-bridge — it's
   the authority on the Claude Code invocation pattern.
4. Read agents/ARCHITECT.md, agents/ROLES.md,
   agents/OPERATOR_cowork.md, agents/REVIEWER.md, agents/QA.md,
   agents/HISTORIAN.md, agents/DIAGNOSTICIAN.md,
   agents/CLAUDE_CODE.md, tools/browser_helpers_cowork.md (all in
   the mounted repo).
5. Verify Architect tab's model + thinking state via the helper
   selectors. Verify Reviewer tab's model.
6. Send an identification ping to the Architect tab (it'll search
   project knowledge to confirm its bearings). Parse the response.
7. Send the Reviewer Bootstrap Block (template at end of
   agents/OPERATOR_cowork.md) to the Reviewer tab. Parse the model
   identity in the reply.
8. Verify gh auth from the sandbox: run
   GH_CONFIG_DIR=<gh-credentials-mount-path> gh auth status
   and confirm a valid token.
9. Confirm to me in one short message: your tier, Architect's
   model + thinking state, Reviewer's model, all four mount paths,
   gh auth status, current phase, next backlog item.
10. Then begin the next backlog item without further prompting
    from me. I'm walking away.

Stop conditions are listed in agents/OPERATOR_cowork.md. When you
stop, write decisions/SESSION-SUMMARY-<timestamp>.md so I can see
what happened when I'm back.
```

### Step 5 — Wait for confirmation

The Cowork chat should reply within 60 seconds with the one-message
confirmation. If it does:

- Tiers look right? All mounts succeeded? `gh auth status` valid?
  → walk away.
- Anything wrong? → fix and paste a one-line correction.

If the chat doesn't reply within 60 seconds or the reply is
incoherent:

- Check whether the Claude in Chrome browser is actually running
  and visible.
- Check whether tab logins are still valid (claude.ai cookie,
  gemini.google.com cookie). Re-log if needed.
- Check `tools/browser_helpers_cowork.md` — are the selectors for
  this stack still current? Selectors for claude.ai and
  gemini.google.com have drifted before; the helpers file lists
  the canonical ones at the time of writing.
- Check `gh auth status` returned a valid token. If not, run `gh
  auth login` on the host and re-copy `~/.config/gh ~/gh-credentials`.
- Verify project knowledge is synced. A stale sync looks like the
  Architect tab "can't find" files that exist on main.
- Re-paste the bootstrap if needed.

### Step 6 — Walk away

The loop is now autonomous. The Cowork Operator will:

- Drive the Architect's claude.ai tab through Diagnose → Design →
  Review → QA test design for each backlog item
- Spawn fresh claude.ai tabs inside the Illustrator project for
  QA (per item), Historian (at checkpoints), Diagnostician (on
  symptom). Each uses `project_knowledge_search` over the synced
  repo.
- Stage prompts to `tasks/`, append to `BACKLOG.md`, push to main
- **Launch `run-next-batch.sh` as a subprocess** (via the
  claude-auth-bridge invocation pattern); poll the log file for
  30-minute heartbeat and check for PR creation every 30 seconds
- Drive PR Review back through the Architect tab using mechanical
  facts from `gh pr diff`
- Write decision logs when Architect overrules a role
- Stop cleanly on the conditions in `agents/OPERATOR_cowork.md`

When you're back, read:

1. The newest `decisions/SESSION-SUMMARY-<timestamp>.md` — what
   completed and what stalled
2. `decisions/SESSION-STALL-<timestamp>.md` if one exists — what
   needs your action
3. `BACKLOG.md` — what merged (`[x]`), what's in flight (`[~]`),
   what's queued (`[ ]`)
4. `decisions/` — any overrules or disagreements logged

## What to do if you find a stall when you're back

**Tier downgrade**: re-verify tiers in both tabs, switch back,
paste a "resume" message:

```
Resume the session. I've fixed the tier issue noted in
SESSION-STALL-<ts>.md. Re-verify all tier selectors and continue
with the next backlog item.
```

**Browser unresponsive**: re-log into claude.ai or gemini.google.com
as needed. Then resume.

**`gh auth status` failure**: run `gh auth login` on the host, then
`cp -r ~/.config/gh ~/gh-credentials`, then resume.

**Mount failures**: confirm the host paths exist and are readable.
The Operator can't mount what doesn't exist; if `~/claude-auth-bridge`
is missing the binary path or session state, the Operator will
report it in the stall.

**`run-next-batch.sh` subprocess died without producing a PR**:
read the `runs/<short-name>-<ts>.log` file. Common causes: Claude
Code hit a permissions wall the prompt didn't anticipate, the agent
got confused about the chain head, the branch already existed from
a previous run. Surface to Architect via a new session bootstrap
and let it decide whether to re-stage or redesign.

**Project knowledge stale**: trigger a manual refresh and re-paste
a resume bootstrap.

**Genuine design ambiguity** (Architect verdicted STOP with `##
Open issues`): you decide. Edit `tasks/<short-name>.md` directly
with your call, or paste your decision to the Architect tab and
ask it to resume.

**Disk-avoidance grep failure** in Claude Code's pre-merge gates:
read the Operator's stall report, look at the diff (PR may or may
not have been opened — check `gh pr list`). Most likely a new
workflow code path that bypasses `buildWorkflow`. Fix it as a
follow-up item.
