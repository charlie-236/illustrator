# USER_BOOTSTRAP.md — Your 5-minute checklist (VS Code stack)

This is **your** checklist — Charlie's — for starting an autonomous
session on the VS Code stack. The Operator does the work; you spend
~5 minutes on setup, paste a bootstrap message, and walk away.

If you're on the Cowork stack, read `USER_BOOTSTRAP_cowork.md`
instead.

## Prereqs (one-time, not per-session)

- VS Code Insiders or Stable with Copilot M365 Chat enabled and a
  Claude 4.7 model selected by default in the chat picker.
- Microsoft Playwright MCP installed and configured for the VS Code
  Operator chat to drive.
- `repomix` installed globally (`npm i -g repomix`) so the Operator
  can regenerate repo snapshots per role chat.
- `gh` authenticated against github.com on this machine.
- The illustrator repo cloned at the path you usually use; `main`
  checked out with no uncommitted changes you care about.

## Per-session setup

### Step 1 — Generate a fresh repomix archive

```
cd ~/illustrator
repomix --output /tmp/repo-snapshot.xml
```

This is what every role-side Claude chat (Architect, QA, Historian,
Diagnostician) will search. The Operator regenerates this between
PRs to stay current, but the initial one needs to exist for
bootstrap.

### Step 2 — Open the two persistent role tabs in the managed browser

The VS Code Operator chat drives a Playwright-managed browser. You
need to have two tabs ready before you hand off:

1. **Architect tab** — Copilot M365 chat, fresh conversation, with
   Claude 4.7 selected in the model picker. If you have a saved
   "Illustrator Architect" workspace or chat, open that; otherwise
   start a fresh conversation.
2. **Reviewer tab** — gemini.google.com, fresh chat, Pro selected
   in the mode picker (the picker label should read "Pro", not
   "Flash" or "Fast"). Use the Gemini account you've been using
   for this project so the chat history stays linked.

Per-event tabs (QA, Historian, Diagnostician) are opened by the
Operator on demand and don't need to exist at session start.

### Step 3 — Verify tier on each tab visually

Quick visual check before you hand off:

- Architect tab: model selector shows "Claude 4.7" (or whatever
  current best is). Thinking is on (the toggle / button is in the
  active state).
- Reviewer tab: mode picker shows "Pro". Not "Flash", not "Fast",
  not "2.5 Flash".

If either is wrong, fix it before you walk away. The Operator does
a programmatic re-verify at bootstrap, but a visual check now saves
a round trip.

### Step 4 — Paste the bootstrap message to the VS Code Operator

Open a new VS Code Operator chat (or continue an existing one if
mid-phase). Paste this bootstrap, adapting the bracketed bits:

```
You are the Operator for the illustrator project. Read
agents/OPERATOR.md as your full brief — the STACK VALIDATION
header at the top confirms you should be reading this file, not
OPERATOR_cowork.md.

Repo path: ~/illustrator (working dir is the VS Code workspace root)
Repomix archive: /tmp/repo-snapshot.xml (regenerate between PRs)
Current chain head: <main, OR a batch/... branch if mid-chain>
Current phase: <Phase 1 — multi-role workflow standup, OR whatever ROADMAP.md says>
Backlog state: see BACKLOG.md (first [ ] line is the next item)

Browser tabs already open in the Playwright browser:
1. Architect tab (Copilot M365, Claude 4.7 + extended thinking)
2. Reviewer tab (gemini.google.com, Pro)

You will spawn additional Copilot M365 tabs for QA, Historian,
and Diagnostician as needed. Use the model-check helpers in
tools/browser_helpers.md.

At bootstrap:
1. Confirm STACK VALIDATION matches (Playwright MCP, VS Code,
   synchronous Phase C). If not, halt and tell me.
2. Read agents/ARCHITECT.md, agents/ROLES.md,
   agents/OPERATOR.md, agents/REVIEWER.md, agents/QA.md,
   agents/HISTORIAN.md, agents/DIAGNOSTICIAN.md,
   agents/CLAUDE_CODE.md, tools/browser_helpers.md.
3. Verify Architect tab's model + thinking state via the helper
   selectors. Verify Reviewer tab's model.
4. Attach /tmp/repo-snapshot.xml to the Architect tab and send an
   identification ping; parse the response.
5. Send the Reviewer Bootstrap Block (template at end of
   agents/OPERATOR.md) to the Reviewer tab; parse the model
   identity in the reply.
6. Confirm to me in one short message: your tier, Architect's
   model + thinking state, Reviewer's model, repomix archive
   path, current phase, next backlog item.
7. Then begin the next backlog item without further prompting
   from me. I'm walking away.

Stop conditions are listed in agents/OPERATOR.md. When you stop,
write decisions/SESSION-SUMMARY-<timestamp>.md so I can see what
happened when I'm back.
```

