# Batch — Configuration to .env

Pull every hardcoded operational constant out of `.ts` and into `.env`. Existing env vars remain. Two structural changes alongside the move:

1. **Separate output directories per media type.** `IMAGE_OUTPUT_DIR` currently holds images, videos, and stitched outputs. Split into three: images, raw video clips, stitched/composed videos. Directories may overlap if the user wants — but the *capability* to split them must exist.
2. **Documentation in `.env.example`.** Every variable gets a comment explaining what it does, what format it expects, and what happens if it's wrong/missing. Self-documenting config is the goal.

Re-read CLAUDE.md before starting. Use `project_knowledge_search` to verify every constant location before changing it; the inventory below is grounded in code as of this prompt's writing but the agent is the verifier.

---

## What needs to move to .env

### 1. Output directories — split into three

**Current:** all generated files (images, raw video clips, stitched outputs) land in `IMAGE_OUTPUT_DIR`.

**New:**

```
IMAGE_OUTPUT_DIR=/home/<your-user>/illustrator-output/images       # PNG outputs from image generation
VIDEO_OUTPUT_DIR=/home/<your-user>/illustrator-output/clips        # webm outputs from video generation (raw clips)
STITCH_OUTPUT_DIR=/home/<your-user>/illustrator-output/videos      # mp4 outputs from project stitching (composed videos)
```

The default values shown above are illustrative — the user will set their own absolute paths. The point is that three separate variables exist, and code paths for each media type read the appropriate one.

The `/api/images/<filename>` URL path remains the single way to serve any of the three on the frontend. The static-file route at `src/app/api/images/[filename]/route.ts` needs to look across all three directories to resolve a request, not just the image directory.

**Concrete code changes:**

- `src/lib/comfyws.ts` `finalizeImageJob` — reads `IMAGE_OUTPUT_DIR`. Stays as-is (still images).
- `src/lib/comfyws.ts` `finalizeVideoJob` — currently uses `videoParams.outputDir`, which is the route-passed value. The route needs updating to pass `VIDEO_OUTPUT_DIR` instead of `IMAGE_OUTPUT_DIR`.
- `src/app/api/generate-video/route.ts` — change the `outputDir` derivation from `process.env.IMAGE_OUTPUT_DIR` to `process.env.VIDEO_OUTPUT_DIR`. Add a 500 fail-closed check for the new variable.
- `src/app/api/projects/[id]/stitch/route.ts` — change `outputDir` from `IMAGE_OUTPUT_DIR` to `STITCH_OUTPUT_DIR`. Add a 500 fail-closed check.
- `src/app/api/extract-last-frame/route.ts` — uses `IMAGE_OUTPUT_DIR` to resolve a video file's local path. The video files live in `VIDEO_OUTPUT_DIR` after this batch, so this needs the new variable. **But wait** — extract-last-frame may target a stitched output too (the picker shows stitched videos as candidates per the Phase 2.3 follow-up bundle). The route needs to figure out which directory a given `Generation` row's file lives in. Cleanest: derive from `mediaType` + `isStitched`:

  ```ts
  function dirForGeneration(g: { mediaType: string; isStitched?: boolean }): string {
    if (g.mediaType === 'image') return process.env.IMAGE_OUTPUT_DIR ?? '';
    if (g.isStitched) return process.env.STITCH_OUTPUT_DIR ?? '';
    return process.env.VIDEO_OUTPUT_DIR ?? '';
  }
  ```

- `src/app/api/generation/[id]/route.ts` (DELETE handler) — same logic. To unlink a file, derive the directory from the row's media type + isStitched.
- `src/app/api/images/[filename]/route.ts` — static file serving. Currently reads `IMAGE_OUTPUT_DIR`. After this batch it needs to **try all three directories** (in order: images, clips, videos) and serve whichever has the file. Since filenames are unique slugs + timestamps, collision is essentially impossible. If no directory has the file, return 404. Document the search order in code comments.

  Alternative cleaner pattern: when creating the DB row at finalize time, store an additional `mediaCategory: 'image' | 'clip' | 'stitch'` field that the static-serve handler uses to pick the right directory. But that's a schema migration just to avoid a 3-way fs check; too much for this batch. The "try each directory" pattern is fine for single-user volume.

