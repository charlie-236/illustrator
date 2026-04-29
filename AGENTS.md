# Instructions for AI agents (Cowork, Claude Code, etc.)

## Before any code changes

1. Read CLAUDE.md fully. The architecture rules there are load-bearing.
2. Read BACKLOG.md to understand what's queued.
3. Pick the next unchecked item from BACKLOG.md unless explicitly directed otherwise.
4. Read the corresponding prompt file in `prompts/` for the full specification.

## Branch and commit hygiene

- NEVER push directly to main. main is protected; pushes will fail.
- Create a feature branch named `batch/<short-name>` matching the prompt's name.
- Commit incrementally as work progresses. Don't squash everything to one commit at the end.
- Each commit message: single-line summary, present tense (e.g. "Add live preview SSE event").
- After acceptance criteria pass, push the branch with `git push -u origin batch/<short-name>`.
- DO NOT create the pull request yourself. `gh` is not available in this sandbox and the user creates the PR manually after reviewing the pushed branch.

## Build and validation gates (RUN BEFORE EVERY COMMIT)

- `npm run build` must pass clean. If it fails, fix it before committing.
- `grep -rn "class_type.*['\"]SaveImage['\"]" src/` must return only SaveImageWebsocket.
- `grep -rn "class_type.*['\"]LoadImage['\"]" src/` must return only ETN_LoadImageBase64 (and ETN_LoadMaskBase64 for inpainting).
- These are the disk-avoidance constraints. Violating them is a load-bearing failure.

## Operational boundaries — DO NOT

- Do not run `pm2 restart` or any pm2 command. PM2 management is the user's manual responsibility on the runtime machine (mint-pc).
- Do not modify `.env`, `ecosystem.config.js`, or any systemd unit files unless the task explicitly directs you to.
- Do not modify `prisma/schema.prisma` without an explicit task instruction. Schema changes require migration coordination.
- Do not refactor unrelated code "while you're in there."
- Do not update dependencies unless the task explicitly requires it.
- Do not change formatting or linting rules.

## When uncertain — STOP

- If the prompt is ambiguous between two reasonable approaches, do not pick. Push what you have, then write the ambiguity in your final message so the user can clarify in the PR.
- If you encounter behavior that contradicts CLAUDE.md, do not "fix" CLAUDE.md to match. Stop and flag it.
- If a task touches comfyws.ts, workflow.ts, or the WS hijack path, treat with extra care. These are load-bearing.
- If a task would require modifying the disk-avoidance assertion or any of the SaveImageWebsocket / ETN_LoadImageBase64 / ETN_LoadMaskBase64 plumbing, STOP. That requires explicit user direction.

## Final message format (when batch is complete)

After pushing the branch, your final message must include:

1. **Branch name pushed**: `batch/<name>`
2. **Suggested PR title**: matches the batch name from the prompt
3. **Suggested PR body** in markdown, containing:
   - File-by-file summary of changes
   - Acceptance criteria walkthrough — every criterion from the prompt, marked ✓ or with explanation
   - Manual smoke tests run (or explicitly noted as "smoke test deferred to user")
   - Any deviations from the prompt and why
4. **BACKLOG.md update**: a one-line note saying "BACKLOG.md item marked done in branch — user should verify after merge."

The user copies your PR title and body into GitHub when creating the PR manually.

## Backlog management

- After a PR merges, the user marks the BACKLOG.md item with `[x]` and the PR number. Cowork does NOT modify BACKLOG.md unless the task explicitly says to.
- Do NOT add new items to BACKLOG.md. The backlog is the user's plan.

## Tools available in this sandbox

- `git`, `node`, `npm`, `curl`, `python` — all in /usr/bin
- `gh` is NOT available. Use `git push` and let the user create PRs manually.
- No `pm2`, no `psql`, no SSH access to the A100 VM (that's mint-pc's job).

## Repos and paths

- Working directory: the workspace folder Cowork was granted access to
- Remote: `origin` points to https://github.com/charlie-236/illustrator
- Main branch: `main` (protected, no direct pushes)
- Feature branches: `batch/<short-name>`