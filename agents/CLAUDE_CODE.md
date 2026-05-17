# CLAUDE_CODE.md — Instructions for Claude Code CLI

This file is read by Claude Code CLI before starting work on this
repo. It defines the guardrails, expected workflow, and operational
boundaries Claude Code operates under during the Build phase.

If you are a role-side AI (Architect, Reviewer, QA, Historian,
Diagnostician), this file describes the constraints the implementer
is operating under — knowing these is useful when you're designing
prompts or reviewing PRs. Your own brief is one of:
`agents/ARCHITECT.md`, `agents/REVIEWER.md`, `agents/QA.md`,
`agents/HISTORIAN.md`, `agents/DIAGNOSTICIAN.md`.

If you are the **Cowork Operator**, you launch a Claude Code
subprocess for Phase C via the auth-bridge invocation pattern; the
subprocess reads this file as part of its repo context. Your own
brief is `agents/OPERATOR_cowork.md`.

If you are the **VS Code Operator wearing the Claude Code hat**
(synchronous Phase C in the same chat), follow this file verbatim
during the Build phase. Your wider brief is `agents/OPERATOR.md`.

## Read first, always

1. `CLAUDE.md` — load-bearing architecture rules. The Disk-Avoidance
   Constraint is non-negotiable.
2. `BACKLOG.md` — queue of pending features.
3. The specific task prompt in `tasks/` corresponding to the work.
4. `agents/ARCHITECT.md` — project context, hard rules, diagnostic
   file inventory. Useful for understanding *why* a prompt asks for
   what it asks for.

## When invoked autonomously (e.g., via run-next-batch.sh)

If invoked without a specific task, pick the first unchecked item
from `BACKLOG.md`, find its task prompt file in `tasks/`, and
execute that prompt.

If invoked with a specific task path, execute that one.

## Branch and commit rules

- **`main` is protected.** Direct pushes to `main` will be rejected
  by GitHub. This is enforced server-side, not by policy.
- All work goes on a feature branch named `batch/<short-name>`.
- The wrapper script (`run-next-batch.sh`) creates the branch for
  you BEFORE invoking you. You will already be on the correct
  `batch/*` branch when you start. **Do NOT run `git checkout -b`**
  — the branch already exists and you are already on it.
- All work merges via PR so the User (or the multi-role workflow's
  Architect, in autonomous sessions) can review the diff.
- The PR base is whatever was checked out before the script
  branched (`main`, or a previous unmerged `batch/*`). The script's
  prompt prefix tells you the exact base branch name. Use that.

## Before any commit: verify your branch

Run `git rev-parse --abbrev-ref HEAD` before your first commit.
The result MUST start with `batch/`. If it returns `main` or
anything else, the script's branching step failed — **STOP** and
report the issue. Do not attempt to recover by branching yourself;
that masks the failure mode.

If your first commit accidentally lands somewhere other than the
expected branch, STOP. Do not push. Report. Branch protection on
`main` will catch a direct push, but it cannot recover lost intent
— only the User (or the autonomous Operator) can decide how to
handle a wrong-branch commit.

## Branch and commit hygiene

The script-injected prompt prefix tells you:
- The branch name you're on (e.g. `batch/input-env-hardening`)
- The base branch (e.g. `main`, or a previous unmerged `batch/*`)

After acceptance criteria pass, push the branch and create the PR
against the correct base:

```
git push -u origin batch/<short-name>
gh pr create \
  --base <BASE_BRANCH> \
  --head batch/<short-name> \
  --title "<batch title>" \
  --body-file /tmp/pr-body.md
```

Where `<BASE_BRANCH>` is the value the script gave you in the
prompt prefix. NOT always `main` — when batches are chained, the
base will be the previous batch's branch.

Write the PR body to a temporary file first (e.g. `/tmp/pr-body.md`)
so multi-line markdown survives shell escaping. The body must
follow the format in the "PR body format" section below.

After PR creation, capture the PR URL from the gh output. Then
update `BACKLOG.md` on the SAME feature branch:

1. Find the line for the item you just completed (the line that
   referenced your task prompt file).
2. Change `[ ]` to `[~]`.
3. Replace the `— see tasks/<name>.md` suffix with `— \`batch/<short-name>\` (PR #N)`.
4. Commit with message: `Mark <short-name> in-flight (PR #N)`.
5. Push to the same feature branch. The PR updates automatically.

The batch is NOT complete until the BACKLOG.md commit is pushed.
The wrapper script will refuse to start the next batch if
`BACKLOG.md` still shows `[ ]` for the item you just ran. Skipping
this step is a workflow failure, not a "nice to have."

## Build and validation gates (before EVERY commit)

- `npm run build` must pass clean.
- `grep -rn "class_type.*['\"]SaveImage['\"]" src/` must return only `SaveImageWebsocket`.
- `grep -rn "class_type.*['\"]LoadImage['\"]" src/` must return only `ETN_LoadImageBase64` (and `ETN_LoadMaskBase64` for inpainting paths).
- These are the disk-avoidance constraints from `CLAUDE.md`. A
  regression here is a load-bearing failure.

If a task prompt comes with additional QA-designed pre-merge gates
(A1, A2, …), run those too. The Architect's prompt will list any
project-specific assertions.

### Where these commands run

The disk-avoidance greps are static checks against source files —
they run wherever the working tree is.

`npm run build` needs to run **on mint-main** (`192.168.1.206`)
because the app's runtime expectations resolve there (Postgres,
Tailscale to the Azure A100 VM running ComfyUI). It will appear
to work on other machines but produces false-negative results.

