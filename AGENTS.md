# Instructions for AI agents (Cowork, Claude Code, etc.)

## Before any code changes

1. Read CLAUDE.md fully. The architecture rules there are load-bearing.
2. Read BACKLOG.md to understand what's queued and what's deferred.
3. Pick the next unchecked item from BACKLOG.md unless explicitly directed otherwise.

## Branch and commit hygiene

- NEVER push directly to main. main is protected; pushes will fail.
- Create a feature branch named `batch/<short-name>` (e.g. `batch/live-previews`, `batch/checkpoint-basemodel`).
- Commit incrementally as work progresses. Don't do one giant commit at the end.
- Each commit message should be a single line summary; the PR description carries detail.
- After acceptance criteria pass, open a PR against main using `gh pr create`.

## Build and validation gates

- Before EVERY commit, run `npm run build`. If it fails, fix it before committing.
- Before opening the PR, run `grep -rn "class_type.*['\"]SaveImage['\"]" src/` and confirm only SaveImageWebsocket appears. This is the disk-avoidance constraint.
- Before opening the PR, run `grep -rn "class_type.*['\"]LoadImage['\"]" src/` and confirm only ETN_LoadImageBase64 appears.
- Do not run `pm2 restart` for any reason. PM2 management is the user's manual responsibility.
- Do not modify .env, ecosystem.config.js, or any systemd unit files unless the task explicitly directs you to.

## When uncertain — STOP

- If the prompt is ambiguous between two reasonable approaches, do not pick. Stop and write a comment in the PR explaining the ambiguity.
- If you encounter behavior that contradicts CLAUDE.md, do not "fix" CLAUDE.md to match. Stop and flag it.
- If a task touches comfyws.ts, workflow.ts, or the WS hijack path, treat with extra care. These are load-bearing and have caused real bugs when modified hastily.
- If a task would require modifying the disk-avoidance assertion, runtime validation, or any of the SaveImageWebsocket / ETN_LoadImageBase64 / ETN_LoadMaskBase64 plumbing — STOP. Those are architectural.

## PR format

PR title: matches the batch name (e.g. "Batch P — Live step previews")
PR body must include:
- Summary of changes file-by-file
- Acceptance criteria walkthrough (each criterion from the prompt, marked ✓ or with explanation)
- Any deviations from the prompt and why
- Manual smoke tests run (or explicitly noted as skipped)

## Backlog management

- After successfully merging a PR, mark the corresponding BACKLOG.md item with [x] and add the PR number.
- Do NOT add new items to BACKLOG.md without explicit user direction. The backlog is the user's plan, not the agent's.

## Out of scope behaviors

- Do not refactor unrelated code "while you're in there."
- Do not update dependencies unless the task explicitly requires it.
- Do not change formatting or linting rules.
- Do not create new files unless the task requires them.
