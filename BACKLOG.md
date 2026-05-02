# Feature backlog

Status legend:
- `[ ]` queued, not yet started
- `[~]` in flight (PR open, awaiting review/merge)
- `[x]` merged

When picking the next item, find its prompt file in `prompts/` and execute that prompt. Never start work without a prompt file — they are the source of truth, not this list.

- [x] image storage relocation, gallery infinite-scroll, CivitAI Air format — `batch/storage-gallery-air` (PR #1)
- [x] Install gh CLI and wire up PR creation workflow — `batch/gh-cli` (PR #2)
- [x] AGENTS.md gh CLI update — `batch/agents-gh-pr-workflow` (PR #3)
- [x] CheckpointConfig.baseModel UI + auto-populate — `batch/checkpoint-basemodel` (PR #4)
- [x] Textual inversion / embeddings full feature — `batch/checkpoint-basemodel` (PR #5)
- [x] Fix delete-from-UI to actually remove image files from disk — `batch/checkpoint-basemodel` (PR #5)
- [x] Clean up leftovers from image-storage migration — see prompts/storage-migration-leftovers.md (direct commit to main, AGENTS.md violation)
- [x] Fail closed on missing SSH env vars + validate /api/generate body — `batch/input-env-hardening` (PR #7)
- [x] Extract useModelLists hook + clean up ModelSelect effect deps — see prompts/modelselect-hook-refactor.md (PR #8)
- [x] Prisma client touch-ups — `batch/prisma-client-touchups` (PR #9)
- [x] Delete-by-filename for checkpoints and LoRAs (replaces /api/models/[id]) — `batch/model-delete-by-filename` (PR #10)
- [x] Source embeddings list from the VM (orphan visibility + delete) — `batch/embeddings-vm-source` (PR #11)
- [x] Real-readiness status probe for Admin tab services — `batch/service-readiness-probe` (PR #12)
- [x] Aphrodite readiness probe fix (PR #12 follow-up) — `batch/aphrodite-readiness-probe-fix` (PR #13)
- [x] Wan 2.2 video generation backend (Phase 1.1 of video) — `batch/wan22-video-backend` (PR #15)
- [x] Wan 2.2 video generation backend fixes (Phase 1.1 of video) — `prompts/wan22-video-backend-fixes.md` — `batch/wan22-video-backend-fixes` (PR #16)
- [x] Obfuscate VM filename prefix for video generations — `batch/wan22-video-filename-obfuscation` (PR #17)
- [x] Studio video mode (Phase 1.2a of video) — `batch/wan22-studio-video-mode` (PR #18)
- [x] Queue UX: concurrency, tray, notifications, refresh survivability (Phase 1.2b of video) — `batch/wan22-queue-ux` (PR #19)
- [x] Gallery video support (Phase 1.3 of video) — `batch/wan22-gallery-video` (PR #20)
- [x] Honest disk-avoidance grep guard (i2v template fix) — `batch/wan22-template-loadimage-fix` (PR #21)
- [x] Refresh survivability fix (abort vs disconnect) — `batch/wan22-refresh-survivability-fix` (PR #22)
- [~] Wire abortJob to ComfyUI /interrupt — `batch/wan22-abort-comfyui-interrupt` (PR #23)