In practice:

- **You're a Claude Code subprocess launched by `run-next-batch.sh`
  on mint-main directly** (Cowork stack default, or User-initiated
  via SSH). `npm run build` runs locally for you — no action
  needed beyond `npm run build`.
- **You're the VS Code Operator wearing the Claude Code hat on
  PC1**. `npm run build` does NOT run locally — your wider brief
  (`agents/OPERATOR.md`) describes the SSH-to-mint-main pattern.
  Follow that. Do not try to run the build on PC1.
- **You're not sure which environment you're in.** Run
  `hostname` and `curl -m 2 http://127.0.0.1:8188/system_stats`.
  If the hostname is `mint-main` (or similar) and the curl
  returns a JSON system_stats response, you're on mint-main and
  builds run locally. Otherwise stop and ask.

## Operational boundaries — DO NOT

- Do not run `pm2` commands. PM2 management is the User's manual
  responsibility.
- Do not modify `.env`, `ecosystem.config.js`, systemd unit files,
  or `prisma/schema.prisma` unless the task explicitly directs you
  to.
- Do not refactor unrelated code.
- Do not update dependencies unless the task explicitly requires it.
- Do not change formatting or linting rules.
- Do not modify `CLAUDE.md` to "match" code that violates it. Stop
  and flag the conflict.
- Do not run `git checkout main` or create branches yourself. The
  script handles that.
- Do not attempt to push to `main`. It will be rejected and is a
  policy violation regardless.

## Common pitfalls

- **SSE stream close ≠ user intent.** Don't treat client disconnect
  as an abort signal — that conflates "user pressed cancel" with
  "browser refreshed" and breaks refresh survivability. Aborts must
  be explicit endpoint calls (`POST /api/jobs/[promptId]/abort`).
- **Never add `beforeunload` / `pagehide` handlers** that call
  abort or cleanup on the server — same reasoning as above.
- **Silent ENOENT on `unlink`** hides real errors. Distinguish
  ENOENT from other errors in file-removal code.
- **Empty arrays on API failure** look like successful empty
  results in the UI. If ComfyUI is unreachable, return an explicit
  error, not `{ checkpoints: [], loras: [] }`.
- **Hardcoded defaults on env vars that should fail closed** —
  use `?? ''` plus a runtime check, not `?? '<some-default>'`.

## When uncertain — STOP

- If the prompt is ambiguous between two reasonable approaches, do
  not pick. Push what you have, and write the ambiguity in the PR
  description so the User (or the Architect, in autonomous
  sessions) can clarify.
- If a task touches `comfyws.ts`, `workflow.ts`, the WS hijack
  path, or the disk-avoidance assertion in `/api/generate/route.ts`,
  treat with extra care. These are load-bearing.
- If the route's disk-avoidance assertion would need modification,
  STOP. That is architectural and requires explicit User /
  Architect direction.
- If `git rev-parse --abbrev-ref HEAD` shows you are not on a
  `batch/*` branch, STOP. Report. Do not self-recover.
- If `gh pr create` fails because the branch was rejected by branch
  protection, STOP. Report. Do not retry against a different base.

## PR body format

Every PR you create must include:

1. **Summary** — file-by-file list of changes
2. **Acceptance criteria walkthrough** — every criterion from the
   task prompt, marked ✓ or with explanation if not met
3. **Manual smoke tests** — what you ran (or "smoke tests deferred"
   if they require runtime services unavailable in your sandbox)
4. **Deviations from the prompt** — anything you did differently,
   with reasoning
5. **Post-merge actions** — REQUIRED if the change modifies
   `prisma/schema.prisma`, requires a new env var in `.env`,
   requires PM2 restart, requires model installation on the A100
   VM, or any other action Charlie must run on the host. Be
   explicit about the exact command.

## Backlog management

See "Branch and commit hygiene" above for the `BACKLOG.md` update
step. After merge, the User updates `[~]` to `[x]`. Do not modify
`BACKLOG.md` to add `[x]` yourself.

## Tools available

- `git`, `node`, `npm`, `curl`, `python`, `ssh` — full network
  access subject to the runtime's allowlist
- `gh` is installed and authenticated. Use `gh pr create` after
  pushing the branch. Use `gh pr view <number>` to read existing
  PRs.
- The GPU VM SSH key path is in `.env` at `GPU_VM_SSH_KEY_PATH`
- Database: PostgreSQL at the URL in `.env`; `npx prisma studio`
  for browsing, or `psql` for queries
- ComfyUI: tunneled to `127.0.0.1:8188`; do not assume it's
  running

## Cowork-specific note on auth

When `run-next-batch.sh` is launched from a Cowork sandbox session,
both `gh` and `git push` need credentials that aren't accessible
from inside the bwrap sandbox by default. The Operator solves this
by mounting `~/claude-auth-bridge` (the User's persistent auth
state) via `request_cowork_directory` and SSHing to `localhost`
to run the script on the host directly — see
`agents/OPERATOR_cowork.md` for the full pattern.

From inside Claude Code itself, you should just use `gh` and `git
push` normally. The wrapper sets up the environment before
invoking you. If a `gh` or `git push` command fails with an auth
error, surface it and stop; the User needs to refresh the bridge's
auth state on the host.

## Repo paths

- Working directory: the repo root (read from `.env` or context)
- Remote: `origin` → the project's GitHub remote
- Default branch: `main` (protected — direct pushes rejected)
- Feature branches: `batch/<short-name>`
- Task prompts: `tasks/<short-name>.md`
- Decision logs: `decisions/`
- Wrapper logs and sentinels: `runs/`
