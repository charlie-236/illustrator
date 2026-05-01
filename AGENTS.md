# Instructions for AI agents working on this repo

This file is read by Claude Code CLI (and any other agent) before starting work on this repo. It defines guardrails, expected workflow, and the boundaries of agent authority.

## Read first, always

1. CLAUDE.md — load-bearing architecture rules. The Disk-Avoidance Constraint and Network Routing Rules are non-negotiable.
2. BACKLOG.md — queue of pending features.
3. The specific prompt file in `prompts/` corresponding to the task.

## When invoked autonomously (e.g., via the run-next-batch script)

If invoked without a specific task, pick the first unchecked item from BACKLOG.md, find its prompt file, and execute that prompt.

If invoked with a specific prompt path, execute that one.

## Branch base

Branch from the current HEAD, not from main. The wrapper script (run-next-batch.sh) checks out the correct base before invoking you — it may be main, or it may be the most recent unmerged batch/* branch when work is being chained. Do NOT `git checkout main` before creating your feature branch. Use `git checkout -b batch/<short-name>` from wherever HEAD currently is, and pass `--base $(git rev-parse --abbrev-ref HEAD@{1})` or just hardcode the base branch name from your invocation context to `gh pr create`.

## Branch and commit rules — POLICY ONLY (main is no longer protected)

- Even though main accepts direct pushes, NEVER push directly to main.
- All work goes on a feature branch named `batch/<short-name>`.
- All work merges via PR so the user can review the diff.
- If you find yourself about to push to main, STOP and create a branch instead.

## Branch and commit hygiene

After acceptance criteria pass, push the branch and create the PR:

    git push -u origin batch/<short-name>
    gh pr create --base main --head batch/<short-name> \
      --title "<batch title>" \
      --body-file <path-to-pr-body.md>

Write the PR body to a temporary file first (e.g. `/tmp/pr-body.md`) so multi-line markdown survives shell escaping. The body must follow the format described below.

After PR creation, capture the PR URL from the gh output. Mark the BACKLOG.md item as `[~]` (in-flight) with the PR number. Commit and push that BACKLOG.md change to the same feature branch — gh will update the existing PR automatically.

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

## When uncertain — STOP

- If the prompt is ambiguous between two reasonable approaches, do not pick. Push what you have, and write the ambiguity in the PR description so the user can clarify.
- If a task touches `comfyws.ts`, `workflow.ts`, the WS hijack path, or the disk-avoidance assertion in `/api/generate/route.ts`, treat with extra care. These are load-bearing.
- If the route's disk-avoidance assertion would need modification, STOP. That is architectural and requires explicit user direction.

## PR body format

Every PR you create must include:

1. **Summary** — file-by-file list of changes
2. **Acceptance criteria walkthrough** — every criterion from the prompt, marked ✓ or with explanation if not met
3. **Manual smoke tests** — what you ran (or "smoke tests deferred to user" if they require runtime services unavailable in your sandbox)
4. **Deviations from the prompt** — anything you did differently, with reasoning

## Backlog management

After successfully creating the PR, update BACKLOG.md: change `[ ]` to `[~]` for the in-flight item (it's not done until the user merges). Add the PR number next to it. Commit and push that change to the same feature branch.

After merge, the user updates `[~]` to `[x]`. Do not modify BACKLOG.md to add `[x]` yourself.

## Tools available

- `git`, `node`, `npm`, `curl`, `python`, `ssh` — full network access
- `gh` is installed and authenticated. Use `gh pr create` after pushing the branch. Use `gh pr view <number>` to read existing PRs.
- The A100 VM SSH key is at `/home/charlie/.ssh/a100-key.pem` (read .env for canonical path)
- Database: PostgreSQL at the URL in `.env`
- ComfyUI: tunneled to 127.0.0.1:8188; do not assume it's running

## Repo paths

- Working directory: `/home/charlie/illustrator`
- Remote: `origin` → https://github.com/charlie-236/illustrator
- Default branch: `main` (protected)
- Feature branches: `batch/<short-name>`