- `prompts/extract-last-frame/route.ts` (already grep-confirmed at `src/app/api/extract-last-frame/route.ts`) — handle the path-traversal guard against the resolved directory, not the static `IMAGE_OUTPUT_DIR`.

The migration concern: existing files. The user has files in the current `IMAGE_OUTPUT_DIR`. After this batch, image files stay there (the env var name doesn't change for that case), but video and stitched files would conceptually belong elsewhere — but they're currently in `IMAGE_OUTPUT_DIR`. **Don't auto-move existing files.** Document the migration step in the PR description: "If you split your output directories, manually move existing video files (.webm) and stitched files (stitched_*.mp4) to their new homes; otherwise they'll 404 in the gallery." Or instruct the user to keep `VIDEO_OUTPUT_DIR` and `STITCH_OUTPUT_DIR` pointing at the same path as `IMAGE_OUTPUT_DIR` initially, then migrate at their leisure.

### 2. Watchdog timeouts — promote to env

`src/lib/comfyws.ts` has:

```ts
const IMAGE_JOB_TIMEOUT_MS = 10 * 60 * 1000;
const VIDEO_JOB_TIMEOUT_MS = 15 * 60 * 1000;
const RECENT_COMPLETED_TTL_MS = 5 * 60 * 1000;
```

And `registerStitchJob` has `5 * 60 * 1000` baked into a default arg.

Promote to:

```
IMAGE_JOB_TIMEOUT_MS=600000        # 10 min — image generation watchdog
VIDEO_JOB_TIMEOUT_MS=900000        # 15 min — video generation watchdog
STITCH_JOB_TIMEOUT_MS=300000       # 5 min — stitch watchdog
RECENT_COMPLETED_TTL_MS=300000     # 5 min — how long completed jobs stay queryable for refresh recovery
```

Read with sensible defaults that match current values. The pattern:

```ts
const IMAGE_JOB_TIMEOUT_MS = Number(process.env.IMAGE_JOB_TIMEOUT_MS) || 10 * 60 * 1000;
```

`Number(undefined) === NaN`, `NaN || X === X`, so missing env falls through to default. `Number('600000') === 600000`, normal case works. `Number('abc') === NaN`, fallback handles malformed values. Edge case: `Number('0') === 0`, falsy — hits the default. That's acceptable; no one wants a 0ms timeout.

### 3. Polish timeout and sampling — promote to env

`src/app/api/generate/polish/prompt.ts`:

```ts
export const POLISH_TIMEOUT_MS = 30_000;
export const POLISH_SAMPLING = {
  temperature: 0.15,
  top_p: 0.9,
  repeat_penalty: 1.05,
  max_tokens: 600,
} as const;
```

These are tuning parameters. Worth surfacing:

```
POLISH_TIMEOUT_MS=30000              # 30 s — polish LLM call timeout
POLISH_TEMPERATURE=0.15              # LLM sampling temperature for polish
POLISH_TOP_P=0.9                     # LLM top-p
POLISH_REPEAT_PENALTY=1.05
POLISH_MAX_TOKENS=600
```

Read in the prompt file as `Number(process.env.X) || default`. Keep the `as const` shape for `POLISH_SAMPLING` even when reading from env — define a function that returns the object instead of a top-level const, or compute once at module load. The latter is fine; values don't change at runtime.

### 4. Gallery page size

`.env.example` already lists `GALLERY_PAGE_SIZE=30`. Verify it's actually being read everywhere page sizes appear, not just in `/api/gallery`. Particular places to check: `/api/projects/[id]` route (might paginate), Studio's lookup of recent generations (if any). If there are other hardcoded page sizes (default 20, 30, 50), align them on `GALLERY_PAGE_SIZE` or surface their own env var.

Use `project_knowledge_search` to find them. This is exploratory — if nothing comes up, that's fine.

### 5. ComfyUI poll interval

The queue UX polls `/api/jobs/active` every 5 seconds (per Phase 1.2b). This is hardcoded. Surface:

```
QUEUE_POLL_INTERVAL_MS=5000          # how often the client polls /api/jobs/active for queue updates
```

Read in `QueueContext.tsx` (or wherever the polling lives). Default 5000.

### 6. SSH paths — prefix as env

The various SSH-using routes hardcode `/models/ComfyUI/models/checkpoints/`, `/models/ComfyUI/models/loras/`, `/models/ComfyUI/models/embeddings/`. These are operational paths on the VM that don't change between users *of this app*, but might if the user reinstalls ComfyUI elsewhere or runs a second instance. Surface a single root:

```
COMFYUI_MODELS_ROOT=/models/ComfyUI/models    # base path for model files on the VM
```

Used as: `${COMFYUI_MODELS_ROOT}/checkpoints/`, `${COMFYUI_MODELS_ROOT}/loras/`, etc.

Same `Number()` / `?? ''` pattern as other env vars. Fail closed at the route level if missing.

There's also the `/models/ComfyUI/output/` path used by the SSH cleanup glob in `comfyws.ts`. Surface:

```
COMFYUI_OUTPUT_PATH=/models/ComfyUI/output    # where ComfyUI writes generated files on the VM (used for SSH cleanup glob)
```

### 7. Verify add_model.sh constants

`add_model.sh` has its own `VM_USER`, `VM_IP`, `SSH_KEY` reads from environment plus inline paths. It already uses env-driven config but the bash idioms might leak hardcoded fallbacks. Worth a pass.

The bash script also derives `REMOTE_PATH` from `/models/ComfyUI/models/loras/` and `/models/ComfyUI/models/checkpoints/` — these should now read from the `COMFYUI_MODELS_ROOT` env var if available, fall back to current hardcoded paths if not.

### 8. Next.js port

Where the app binds (`mint-pc:3001`) — check `package.json`, `ecosystem.config.js`, etc. If the port is hardcoded in any TS code (not just config files), surface as `NEXT_PORT` or similar. Probably fine as-is in `package.json`'s start script; just verify nothing in `src/` reads it directly.

---

## `.env.example` documentation pass

Rewrite `.env.example` with comments above every variable explaining:
- What it is.
- What format/units.
- What happens if it's missing or malformed.
- Sensible default value.

Format pattern:

```
# Database connection string. Postgres only. Required — app fails to start without it.
DATABASE_URL="postgresql://postgres:password@localhost:5432/illustrator"

# Absolute path on mint-pc where image generations are written.
# Must exist and be writable. App throws on any image generation if unset.
# Outside the repo — files are large and shouldn't pollute git.
IMAGE_OUTPUT_DIR=/home/<your-user>/illustrator-output/images

# Absolute path where raw video clips (.webm) from Wan 2.2 generation land.
# Must exist and be writable. May be the same as IMAGE_OUTPUT_DIR if you don't
# want them split. App throws on video generation if unset.
VIDEO_OUTPUT_DIR=/home/<your-user>/illustrator-output/clips

# Absolute path where project stitch outputs (.mp4) land.
# Must exist and be writable. May overlap with VIDEO_OUTPUT_DIR if desired.
# App throws on stitch start if unset.
STITCH_OUTPUT_DIR=/home/<your-user>/illustrator-output/videos

# Number of items per page for gallery infinite-scroll pagination.
# Default 30. Cap of 100 enforced server-side regardless.
GALLERY_PAGE_SIZE=30

# ComfyUI HTTP endpoint. Reached via SSH tunnel on localhost.
# Used for image generation, video file fetch (/view), embeddings list, /interrupt, queue mgmt.
# If missing, defaults to http://127.0.0.1:8188 (matches the standard tunnel port).
COMFYUI_URL=http://127.0.0.1:8188

# ComfyUI WebSocket endpoint. Reached via SSH tunnel on localhost.
# Used for streaming generation progress and binary image frames.
# If missing, defaults to ws://127.0.0.1:8188.
COMFYUI_WS_URL=ws://127.0.0.1:8188

# CivitAI API token. Get from civitai.com → Account Settings → API.
# Used by add_model.sh and /api/models/ingest to download model files.
# Required for ingest; routes return 500 if unset.
CIVITAI_TOKEN="paste-token-from-civitai-account-settings"

# SSH credentials for the A100 VM. Used for model downloads, embeddings list,
# model deletion, and SSH cleanup of orphan video files.
# All three are required for any SSH-using route; they fail with 500 if missing.
A100_VM_USER=<your-vm-user>
A100_VM_IP=<gpu-vm-ip>
A100_SSH_KEY_PATH=/home/<your-user>/.ssh/gpu-key.pem

# Root directory of ComfyUI's models on the VM. Used for checkpoint/LoRA/embedding paths.
# If missing, defaults to /models/ComfyUI/models (standard install location).
COMFYUI_MODELS_ROOT=/models/ComfyUI/models

# ComfyUI's output directory on the VM. Used for the SSH cleanup glob that
# removes orphan video files after generation completion or abort.
# If missing, defaults to /models/ComfyUI/output.
COMFYUI_OUTPUT_PATH=/models/ComfyUI/output

# LLM endpoint for prompt polish. Reached via SSH tunnel on localhost.
# OpenAI-compatible chat-completions API expected.
# Required when the Polish button is used; route returns 200 with polished:false
# (graceful degradation) if unset or unreachable.
LLM_ENDPOINT=http://127.0.0.1:11438/v1/chat/completions

# Model identifier or path passed to the LLM endpoint as the `model` field.
# What this looks like depends on what's serving — for llama-server it's the .gguf path.
# Required when LLM_ENDPOINT is set; missing means polish requests fail with llm_error.
POLISH_LLM_MODEL=/path/to/your/model.gguf

# Polish call timeout in milliseconds. Default 30_000 (30 seconds).
# If polish takes longer, the client gets polished:false / reason:'timeout'.
POLISH_TIMEOUT_MS=30000

# Polish LLM sampling parameters. Defaults match what was tuned during polish development.
# temperature: lower = more deterministic, higher = more creative.
# top_p: nucleus sampling threshold.
# repeat_penalty: discourages repetition.
# max_tokens: ceiling on polish response length.
POLISH_TEMPERATURE=0.15
POLISH_TOP_P=0.9
POLISH_REPEAT_PENALTY=1.05
POLISH_MAX_TOKENS=600

# Watchdog timeouts in milliseconds. A job sitting longer than this gets force-aborted.
# Defaults match historical hardcoded values.
# Stitch is shorter because ffmpeg on mint-pc is fast; video is longer because GPU work varies.
IMAGE_JOB_TIMEOUT_MS=600000
VIDEO_JOB_TIMEOUT_MS=900000
STITCH_JOB_TIMEOUT_MS=300000

# How long a completed job stays queryable via /api/jobs/active for refresh-recovery.
# Default 5 min — long enough to reattach the queue tray after a normal page reload.
RECENT_COMPLETED_TTL_MS=300000

# How often the queue tray polls /api/jobs/active for updates while jobs are active.
# Lower = more responsive, higher = less server load.
QUEUE_POLL_INTERVAL_MS=5000
```

The agent should arrive at this shape from the inventory above. Adjust formatting to whatever conventions `.env.example` already follows (comment style, blank lines between groups, etc.). The point is: every variable is documented in plain English, the user could read just `.env.example` and know what to do.

---

## Acceptance criteria

- `npm run build` passes clean.
- `grep -rn "class_type.*['\"]SaveImage['\"]" src/` returns only SaveImageWebsocket.
- `grep -rn "class_type.*['\"]LoadImage['\"]" src/` returns only ETN_LoadImageBase64 / ETN_LoadMaskBase64.
- `grep -rn "10 \* 60 \* 1000\|15 \* 60 \* 1000\|5 \* 60 \* 1000\|30_000" src/` returns no matches in production code paths (the constants now come from env).
- `grep -rn "/models/ComfyUI/models/" src/` returns no hardcoded matches in `.ts` files (only in env-derived strings).
- `grep -rn "/models/ComfyUI/output" src/` returns no hardcoded matches in `.ts` files.
- `grep -rn "IMAGE_OUTPUT_DIR" src/` shows the variable still in use for image-related code paths only (not for video or stitch).
- `grep -rn "VIDEO_OUTPUT_DIR" src/` shows the variable in use in `comfyws.ts`'s video finalization and `/api/generate-video/route.ts`.
- `grep -rn "STITCH_OUTPUT_DIR" src/` shows the variable in use in `/api/projects/[id]/stitch/route.ts`.
- `.env.example` has comments above every variable explaining purpose, format, default, and missing-value behavior.
- `npm run dev` starts cleanly with the existing `.env` (the env vars are backwards-compatible — old setups keep working).
- `git log --oneline -1 origin/<branch>` shows the agent's commit.

Manual smoke test (deferred to user):

1. Start with the existing `.env`. Confirm app still works end-to-end (image gen, video gen, stitch).
2. In `.env`, set `VIDEO_OUTPUT_DIR=/home/<your-user>/illustrator-output/clips` (different from `IMAGE_OUTPUT_DIR`). Restart pm2. Generate a video. Confirm the .webm file lands in the new directory and is playable in the gallery.
3. Set `STITCH_OUTPUT_DIR=/home/<your-user>/illustrator-output/videos`. Restart. Stitch a project. Confirm the .mp4 lands in the new directory and is playable.
4. Comment out `VIDEO_OUTPUT_DIR`. Restart. Try to generate a video — confirm 500 with the documented error.
5. Set `POLISH_TIMEOUT_MS=1000` (1 second). Restart. Click Polish. Confirm timeout fires (the LLM won't respond in 1s) and the UI shows a graceful timeout message.
6. Read `.env.example` cold. Confirm comments are clear enough that a hypothetical new user could fill in the file without reading source code.

---

## Out of scope

- A migration script to move existing files between the new directory variables. Manual move is the user's responsibility (documented in PR description).
- `mediaCategory` schema field for static-serve disambiguation. The "try each directory" pattern is enough for now.
- Promoting existing-but-uncommented constants in third-party places (Prisma's connection string parameters, Next.js's Webpack config, etc.). Scope is operational config that affects how the app runs.
- Making `COMFYUI_URL` and friends fail closed if missing. They have sensible defaults (`http://127.0.0.1:8188`); don't break the existing pattern. Only the SSH-using ones fail closed.
- Adding env vars for the queue tray's auto-dismiss timing, the toast duration, etc. UI timing constants stay in code unless the user requests otherwise.
- Any change to ecosystem.config.js. PM2 process management stays as configured.
- Backporting the new comments in `.env.example` to existing user-side `.env` files. Users update their own.

---

## Documentation

In CLAUDE.md, find the "Environment" section. Update the env var listing to match the new `.env.example`. Maintain the existing pattern (var = value comment style) but expand each entry with the same plain-English explanation as in `.env.example`.

Add a short paragraph at the top of the Environment section:

> `.env` is the single source of truth for operational config. Every var has a comment in `.env.example` explaining its purpose, format, default, and missing-value behavior. The general pattern: SSH-related vars (VM_*, SSH_KEY) fail closed with a 500 if missing; HTTP endpoint vars have sensible localhost defaults; numeric tuning vars (timeouts, page sizes) have documented defaults that match historical hardcoded values.

When done, push and create the PR via `gh pr create` per AGENTS.md.

**Final acceptance — verify before declaring done:** `git log --oneline -1 origin/<your-branch>` MUST show your commit. If it doesn't, you haven't pushed. Push, then verify again.
