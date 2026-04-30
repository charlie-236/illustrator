# Batch — Update AGENTS.md to use gh CLI for PR creation

The `gh` CLI is now installed and authenticated on mint-pc. Past AGENTS.md guidance told the agent to push the branch and stop, leaving the user to create the PR manually. This batch updates AGENTS.md so future agents create PRs themselves.

No application code changes. AGENTS.md only.

---

## Required changes

In `AGENTS.md`, find any guidance about PR creation and replace it with the new flow:

**Old wording (remove):**
- "DO NOT create the pull request yourself. The user creates the PR manually after reviewing the pushed branch."
- "The user copies your PR title and body into GitHub when creating the PR manually."
- Any mention of "gh CLI not available" or "gh is missing in this sandbox"

**New wording:**

```markdown
## Branch and commit hygiene

After acceptance criteria pass, push the branch and create the PR:

    git push -u origin batch/<short-name>
    gh pr create --base main --head batch/<short-name> \
      --title "<batch title>" \
      --body-file <path-to-pr-body.md>

Write the PR body to a temporary file first (e.g. `/tmp/pr-body.md`) so multi-line markdown survives shell escaping. The body must follow the format described below.

After PR creation, capture the PR URL from the gh output. Mark the BACKLOG.md item as `[~]` (in-flight) with the PR number. Commit and push that BACKLOG.md change to the same feature branch — gh will update the existing PR automatically.

## PR body format

Every PR you create must include:

1. **Summary** — file-by-file list of changes
2. **Acceptance criteria walkthrough** — every criterion from the prompt, marked ✓ or with explanation if not met
3. **Manual smoke tests** — what you ran (or "smoke tests deferred to user" if they require runtime services unavailable in your sandbox)
4. **Deviations from the prompt** — anything you did differently, with reasoning
```

Update the "Tools available" section's gh line. Where it currently says "gh is NOT available," change it to:

```markdown
- `gh` is installed and authenticated. Use `gh pr create` after pushing the branch. Use `gh pr view <number>` to read existing PRs.
```

---

## Acceptance criteria

- AGENTS.md no longer references "gh not available" or any variation.
- AGENTS.md instructs the agent to use `gh pr create` after pushing.
- AGENTS.md describes writing the PR body to a temp file before passing to gh.
- AGENTS.md still requires the same PR-body format (Summary / Acceptance Criteria / Smoke Tests / Deviations).
- The agent's BACKLOG.md update workflow is preserved (`[~]` with PR number, then `[x]` after merge).
- This batch's own PR is created via `gh pr create` — proves the new workflow operationally.

---

## Out of scope

- Don't change the wrapper script `~/bin/run-next-batch.sh`.
- Don't change branch protection (it's intentionally off).
- Don't change CLAUDE.md.
- Don't add pre-commit hooks or git aliases.

When this batch's PR is merged, every subsequent batch should rely on the agent creating its own PR.