### Step 5 — Wait for confirmation

The VS Code chat should reply within 60 seconds with the
one-message confirmation. If it does:

- Tiers look right? → walk away.
- Tiers look wrong? → fix what's wrong, paste a one-line correction
  (e.g. "Reviewer is on Flash; I'll switch to Pro and you can
  proceed").

If the chat doesn't reply within 60 seconds or the reply is
incoherent:

- Check the Playwright browser — is it actually running? Did the
  session lose its login cookies? (Re-log into Copilot M365 and
  Gemini if needed.)
- Check `tools/browser_helpers.md` — are the Copilot M365 selectors
  still `TODO` placeholders? If so, the Operator needs to run the
  DOM probe procedure (documented at the end of the helpers file)
  before sending real messages. Ask the Operator to do that first.
- Check that all docs exist on `main` under `agents/`.
- Check the VS Code chat's Claude tier (might be on a faster
  variant).
- Re-paste the bootstrap if needed.

### Step 6 — Walk away

The loop is now autonomous. The VS Code Operator will:

- Drive the Architect's Copilot M365 tab through Diagnose → Design
  → Review → QA test design for each backlog item
- Spawn fresh Copilot M365 chats for QA (per item), Historian (at
  checkpoints), Diagnostician (on symptom), with fresh repomix
  archives attached at the start of each
- **Switch hats to write the Phase C implementation itself**, run
  the pre-merge gates QA designed, open the PR
- Drive PR Review back through the Architect tab
- Write decision logs when Architect overrules a role
- Stop cleanly on the conditions in `agents/OPERATOR.md`

When you're back, read:

1. The newest `decisions/SESSION-SUMMARY-<timestamp>.md` — what
   completed and what stalled
2. `decisions/SESSION-STALL-<timestamp>.md` if one exists — what
   needs your action
3. `BACKLOG.md` — what merged (`[x]`), what's in flight (`[~]`),
   what's queued (`[ ]`)
4. `decisions/` — any overrules or disagreements logged

## What to do if you find a stall when you're back

If a `SESSION-STALL-*.md` exists:

**Tier downgrade** (most common): the AI was bumped from
Pro/Claude-4.7 to a faster variant mid-session. Re-verify tiers,
switch back, paste a "resume" message:

```
Resume the session. I've fixed the tier issue noted in
SESSION-STALL-<ts>.md. Re-verify all tier selectors and continue
with the next backlog item.
```

**Browser unresponsive**: usually a session cookie expiry on
Copilot M365 or Gemini. Re-log in, then resume the same way.

**`gh auth status` failure**: token expired. Run `gh auth login`
locally, then resume.

**Genuine design ambiguity** (Architect verdicted STOP with `##
Open issues`): you decide. Once decided, either paste your decision
into the Architect tab and ask it to resume, or edit
`tasks/<short-name>.md` directly with your call and re-launch.

**Disk-avoidance grep failure** in Claude Code's pre-merge gates:
read the Operator's stall report, look at the diff, figure out
where the forbidden node type came from. Most likely a new
workflow code path that bypasses `buildWorkflow`. Fix it as a
follow-up item.
