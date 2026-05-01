# Feature backlog

Status legend:
- `[ ]` queued, not yet started
- `[~]` in flight (PR open, awaiting review/merge)
- `[x]` merged

When picking the next item, find its prompt file in `prompts/` and execute that prompt. Never start work without a prompt file — they are the source of truth, not this list.

## Queued

- [ ] Fix delete-from-UI to actually remove image files from disk — see prompts/fix-delete-orphan-files.md
- [ ] Clean up leftovers from image-storage migration — see prompts/storage-migration-leftovers.md
- [ ] Fail closed on missing SSH env vars + validate /api/generate body — see prompts/input-env-hardening.md
- [ ] Extract useModelLists hook + clean up ModelSelect effect deps — see prompts/modelselect-hook-refactor.md
- [ ] Prisma client touch-ups — see prompts/prisma-client-touchups.md

## In flight

- [~] AGENTS.md gh CLI update — `batch/agents-gh-pr-workflow` (PR #3)


## Ready for Review



## Done

- [x] image storage relocation, gallery infinite-scroll, CivitAI Air format — `batch/storage-gallery-air` (PR #1)
- [x] Install gh CLI and wire up PR creation workflow — `batch/gh-cli` (PR #2)
- [x] AGENTS.md gh CLI update — `batch/agents-gh-pr-workflow` (PR #3)
- [x] CheckpointConfig.baseModel UI + auto-populate — `batch/checkpoint-basemodel` (PR #4)
- [x] Textual inversion / embeddings full feature — see prompts/embeddings.md (PR #5)

