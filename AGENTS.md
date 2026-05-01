# Instructions for AI agents working on this repo

This file is read by Claude Code CLI (and any other agent) before starting work on this repo. It defines guardrails, expected workflow, and the boundaries of agent authority.

## Read first, always

1. CLAUDE.md — load-bearing architecture rules. The Disk-Avoidance Constraint and Network Routing Rules are non-negotiable.
2. BACKLOG.md — queue of pending features.
3. The specific prompt file in `prompts/` corresponding to the task.

## When invoked autonomously (e.g., via the run-next-batch script)

If invoked without a specific task, pick the first unchecked item from BACKLOG.md, find its prompt file, and execute that prompt.

If invoked with a specific prompt path, execute that one.

## Branch and commit rules

- **Main is protected.** Direct pushes to main will be rejected by GitHub. This is enforced server-side, not by policy.
- All work goes on a feature branch named `batch/<short-name>`.
- The wrapper script (`run-next-batch.sh`) creates the branch for you BEFORE invoking you. You will already be on the correct `batch/*` branch when you start. Do NOT run `git checkout -b` — the branch already exists and you are already on it.
- All work merges via PR so the user can review the diff.
- The PR base is whatever was checked out before the script branched (main, or a previous unmerged batch/*). The script's prompt prefix tells you the exact base branch name. Use that.

## Before any commit: verify your branch

Run `git rev-parse --abbrev-ref HEAD` before your first commit. The result MUST start with `batch/`. If it returns `main` or anything else, the script's branching step failed — STOP and report the issue. Do not attempt to recover by branching yourself; that masks the failure mode.

If your first commit accidentally lands somewhere other than the expected branch, STOP. Do not push. Tell the user. The patched script catches direct-push attempts to main, but it cannot recover lost intent — only the user can decide how to handle a wrong-branch commit.

## Branch and commit hygiene

The script-injected prompt prefix tells you:
- The branch name you're on (e.g. `batch/input-env-hardening`)
- The base branch (e.g. `main`, or a previous unmerged `batch/*`)

After acceptance criteria pass, push the branch and create the PR against the correct base:

    git push -u origin batch/<short-name>
    gh pr create \
      --base <BASE_BRANCH> \
      --head batch/<short-name> \
      --title "<batch title>" \
      --body-file /tmp/pr-body.md

Where `<BASE_BRANCH>` is the value the script gave you in the prompt prefix. NOT always main — when batches are chained, the base will be the previous batch's branch.

Write the PR body to a temporary file first (e.g. `/tmp/pr-body.md`) so multi-line markdown survives shell escaping. The body must follow the format in the "PR body format" section below.

After PR creation, capture the PR URL from the gh output. Then update BACKLOG.md on the SAME feature branch:

1. Find the line for the item you just completed (the line that referenced your prompt file).
2. Change [ ] to [~].
3. Replace the — see prompts/<name>.md suffix with — `batch/<short-name>` (PR #N).
4. Commit with message: Mark <short-name> in-flight (PR #N).
5. Push to the same feature branch. The PR updates automatically.

The batch is NOT complete until the BACKLOG.md commit is pushed. The wrapper script will refuse to start the next batch if BACKLOG.md still shows [ ] for the item you just ran. Skipping this step is a workflow failure, not a "nice to have."

## Build and validation gates (before EVERY commit)

- `npm run build` must pass clean.
- `grep -rn "class_type.*['\"]SaveImage['\"]" src/` must return only SaveImageWebsocket.
- `grep -rn "class_type.*['\"]LoadImage['\"]" src/` must return only ETN_LoadImageBase64 (and ETN_LoadMaskBase64 for inpainting paths).
- These are the disk-avoidance constraints. A regression here is a load-bearing failure.

## Operational boundaries — DO NOT

- Do not run `pm2` commands. PM2 management is the user's manual responsibility.
- Do not modify `.env`, `ecosystem.config.js`, systemd unit files, or `prisma/schema.prisma` unless the task explicitly directs you to.
- Do not refactor unrelated code.
- Do not update dependencies unless the task explicitly requires it.
- Do not change formatting or linting rules.
- Do not modify CLAUDE.md to "match" code that violates it. Stop and flag the conflict.
- Do not run `git checkout main` or create branches yourself. The script handles that.
- Do not attempt to push to main. It will be rejected and is a policy violation regardless.

## When uncertain — STOP

- If the prompt is ambiguous between two reasonable approaches, do not pick. Push what you have, and write the ambiguity in the PR description so the user can clarify.
- If a task touches `comfyws.ts`, `workflow.ts`, the WS hijack path, or the disk-avoidance assertion in `/api/generate/route.ts`, treat with extra care. These are load-bearing.
- If the route's disk-avoidance assertion would need modification, STOP. That is architectural and requires explicit user direction.
- If `git rev-parse --abbrev-ref HEAD` shows you are not on a `batch/*` branch, STOP. Report. Do not self-recover.
- If `gh pr create` fails because the branch was rejected by branch protection, STOP. Report. Do not retry against a different base.

## PR body format

Every PR you create must include:

1. **Summary** — file-by-file list of changes
2. **Acceptance criteria walkthrough** — every criterion from the prompt, marked ✓ or with explanation if not met
3. **Manual smoke tests** — what you ran (or "smoke tests deferred to user" if they require runtime services unavailable in your sandbox)
4. **Deviations from the prompt** — anything you did differently, with reasoning

## Backlog management

See "Branch and commit hygiene" above for the BACKLOG.md update step. After merge, the user updates [~] to [x]. Do not modify BACKLOG.md to add [x] yourself.

## Tools available

- `git`, `node`, `npm`, `curl`, `python`, `ssh` — full network access
- `gh` is installed and authenticated. Use `gh pr create` after pushing the branch. Use `gh pr view <number>` to read existing PRs.
- The A100 VM SSH key is at `/home/charlie/.ssh/a100-key.pem` (read .env for canonical path)
- Database: PostgreSQL at the URL in `.env`
- ComfyUI: tunneled to 127.0.0.1:8188; do not assume it's running

## Repo paths

- Working directory: `/home/charlie/illustrator`
- Remote: `origin` → https://github.com/charlie-236/illustrator
- Default branch: `main` (protected — direct pushes rejected)
- Feature branches: `batch/<short-name>`
