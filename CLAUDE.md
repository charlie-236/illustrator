# Illustrator

Mobile-first ComfyUI generation frontend. Next.js 14 App Router, Tailwind CSS, Prisma + PostgreSQL. Runs locally via PM2 on port **3001**. ComfyUI backend is tunneled to `localhost:8188`.

---

## 🛑 CRITICAL ARCHITECTURE RULES

### 1. The Disk-Avoidance Constraint (was "WebSocket Constraint")
The remote A100 VM has severely limited disk space. ComfyUI must NEVER write generation files to local storage in either direction.

Outputs: Use SaveImageWebsocket only. Never SaveImage.
Inputs (reference images): Use ETN_LoadImageBase64 only. Never LoadImage (requires prior upload to disk) or /upload/image API (writes to disk).
Defense-in-depth: ram-sweeper service catches anything that slips through, deleting files in /output/, /temp/ and /input/ on a 60-second window. The application-level rules above are the authoritative protection; ram-sweeper is the safety net.

Validation: after any buildWorkflow() workflow change, scan the generated workflow JSON for these forbidden class_types: SaveImage, LoadImage. Only SaveImageWebsocket and ETN_LoadImageBase64 are permitted as the I/O nodes.

Runtime enforcement: the `/api/generate` route includes a structural assertion that iterates every node in the built workflow and returns HTTP 500 with a "this is a bug" message if `SaveImage` or `LoadImage` appears as a `class_type`. This catches future regressions automatically — a forbidden node causes a loud failure rather than a silent disk write on the VM.

### 2. General Agent Directives
- Before proposing any fix, verify it aligns with the `SaveImageWebsocket` requirement.
- If a package update or ComfyUI node change breaks the WebSocket relay, fixing the relay takes priority over all UI/UX features.

### 3. Tablet-first application
This is a tablet-first application. Every interactive element MUST have a minimum touch target of 48x48 pixels. Use Tailwind classes like min-h-12, min-w-12, p-3, or p-4 to ensure they are easily tappable.

### 4. Model filename obfuscation

Model filenames (LoRAs, checkpoints, embeddings) are obfuscated at ingest time. `civitaiIngest.ts` generates a 6-byte hex stem via `randomBytes(6).toString('hex')`; the file lands on disk as `<hex>.safetensors`; `LoraConfig.loraName` (and equivalents for checkpoints/embeddings) stores that obfuscated string. The user-visible identifier everywhere — UI rows, picker labels, workflow `_meta.title`, logs, error messages — is `friendlyName`. The **only** place the obfuscated `loraName` appears observably is the `lora_name` field of `LoraLoader` / `LoraLoaderModelOnly` nodes in workflow JSON sent to ComfyUI, where it's required for ComfyUI to resolve the on-disk file. When `friendlyName` is unavailable (e.g., a LoraEntry assembled from a legacy record without metadata), the fallback display string is `'(unknown LoRA)'` — never the raw obfuscated `loraName`.

### 5. Network & API Routing Rules
All communication between the Next.js frontend/backend and the A100 Core VM MUST route through the established local SSH tunnels. The Next.js API should NEVER attempt to contact `100.96.99.94` directly. 

Use the following `localhost` / `127.0.0.1` ports for all fetch requests:
* **ComfyUI (Image Generation):** `http://127.0.0.1:8188`
* **LLM / Prompt Polish:** `LLM_ENDPOINT` env var (typically `http://127.0.0.1:11438/v1/chat/completions`)
---

## Environment

`.env` is the single source of truth for operational config. Every var has a comment in `.env.example` explaining its purpose, format, default, and missing-value behavior. The general pattern: SSH-related vars (`A100_*`, `A100_SSH_KEY_PATH`) fail closed with a 500 if missing; HTTP endpoint vars have sensible localhost defaults; numeric tuning vars (timeouts, page sizes) have documented defaults that match historical hardcoded values.

```
DATABASE_URL=postgresql://...              # local Postgres — required, no default

# Output directories — must exist and be writable. May all point to the same path.
IMAGE_OUTPUT_DIR=/home/charlie/illustrator-output/images   # PNG outputs from image generation
VIDEO_OUTPUT_DIR=/home/charlie/illustrator-output/clips    # .webm outputs from video generation
STITCH_OUTPUT_DIR=/home/charlie/illustrator-output/videos  # .mp4 outputs from project stitching

GALLERY_PAGE_SIZE=30                       # records per page (default 30, server cap 100)

COMFYUI_URL=http://127.0.0.1:8188          # ComfyUI HTTP API (default: 127.0.0.1:8188)
COMFYUI_WS_URL=ws://127.0.0.1:8188         # ComfyUI WebSocket (default: 127.0.0.1:8188)

CIVITAI_TOKEN=...                          # CivitAI API token — required for model ingest
A100_VM_USER=charlie                       # SSH username for the Azure VM — fail-closed
A100_VM_IP=100.96.99.94                    # Tailscale IP of the Azure VM — fail-closed
A100_SSH_KEY_PATH=/home/charlie/.ssh/a100-key.pem  # Private key for VM SSH — fail-closed

COMFYUI_MODELS_ROOT=/models/ComfyUI/models # Base path for model files on the VM (default shown)
COMFYUI_OUTPUT_PATH=/models/ComfyUI/output # VM output dir for SSH cleanup glob (default shown)

LLM_ENDPOINT=http://127.0.0.1:11438/v1/chat/completions  # Polish LLM endpoint
POLISH_LLM_MODEL=/path/to/model.gguf       # Model identifier for the LLM endpoint

# Polish tuning — all have defaults matching historical values
POLISH_TIMEOUT_MS=30000                    # LLM call timeout (default 30 s)
POLISH_TEMPERATURE=0.15
POLISH_TOP_P=0.9
POLISH_REPEAT_PENALTY=1.05
POLISH_MAX_TOKENS=600

# Job watchdog timeouts — default to historical hardcoded values
IMAGE_JOB_TIMEOUT_MS=600000                # 10 min
VIDEO_JOB_TIMEOUT_MS=900000                # 15 min
STITCH_JOB_TIMEOUT_MS=300000               # 5 min
RECENT_COMPLETED_TTL_MS=300000             # 5 min — completed jobs stay in /api/jobs/active

# Client-side queue polling (NEXT_PUBLIC_ required for browser access)
NEXT_PUBLIC_QUEUE_POLL_INTERVAL_MS=5000    # default 5 s
```

First-time setup:
```bash
cp .env.example .env   # fill in DATABASE_URL
npx prisma generate
npx prisma db push
npm run build
pm2 start ecosystem.config.js && pm2 save
```

Subsequent deploys: `npm run build && pm2 restart illustrator`

## System dependencies

**ffmpeg** is required on `mint-pc` for last-frame extraction (Phase 2.2) and video stitching (Phase 3).

```bash
sudo apt-get install -y ffmpeg
ffmpeg -version  # confirm ≥ 4.x
```

ffmpeg is called server-side by `POST /api/extract-last-frame` via Node's `child_process.execFile`. It never writes to disk — frames are piped to stdout and base64-encoded in memory.

## Infrastructure

| Machine | Role |
|---------|------|
| `mint-pc` | Local Linux desktop. Hosts Next.js (port 3001), PostgreSQL, and the PM2 SSH tunnel. Reachable from the tablet over Wi-Fi. |
| `a100-core` | Azure VM, 4× A100 GPUs. Runs ComfyUI on port 8188. Bound to Tailscale only — no public internet exposure. Tailscale IP: `100.96.99.94`. |

**The tunnel** is a PM2-managed process on `mint-pc`:
```bash
ssh -N -L 0.0.0.0:8188:100.96.99.94:8188 charlie@100.96.99.94
```
This forwards `mint-pc:8188` → `a100-core:8188` over Tailscale, so the Next.js backend talks to ComfyUI via `127.0.0.1:8188` as if it were local.

**Do not suggest changes to the Azure VM or Tailscale setup.** Treat `127.0.0.1:8188` as a black-box API endpoint.

## Architecture overview

```
Browser → POST /api/generate → ComfyUI /prompt  (returns promptId)
Browser → GET  /api/progress/[promptId] (SSE)
                     ↕
          global.__comfyWSManager  ←→  ws://localhost:8188/ws
                     ↓ on execution_success
          writes PNG to IMAGE_OUTPUT_DIR (absolute path outside repo)
          inserts row into Generation table
          pushes SSE 'complete' event to browser
```

**Why no SaveImage:** disk space is at a premium on the remote VM. The workflow uses `SaveImageWebsocket` (built-in ComfyUI node) as the terminal node instead. It streams the full-quality PNG over the WebSocket without writing to the remote output folder.

## Key design decisions

### Global WebSocket singleton (`src/lib/comfyws.ts`)

`global.__comfyWSManager` holds a single `ComfyWSManager` instance that persists across requests. The `global.*` pattern prevents hot-reload from creating duplicate connections in dev.

- Connects to ComfyUI WS with a stable `clientId` (UUID generated once at startup). The `client_id` is passed in every `/prompt` POST so ComfyUI routes events back to this client only.
- Reconnects automatically after 4 s on drop; increments `reconnectAttempts`.
- On reconnect (`reconnectAttempts > 0`), calls `flushJobsOnReconnect()` (async, fire-and-forget). For each pending job it fetches `/history/{promptId}` from ComfyUI (5 s timeout): `status_str === 'success'` → the prompt finished but the binary frame was lost into the dead socket — send a "completed but image lost, please retry" error SSE; `status_str === 'error'` → send a "failed on GPU server" error SSE; anything else (empty response, still running, fetch failure) → **leave the job in place** so events can resume on the new connection. A 10-minute per-job watchdog (`expireJob`) reaps any job that goes permanently silent.
- `execution_success` **and** `executing` with `node === null` are both treated as end-of-prompt terminators, so older ComfyUI builds that omit `execution_success` still finalize correctly. A `finalized` flag on each job prevents double-finalization if both arrive.
- Binary image frames are routed to the active job via the manager's `activePromptId` field, which is set from `executing` events (non-null node → set to that prompt_id; null node → clear). The per-job `activeNode` field is still used by the `executing` handler to distinguish progress events from terminators, but no longer drives binary routing.

### Binary image extraction

ComfyUI binary frames carry a format-type word at bytes 4–7 (BE uint32): `2` = PNG (emitted by `SaveImageWebsocket`), `1` = JPEG (live previews from taesd/latent2rgb/auto). `parseImageFrame()` reads that byte, slices from offset 8, and verifies the image magic bytes. If magic doesn't match the declared format it falls back to scanning the first 32 bytes — defensive against protocol drift. JPEG preview frames are dropped at the call site (`onBinary`); only PNG frames are pushed to `imageBuffers`. A `// TODO` marks where JPEG frames should be forwarded to a `preview` SSE event once live previews are wired up.

### SSE job registration split

`POST /api/generate` builds and submits the workflow, gets back `promptId` + `resolvedSeed`, calls `manager.stashJobParams(promptId, params, resolvedSeed)` to store the params server-side (with a 60-second TTL and `baseImage`/`denoise` stripped), and returns immediately. The browser then opens `GET /api/progress/[promptId]` (no query params) which calls `manager.registerJob(promptId, controller)`. `registerJob` looks up and deletes the stashed entry, populating the `Job` record; if the entry has expired or is missing it sends an `error` SSE and closes. This avoids round-tripping `GenerationParams` through the URL, which would exceed header limits when a base image (~1–4 MB base64) is attached.

### Seed resolution

`params.seed === -1` means random. The seed is resolved inside `buildWorkflow()` via `Math.floor(Math.random() * 2**32)` and embedded directly into the KSampler node. `buildWorkflow` returns `{ workflow, resolvedSeed }` — the seed is returned directly from the same scope where it was generated, not extracted from the node graph after the fact. The resolved seed travels: `buildWorkflow()` return value → `/api/generate` response → `stashJobParams()` → `registerJob()` → `prisma.generation.create()`.

**Video seed resolution** mirrors the image-side contract: `params.seed === -1` means random, resolved inside `/api/generate-video` via `Math.floor(Math.random() * 2**32)` and embedded in both `KSamplerAdvanced` nodes (57 and 58) of the Wan 2.2 workflow. Writing to both samplers is defensive — node 58 has `add_noise: "disable"` so the seed is conceptually unused, but the template's literal `0` stays out of the workflow JSON entirely as a result. The resolved seed is emitted in the SSE `init` event as `resolvedSeed` (parity with `/api/generate`'s response field) and persisted to the DB row's `seed` column at finalize time.

### BigInt serialization

Prisma returns `seed` as `BigInt`. All API routes that return generation records call `.toString()` on it before serialising to JSON. `GenerationRecord.seed` is typed as `string` on the client side.

## Database

Single model. `npx prisma db push` to apply schema changes (no migration files).

```prisma
model Generation {
  id           String   @id @default(cuid())
  filePath     String           // e.g. /api/images/slug_1714000000000.png
  promptPos    String           // user's typed positive prompt (stored as-is for remix)
  promptNeg    String           // user's typed negative prompt
  model        String           // checkpoint filename
  lora         String?          // human-readable summary, e.g. "name (1.00), name2 (0.80)"
  lorasJson    Json?            // structured: [{name: string, weight: number}, ...] or null
  assembledPos String?          // final positive sent to ComfyUI (defaults + triggers + user); null for legacy records
  assembledNeg String?          // final negative sent to ComfyUI; null for legacy records
  seed         BigInt
  cfg          Float
  steps        Int
  width        Int
  height       Int
  sampler      String
  scheduler    String
  highResFix   Boolean
  videoLorasJson Json?    // WanLoraSpec[] for video; null for image and legacy
  lightning      Boolean? // true for Wan 2.2 Lightning; null for image and legacy
  createdAt    DateTime @default(now())
  @@index([createdAt(sort: Desc)])
}
```

**LoRA storage**: `lora` is the human-readable display string written by `finalizeJob`. `lorasJson` is the canonical structured form (`LoraEntry[]`) used for remix — `recordToParams` prefers `lorasJson` and falls back to parsing the string via `parseLoras` for legacy records.

**Assembled prompts**: The DB stores both the user's typed prompts (`promptPos`/`promptNeg`) and the assembled-with-defaults-and-triggers versions sent to ComfyUI (`assembledPos`/`assembledNeg`). Remix uses the typed prompts so the user can edit them; the assembled fields are forensic-only for now. Legacy records will have `null` for these fields.

## API routes

### `POST /api/generate`
Body: `GenerationParams` JSON.
1. Calls `buildWorkflow(params)` → ComfyUI API-format workflow object.
2. POSTs `{ prompt: workflow, client_id }` to `http://localhost:8188/prompt`.
3. Returns `{ promptId: string, resolvedSeed: number }`.
- No timeout on the ComfyUI fetch — ComfyUI usually responds immediately with a queue ID.
- Optional `projectId`: if present, validated against DB (must reference an existing project). The resulting `Generation` row gets `projectId` set and `position` auto-computed as `max(existing positions in this project) + 1`, mirroring the video-side behaviour.

### `GET /api/progress/[promptId]`
Returns an SSE stream. Calls `manager.registerJob(promptId, controller)`. Params and seed are looked up from the server-side stash populated by `/api/generate`.

SSE events emitted by the manager:
| event | data shape |
|-------|-----------|
| `progress` | `{ value: number, max: number }` |
| `complete` | `{ records: GenerationRecord[] }` |
| `error` | `{ message: string }` |

### `GET /api/models`
Returns `{ checkpoints: string[], loras: string[], embeddings: string[] }`. Checkpoints and LoRAs come from ComfyUI's `/object_info/CheckpointLoaderSimple` and `/object_info/LoraLoader`. Embeddings come from ComfyUI's `/embeddings` endpoint (returns on-disk filenames from `/models/ComfyUI/models/embeddings/`, sorted alphabetically). All three fetches use a 5-second `AbortSignal.timeout`. On any failure the entire route returns HTTP 502 — embeddings intentionally do not degrade to an empty array so that a VM connectivity problem is visible rather than silently showing an empty list.

### `POST /api/generate/polish`
LLM-powered prompt expansion with frozen-token validation. Body: `{ positivePrompt: string, negativeAdditions?: string }` (max 500 chars on additions). Returns `{ positive: string, negative: string, polished: boolean, reason?: 'weight_drift' | 'llm_error' | 'timeout' | 'parse_error' }`.

Calls `LLM_ENDPOINT` (set in `.env`; the local llama-server tunnel) with the model identifier from `POLISH_LLM_MODEL`. Uses a 30-second `AbortSignal` timeout.

The system prompt instructs the model to copy weighted tokens like `(eyes:1.5)`, `((rain))`, and `[[lora_name]]` byte-for-byte and append 15–20 new descriptive tags. After the LLM responds, `validatePreservation()` checks every frozen token from the user's input appears as an exact substring in the output. On weight drift the route retries once; on second failure it falls back to returning the user's original prompt with `polished: false` and a `reason` string explaining why.

The negative prompt is always a fixed `STATIC_NEGATIVE` string (defined in `prompt.ts`); user-supplied `negativeAdditions` are appended after it. The LLM cannot influence the negative prompt.

On any LLM failure (timeout, HTTP error, parse error), the route returns HTTP **200** with `polished: false` rather than an error status — this lets the UI degrade gracefully without breaking the generation flow. Tapping Polish on a failed call leaves the user's prompt visible and unchanged.

The `✨ Polish` button in PromptArea (positive prompt only) calls this route. See `src/app/api/generate/polish/prompt.ts` for the full system prompt and sampling config (`temperature: 0.15`, `top_p: 0.9`, `repeat_penalty: 1.05`, `max_tokens: 600`), and `src/app/api/generate/polish/validate.ts` for the frozen-token regex set.

### `POST /api/services/control`
SSH-based remote service control. Body: `{ serviceName: string, action: 'start' | 'stop' }`.

Opens a NodeSSH connection to `A100_VM_IP` using `A100_SSH_KEY_PATH`, then runs `sudo systemctl {action} {unit}`. Returns `{ ok: true }` on success or `{ ok: false, error: string }` if systemctl fails. Returns HTTP 500 on SSH connection failure.

Service name → systemctl unit mapping:
| serviceName | systemctl unit |
|---|---|
| `comfy-illustrator` | `comfy-illustrator.service` |
| `aphrodite-writer` | `aphrodite-writer` |
| `aphrodite-illustrator-polisher` | `aphrodite-illustrator-polisher` |

### `GET /api/services/status`
Combines two checks per service, run in parallel: (1) SSH `systemctl is-active <unit>` (process running) and (2) HTTP probe of the service's endpoint via the localhost SSH tunnel (process actually answering). Returns:

```ts
{ statuses: Record<ServiceName, 'ready' | 'loading' | 'inactive' | 'unknown'> }
```

- `inactive` — systemd reports the unit isn't active.
- `loading` — systemd active, HTTP probe failed or timed out (5 s). Typically means the model is still loading into VRAM.
- `ready` — systemd active and the probe returned 2xx.
- `unknown` — SSH itself failed; HTTP results aren't meaningful in that case (route returns HTTP 500).

Aphrodite services need an endpoint that exercises the loaded model — `/v1/models` returns 2xx as soon as the API server binds, before the model finishes loading into VRAM, so it can't be used as a readiness signal. ComfyUI loads lazily, so `/system_stats` (a process-level check) is sufficient.

Probe endpoints:
| Service | Probe URL |
|---|---|
| `comfy-illustrator` | `http://127.0.0.1:8188/system_stats` |
| `aphrodite-writer` | `http://127.0.0.1:21434/health` |
| `aphrodite-illustrator-polisher` | `http://127.0.0.1:11438/health` |

All probes go through mint-pc localhost tunnels. The writer (21434) and polisher (11438) tunnels must be live on mint-pc for their probes to succeed. ComfyUI (8188) shares the tunnel used by `/api/generate`. `ServiceName` is `'comfy-illustrator' | 'aphrodite-writer' | 'aphrodite-illustrator-polisher'`.

### `GET /api/gallery?page=1&limit=20`
Paginated. `limit` capped at 50. Returns:
```ts
{ items: GenerationRecord[], total: number, page: number, pages: number }
```

### `GET /api/generation/[id]`
Returns a single `GenerationRecord` or 404.

### `POST /api/models/register`
Called by `add_model.sh` after each successful download. Receives pre-fetched CivitAI metadata (fetched via the Azure VM proxy — the local Mint PC is geoblocked, the VM is not).

Body: `{ filename, type, modelId?, parentUrlId?, civitaiMetadata? }`

`civitaiMetadata` is the raw JSON object returned by `GET https://civitai.com/api/v1/model-versions/{id}`.

| CivitAI field | Prisma field | Notes |
|---|---|---|
| `civitaiMetadata.model.name` (or `.name`) | `friendlyName` | |
| `civitaiMetadata.trainedWords[]` joined by `, ` | `triggerWords` | LoRA only |
| `civitaiMetadata.baseModel` | `baseModel` | LoRA only |
| `civitaiMetadata.model.description` (or `.description`) | `description` | HTML stripped server-side |
| `parentUrlId` + `modelId` | `url` | `https://civitai.com/models/{parentUrlId}?modelVersionId={modelId}` |

Upserts into `CheckpointConfig` or `LoraConfig` based on `type`. Returns `{ ok: true, record }` on success. After ingestion, tap the Refresh button (↺) in the ModelSelect picker or ModelConfig header to reload the model lists — `revalidatePath` has no effect on client-side fetches and is not used here. Checkpoint width/height default to 1024; update in ModelConfig after ingestion if needed. Core upsert logic lives in `src/lib/registerModel.ts`; this route is a thin HTTP wrapper.

Each checkpoint config can store recommended generation defaults: steps, CFG, sampler, scheduler, width, height, and hi-res fix on/off. These are set via the collapsible **Default generation settings** section in ModelConfig's Checkpoints sub-tab. When the user explicitly selects a checkpoint in Studio's picker, any non-null defaults are soft-filled into the corresponding image-form fields. Null fields are left alone. Selection is soft-fill — choosing a second checkpoint applies only its own non-null defaults; it does not reset fields that had no default on the first checkpoint. The soft-fill fires only on an explicit user pick, not on the auto-selection that occurs at mount time (so a page refresh respects the user's last-session values). This applies to the image form only; the video form is unaffected.

Default resolution is a single value drawn from the canonical `RESOLUTIONS` list shared with Studio's image form. Width and height are persisted as separate columns but are saved and validated as a pair. Selecting "— No default —" sets both to null; the Studio resolution dropdown is then left unchanged when this checkpoint is selected.

### `POST /api/models/ingest`
SSE-streamed single-model ingestion. Body: `{ type: 'checkpoint' | 'lora', modelId: number, parentUrlId: number }`. Performs metadata fetch + download to A100 VM + size validation + DB upsert via SSH, emitting per-phase progress events. Used by the in-app ingestion UI; `add_model.sh` remains as a desktop fallback that posts to `/api/models/register` directly.

Phase events: `metadata`, `download`, `validate`, `register`, `done`, `error`. Error events may include an `orphanPath` field pointing to a file that exists on the VM but has no DB entry.

### `POST /api/models/ingest-batch`
Same as `/ingest` but accepts `{ items: [...] }` with up to 20 items. Each item extends the single-item body with a caller-supplied `clientId` string. Processes items sequentially and emits `item` events tagged with `clientId`, plus a final `summary` event with `{ succeeded, failed, total }`.

### `DELETE /api/models/[type]/[filename]`
Removes a checkpoint, LoRA, or embedding by filename. `type` is `'checkpoint' | 'lora' | 'embedding'`; filename is the on-disk filename including extension. SSH-deletes the file from the A100 VM via `rm -f` (idempotent) and removes any matching DB row via Prisma `deleteMany` (also idempotent). Used by ModelConfig's delete buttons. Works whether or not a DB row exists for the filename, so orphan files are deletable from the UI.

### `GET /api/projects`
Returns `{ projects: ProjectSummary[] }` ordered by `updatedAt DESC`. Each entry includes `clipCount` (via `_count`) and `coverFrame` (most-recent video clip's `filePath`).

### `POST /api/projects`
Creates a project. Validates `defaultFrames/Steps/Cfg/Width/Height` against the same Wan 2.2 rules as `/api/generate-video`. Returns 201 with the project object.

### `GET /api/projects/[id]`
Returns `{ project: ProjectDetail, clips: ProjectClip[] }`. Clips ordered by `position ASC, createdAt ASC`.

### `PATCH /api/projects/[id]`
Partial update. Same validation on default fields. Returns updated project or 404.

### `DELETE /api/projects/[id]`
Deletes project. Accepts optional `cascade=true` query parameter. Returns `{ ok: true }` (keep-items) or `{ ok: true, deletedItems: N, deletedStitches: M }` (cascade).

**`cascade=false` (default):** Runs a Prisma transaction that clears `position` on all member clips, then deletes the project row. DB `onDelete: SetNull` drops `projectId` on those clips. Items remain in gallery.

**`cascade=true`:** Aborts any in-flight jobs for this project (video and stitch jobs) via `abortJobsByProjectId`, deletes all source items and stitched exports from disk and DB in a transaction, then runs a straggler sweep to handle the abort-race edge case where a stitch ffmpeg completes between the abort signal and the main deleteMany. Individual file-delete errors log but don't abort the run.

Project deletion clears both `projectId` and `position` on member clips, in a single transaction. Client-side state holding the deleted project's ID is broadcast-cleared via a `project-deleted` CustomEvent so the Studio pill and any persisted sessionStorage references update immediately.

The delete dialog offers a cascade option: "Delete everything" removes source items, stitched exports made from the project, and aborts any in-flight related jobs before deletion. Default is the keep-items behavior — items drop to project-less state. The cascade path is non-transactional across filesystem and DB; individual file-delete errors log but don't abort the run, and a straggler sweep handles the abort-race edge case where a stitch ffmpeg completes between the abort signal and the main deleteMany.

### `PATCH /api/projects/[id]/reorder`
Body `{ clipOrder: string[] }`. Validates all IDs belong to this project and count matches. Updates `position` fields in a Prisma transaction. Returns `{ ok: true }` or 400 on validation failure.

### `POST /api/extract-last-frame`
Extracts the last frame of a video generation as a PNG data URI. Used by Studio when "Use last frame of previous clip" is checked.

Request body: `{ generationId: string }`.

Response: `{ frameB64: string }` where `frameB64` is a `data:image/png;base64,...` data URI.

Implementation: calls `ffmpeg -sseof -0.1 -i <localPath> -vframes 1 -vcodec png -f image2pipe pipe:1` via Node `execFile`. Output captured in memory — never writes to disk. Returns 404 if the generation doesn't exist, 400 if it's not a video.

### `POST /api/generate-video`
SSE-streaming video generation via Wan 2.2 14B fp8 MoE. Returns an SSE stream directly (no separate `/progress` route). See **Video generation (Phase 1)** section for full details.

Request body: `{ mode, prompt, negativePrompt?, width, height, frames, steps, cfg, seed?, startImageB64?, projectId? }`.

Optional `projectId`: if present, must reference an existing project (validated against DB). The resulting Generation row gets `projectId` set and `position` auto-computed as `max(existing positions) + 1`.

SSE events: same shape as the image progress route — `progress`, `complete`, `error`. The `complete` event carries `{ records: GenerationRecord[] }` — single-element array; matches image-mode shape.

Validation: `width`/`height` multiples of 32 (256–1280); `frames` = 8N+1 (17–121); `steps` even (4–40); `cfg` 1.0–10.0; `mode='i2v'` ↔ `startImageB64` present.

Watchdog: 15 minutes (vs 10 for image jobs).

## Source layout

```
src/
  app/
    layout.tsx          root layout, sets dark theme + viewport meta
    page.tsx            tab state (studio | projects | gallery | models | admin); wraps app in QueueProvider; renders ToastContainer; passes onNavigateToGallery/onNavigateToProjects to Studio/Gallery
    globals.css         Tailwind directives + utility classes: .input-base, .label, .card
    api/
      models/           GET — checkpoint + lora lists from ComfyUI
      generate/         POST — submit workflow, return promptId
      progress/[promptId]/  GET — SSE stream
      gallery/          GET — paginated DB query
      generation/[id]/  GET — single record
      models/register/       POST — thin wrapper over registerModel; used by add_model.sh
      models/ingest/         POST — SSE single-model ingestion
      models/ingest-batch/   POST — SSE batch ingestion
      services/control/      POST — SSH sudo systemctl start/stop on Core VM
      services/status/       GET  — SSH systemctl + HTTP probe for all three services
      generate/polish/route.ts     POST — LLM prompt expansion with frozen-token validation
      generate/polish/prompt.ts    POLISH_SYSTEM_PROMPT, POLISH_SAMPLING, STATIC_NEGATIVE constants
      generate/polish/validate.ts  extractFrozenTokens(), validatePreservation()
      generate-video/route.ts      POST — SSE video generation via Wan 2.2; handles t2v and i2v modes; emits init event with promptId+generationId
      jobs/active/route.ts         GET  — returns running + recently-completed jobs from comfyws singleton
      jobs/[promptId]/route.ts     DELETE — aborts a job (abortJob → error SSE + SSH cleanup)
      jobs/[promptId]/abort/route.ts  POST — same as DELETE; preferred explicit-abort endpoint
      projects/[id]/stitch/route.ts   POST — SSE video stitching; runs ffmpeg on mint-pc; emits init/progress/completing/complete/error
  lib/
    comfyws.ts          WS singleton, binary parsing, SSE fan-out, file save, DB insert; tracks promptSummary/startedAt/progress per job; recentlyCompleted cache (5 min); getActiveJobs(); StitchJob + registerStitchJob/finalizeStitchSuccess/finalizeStitchError
    stitch.ts           stitchProject() — ffmpeg-based video concatenation with hard-cut or crossfade (0.5s); four code paths based on transition type and resolution homogeneity
    notification.ts     playChime() Web Audio API bell tone; requestNotificationPermission(); sendBrowserNotification()
    workflow.ts         buildWorkflow() — image path
    wan22-workflow.ts   buildT2VWorkflow(), buildI2VWorkflow() — Wan 2.2 video path; exports VideoParams, ComfyWorkflow
    wan22-templates/    wan22-t2v.json, wan22-i2v.json — API-format ComfyUI workflow templates (runtime data; do not reference prompts/ at runtime)
    prisma.ts           Prisma client singleton (global.__prisma)
    imageSrc.ts         imgSrc(filePath) helper — handles legacy /generations/ paths
    civitaiIngest.ts    SSH-driven CivitAI metadata fetch + download to A100 VM; supports type: 'checkpoint' | 'lora' | 'embedding'; embeddings go to /models/ComfyUI/models/embeddings/
    civitaiUrl.ts       parseCivitaiInput(input) — accepts CivitAI URLs and Air strings (urn:air:...); alias parseCivitaiUrl kept for backwards compat; returns canonicalUrl, type, baseModel; type now includes 'embedding'
    registerModel.ts    DB upsert logic shared by /api/models/register and ingest; handles checkpoint, lora, and embedding types; calls extractCategoryFromTags() in all three branches (lora, checkpoint, embedding)
    systemLoraFilter.ts isSystemLora() / filterSystemLoras() — hides system-managed LoRAs (IP-Adapter companion weights) from user-facing API responses
    useModelLists.ts    React hook: shared fetcher for /api/models + /api/checkpoint-config + /api/lora-config + /api/embedding-config; consumed by ModelSelect and ModelConfig; exposes loraCategories, checkpointCategories, and embeddingCategories maps
  types/
    index.ts            GenerationParams, GenerationRecord (now includes projectId/projectName/isStitched/parentProjectId/parentProjectName/stitchedClipIds), ModelInfo (now includes embeddings[]), EmbeddingConfig,
                        ProjectSummary, ProjectDetail, ProjectClip, ProjectStitchedExport, SSEEvent, SAMPLERS, SCHEDULERS, RESOLUTIONS constants
  components/
    TabNav.tsx          sticky header with Studio / Projects / Gallery / Models / Admin tabs
    Studio.tsx          full generation form; form never locks; integrates useQueue for job tracking; on mount calls /api/jobs/active for post-refresh recovery
    QueueTray.tsx       badge + dropdown tray (Studio header, right of mode toggle); job rows with progress/abort/view/dismiss
    Toast.tsx           ToastContainer + Toast; fixed bottom-right; auto-dismiss 5 s; rendered at page level
    ReferencePanel.tsx  img2img + FaceID identity reference upload zones (collapsible card in Studio)
    PromptArea.tsx      labelled textarea
    ModelSelect.tsx     checkpoint + LoRA dropdowns; re-fetches /api/models + configs when refreshToken changes (incremented by ModelConfig saves) or when the user taps the Refresh button in the picker sheet
    ParamSlider.tsx     range slider + number input pair
    GenerationProgress.tsx  progress bar (during gen) or result image (on complete)
    Gallery.tsx         3-col image grid, cursor-based infinite-scroll via IntersectionObserver, opens ImageModal; accepts onNavigateToProject callback
    ImageModal.tsx      bottom-sheet modal with full image + all metadata fields; shows Project link for video clips; shows Stitched-from-project + source clip count for stitched videos
    Projects.tsx        Projects tab — 2-col project card grid, New Project modal
    ProjectDetail.tsx   Project detail view — inline-editable header, flex-wrap DnD clip strip + stitched output tiles (@dnd-kit, rectSortingStrategy), 4-way filter, Settings modal, Stitch button + StitchModal
    ModelConfig.tsx     Model Settings tab; sub-tabs Checkpoints / LoRAs / Embeddings / Add Models; saves trigger onSaved (increments modelConfigVersion); Embeddings sub-tab has copy-to-clipboard for embedding:name usage syntax; Checkpoints and LoRAs sub-tabs have a free-text category field (heuristic-populated at ingest, user-editable)
    IngestPanel.tsx     CivitAI URL paste form for single + batch model ingestion (Add Models sub-tab)
    ServerBay.tsx       Admin tab; Illustrator Stack card with Start All/Stop All (sequential with progress) + individual service rows + Check Status
    GalleryPicker.tsx   Modal for selecting a gallery image as I2V starting frame; images-only filter (mediaType=image), infinite scroll, no delete/remix/favorite actions
  contexts/
    QueueContext.tsx    Global job queue state; Context + useReducer; job status: queued|running|completing|done|error; 5 s polling while jobs active; 30 s auto-dismiss for done jobs

```
public/
  manifest.json       PWA manifest (standalone display, zinc-950 theme/bg, /icon reference)
src/app/
  icon.tsx            Next.js ImageResponse icon — violet "I" on dark bg, served at /icon (512×512 PNG)
```

## PWA / home-screen install

`layout.tsx` sets `appleWebApp: { capable, title, statusBarStyle: 'black-translucent' }` and `manifest: '/manifest.json'`. When saved to an iPad/iPhone home screen the app launches standalone with no browser chrome. `icon.tsx` generates the app icon automatically via Next.js's file-convention route — no manual favicon wrangling needed.

## Polish button (LLM prompt expansion)

`PromptArea` accepts an optional `showPolish` boolean prop. When true (positive prompt only), a `✨ Polish` button appears in the weight toolbar. Tapping it:
1. POSTs the current `positivePrompt` (and optional `negativeAdditions`) to `/api/generate/polish`.
2. Shows a spinner while the LLM generates (up to 30 s).
3. On `polished: true`, replaces the textarea with the expanded prompt that preserves all weighted tokens (`(word:N)`, `((word))`, `[[word]]`) byte-for-byte.
4. On `polished: false`, leaves the textarea unchanged and shows a brief reason indicator (timeout, weight drift, parse error, etc.) — the user's prompt is never lost.

The endpoint is configured via `LLM_ENDPOINT` (typically `http://127.0.0.1:11438/v1/chat/completions` when llama-server is tunnelled to mint-pc:11438) and `POLISH_LLM_MODEL` (the model identifier or path). See the `POST /api/generate/polish` API entry above for full request/response shape.

## Workflow node graph

Node IDs used in the ComfyUI API workflow:

| ID | class_type | notes |
|----|-----------|-------|
| 1 | CheckpointLoaderSimple | outputs: model[0], clip[1], vae[2] |
| 2 | EmptyLatentImage | only when no `baseImage`; absent in img2img/inpaint mode |
| 3 | CLIPTextEncode | positive; clip input = last node in LoRA chain (or node 1 if none) |
| 4 | CLIPTextEncode | negative; same clip source as node 3 |
| 5 | KSampler | seed is the resolved value, never -1 |
| 6 | VAEDecode | |
| 7 | SaveImageWebsocket | terminal node — no disk write on remote |
| 10 | ETN_LoadImageBase64 | base image (only when `baseImage` present; no disk write) |
| 11 | VAEEncode or VAEEncodeForInpaint | `VAEEncode` in plain img2img; `VAEEncodeForInpaint` when `mask` is also present (`grow_mask_by: 6`) |
| 12 | ETN_LoadMaskBase64 | inpaint mask (only when `mask` present; white=replace, black=keep) |
| 100 | LoraLoader | first LoRA (`params.loras[0]`); inputs from node 1 |
| 101 | LoraLoader | second LoRA (`params.loras[1]`); inputs from node 100 |
| 100+i | LoraLoader | pattern: node ID = `100 + index`; each takes model/clip from the previous node in the chain; final node feeds KSampler + CLIPTextEncode nodes |

When `baseImage` is present, node 2 (`EmptyLatentImage`) is omitted and KSampler uses the latent from node 11 instead. When `mask` is also present, node 12 (`ETN_LoadMaskBase64`) is injected and node 11 switches to `VAEEncodeForInpaint` — the activity pill in the Reference panel changes from `img2img` (violet) to `inpaint` (blue).

When `referenceImages` is present in `GenerationParams`, `buildWorkflow()` injects additional nodes after the LoRA chain and before KSampler:

| ID | class_type | notes |
|----|-----------|-------|
| 300 | ETN_LoadImageBase64 | first reference image (base64 inline — no disk write) |
| 301 | ETN_LoadImageBase64 | second reference image (only when 2+ refs) |
| 302 | ETN_LoadImageBase64 | third reference image (only when 3 refs) |
| 310 | ImageBatch | batches refs 0+1 (only when 2+ refs) |
| 311 | ImageBatch | batches node 310 + ref 2 (only when 3 refs) |
| 320 | IPAdapterUnifiedLoaderFaceID | FACEID PLUS V2 preset, CPU provider, lora_strength 0.6; takes model from end of LoRA chain |
| 321 | IPAdapterFaceID | weights mapped from `referenceImages.strength` via `strengthToWeights()`; model output feeds KSampler |

`strengthToWeights(strength)` maps 0–1.5 to `weight`/`weight_faceidv2`: linear 0→(0.85, 0.75) at strength=1.0, then up to caps (1.0, 1.0) at strength=1.5. KSampler's model input switches to node 321's output. Without `referenceImages`, the chain is unchanged.

### Image batch independence

Image batches are N independent ComfyUI workflows, not one workflow with `EmptyLatentImage.batch_size > 1`. Each take gets its own seed (random if `seed === -1`, sequential `seed + i` if explicit), its own queue tray entry, its own promptId, and its own `Generation` row. This produces visually-distinct outputs at the cost of N prompt-submission round-trips to ComfyUI. The cap is 4 takes per submit. `buildWorkflow()` always emits `batch_size: 1` on `EmptyLatentImage` — the loop is client-side in `handleGenerate()`.

## Tailwind conventions

- Page bg: `bg-zinc-950` / Card: `bg-zinc-900` / Input: `bg-zinc-800`
- Borders: `border-zinc-800` (card), `border-zinc-700` (input)
- Accent: `violet-500` / `violet-600` (Generate button, focus rings, slider thumb)
- `.card` = `bg-zinc-900 border border-zinc-800 rounded-xl p-4`
- `.input-base` = full-width styled input/select/textarea with violet focus ring
- `.label` = uppercase xs tracking-wide zinc-400 label

## Model ingestion workflow

**Primary path: in-app UI.** Models tab → Add Models sub-tab. Single mode pastes one CivitAI URL or Air string (`urn:air:<base>:<type>:civitai:<id>@<id>`) and streams live progress; batch mode accepts up to 20 URLs/Air strings and processes them sequentially with per-row progress. When an Air string is pasted, the type radio (Checkpoint/LoRA/Embedding) is auto-pre-filled from the Air `<type>` field. Backed by `/api/models/ingest` and `/api/models/ingest-batch`. Successful ingestion automatically refreshes Studio's ModelSelect via the `modelConfigVersion` mechanism — no manual refresh needed.

**Embeddings (textual inversions):** Supported as a third type alongside checkpoints and LoRAs. Ingested via the same Add Models tab — select the "Embedding" radio (or paste an Air string with `type=embedding`). The file downloads to `/models/ComfyUI/models/embeddings/` on the VM. The embeddings list is sourced from the VM (via ComfyUI's `/embeddings` endpoint — see `/api/models` route notes); `EmbeddingConfig` rows are metadata that join in by filename. Files on the VM without metadata still appear in the Embeddings sub-tab with the raw filename and can be deleted from the UI. To use an embedding in a generation, type `embedding:<filename-without-extension>` directly in the positive or negative prompt in Studio. ComfyUI resolves embeddings by name at prompt-parse time — no workflow changes required. There is no Studio-side picker; users type the syntax manually. The Embeddings sub-tab provides a copy-to-clipboard button for each embedding's usage syntax.

**Desktop fallback: `add_model.sh`** — batch processing from the desktop terminal using a queue-file format. Posts to `/api/models/register` directly, bypassing the SSE infrastructure. Use this for large batches from the desktop, or as a recovery path if the in-app UI breaks.

`add_model.sh` takes a queue file and batch-processes every line: downloading each model to the Azure VM and registering its metadata in the local DB.

```bash
./add_model.sh queue.txt
```

**Queue file format** — pipe-delimited, one model per line. No manual metadata — it's fetched automatically from CivitAI via the Azure VM proxy.
```
TYPE|MODEL_ID|PARENT_URL_ID
lora|1234567|111111
checkpoint|9876543|222222
```

Fields:
- `TYPE`: `lora` or `checkpoint`
- `MODEL_ID`: numeric CivitAI model **version** ID (download URL + `?modelVersionId=` param)
- `PARENT_URL_ID`: numeric CivitAI base model ID (`/models/{id}` URL path)

The header row (`TYPE|…`), blank lines, and lines starting with `#` are silently skipped.

**What each line does:**
1. SSHes into `a100-core` and runs `curl -4` to fetch `https://civitai.com/api/v1/model-versions/{MODEL_ID}` (the VM is in Poland and is not geoblocked; the local Mint PC in the UK gets HTTP 451). Validates the response is a JSON object.
2. Generates a random 12-char hex filename (e.g., `a3f9bc12d04e.safetensors`) to obfuscate the origin.
3. SSHes into `a100-core` again and runs `wget` to download from `https://civitai.red/api/download/models/{MODEL_ID}?token=…` directly to `/models/ComfyUI/models/checkpoints/` or `/models/ComfyUI/models/loras/`. After download, runs a remote `stat` to verify the file is at least 1 MB — if smaller, treats it as a failed download (likely an HTML error page) and skips the item.
4. Uses `jq` to wrap the raw CivitAI JSON as `civitaiMetadata` in the request body and `curl`s it to `POST /api/models/register`.
5. Prints a per-model status line and a final summary (`N succeeded, N failed`).

After the script completes, tap the Refresh button (↺) in Studio's model picker sheet or in the ModelConfig header to reload the model lists. The newly ingested models will then appear with their friendly names and trigger words pre-populated.

**Requires** `jq` on the local machine (`sudo apt install jq`). The CivitAI token is read from `.env` (`CIVITAI_TOKEN`); the script will refuse to run if it's missing. Per-item failures (validation, download, registration) are logged and skipped; the script always processes the entire queue and prints a summary of successes and failures at the end.

---

## Video generation (Phase 1)

### Disk-avoidance exception

Unlike image generation (which uses `SaveImageWebsocket` to stream images over WS with zero VM disk writes), video generation has no equivalent `SaveVideoWebsocket` node in ComfyUI. The video path therefore writes **one webm file per generation to the VM filesystem**, fetches it over HTTP, and immediately SSH-deletes it.

`SaveWEBM` is the **only** allowed disk-write class on the VM, and **only** via the video path. The image-path guard remains unchanged and still rejects `SaveImage` and `LoadImage`.

Per-generation flow:
1. Workflow built with `SaveWEBM`. The VM filename prefix is a random 16-character hex string generated per request (`randomBytes(8).toString('hex')`). The full filename including SaveWEBM's auto-suffix matches `[a-f0-9]{16}_00001_.webm`. The prefix is stored on the in-flight job record so all cleanup paths use the correct glob.
2. Workflow POSTed to ComfyUI `/prompt`.
3. ComfyUI sends an `executed` WS message with `{ filename, subfolder }` when SaveWEBM finishes.
4. mint-pc fetches `http://127.0.0.1:8188/view?filename=...&subfolder=...&type=output` and writes to `IMAGE_OUTPUT_DIR`.
5. mint-pc SSH-runs `rm -f /models/ComfyUI/output/${filenamePrefix}*` in a `finally` block — runs whether or not steps 3-4 succeeded.

`SaveAnimatedWEBP` (node 28, present in both templates) is stripped by the workflow builders before submitting to ComfyUI.

The i2v workflow builder constructs the `ETN_LoadImageBase64` node at runtime rather than reading it from the template. The template intentionally has a dangling link from `WanImageToVideo.start_image` that the builder resolves by inserting node 52. This keeps `LoadImage` out of the source tree entirely so the disk-avoidance grep guard remains dumb-and-correct.

### MoE step coupling

The 14B MoE model splits sampling between high-noise (node 57) and low-noise (node 58) experts. Both `KSamplerAdvanced` nodes share a single conceptual "total steps" expressed in **four fields**:

- `node57.steps = total`, `node57.end_at_step = total/2`
- `node58.steps = total`, `node58.start_at_step = total/2`

The `applySteps()` helper in `wan22-workflow.ts` writes all four atomically. Naively overriding only `steps` on both nodes leaves the handoff (`end_at_step`/`start_at_step`) stuck at 10 (the template default) and silently breaks sampling at any `total ≠ 20`.

CFG is also written to both nodes in lockstep via `applyCfg()`.

### Chinese negative prompt

The default negative prompt on node 7 is verbatim Alibaba-recommended Chinese text. Do not translate or replace it — the model was trained against this exact string. The workflow builders preserve it unless the caller explicitly overrides `negativePrompt`.

### Validation rules

| Parameter | Rule |
|---|---|
| `width`, `height` | Integer, multiple of 32, 256–1280 inclusive |
| `frames` | Integer, `(frames - 1) % 8 === 0`, 17–121 inclusive (e.g. 17, 25, 33, …, 121) |
| `steps` | Even integer, 4–40 inclusive (skipped when `lightning: true` — overridden to 4) |
| `cfg` | Number, 1.0–10.0 inclusive (skipped when `lightning: true` — overridden to 1) |
| `mode='i2v'` | `startImageB64` required |
| `mode='t2v'` | `startImageB64` forbidden |

### Lightning mode

Wan 2.2 Lightning is a 4-step distilled mode using lightx2v's Seko LoRAs. When the Lightning toggle is on, the workflow builder injects two `LoraLoaderModelOnly` nodes (one per UNet expert), forces steps=4 and CFG=1, switches the sampler to `lcm`, and otherwise produces the same output structure. Generation time drops from ~14 min to ~3 min at the cost of some quality loss. The toggle lives at the top of the video settings popout, defaults off, and is overridable per project via the project's `defaultLightning` field.

LoRA layout on the VM (preserves upstream filenames; subdirectory naming disambiguates variants):

- `loras/wan22-lightning-t2v/high_noise_model.safetensors`
- `loras/wan22-lightning-t2v/low_noise_model.safetensors`
- `loras/wan22-lightning-i2v/high_noise_model.safetensors`
- `loras/wan22-lightning-i2v/low_noise_model.safetensors`

Reference workflows from lightx2v are stashed in `loras/_reference/`. If lightx2v ships v1.2+, the upgrade is to drop the new safetensors into the same subdirectories — no code changes needed.

When `lightning: true` is sent to `/api/generate-video`, the route silently overrides whatever `steps` and `cfg` the caller sent (debug-logged). The Studio UI already locks those fields visually when the toggle is on. The DB record stores `model: 'wan2.2-t2v-lightning'` (or `-i2v-lightning`) and `sampler: 'lcm'` for lightning generations; full-quality generations remain `euler`.

### Wan LoRA support

Wan 2.2 LoRAs from CivitAI use the same ingest pipeline (with the same 6-byte hex filename obfuscation) as SD LoRAs but require two booleans (`appliesToHigh`, `appliesToLow`) on `LoraConfig`, indicating which UNet expert(s) they affect. Most Wan LoRAs apply to both (both default to `true`). Single-expert LoRAs can be adjusted via the Models tab after ingest.

The video form's LoRA stack injects `LoraLoaderModelOnly` nodes per LoRA per applicable expert, chained between UNETLoader (or Lightning's loader at nodes 100/101) and ModelSamplingSD3 (nodes 54/55). User LoRA nodes start at ID 200; Lightning reserves 100/101. When Lightning is active, user LoRAs chain after Lightning LoRAs: the full sequence is UNETLoader → Lightning LoRA (100/101) → user LoRAs (200+) → ModelSamplingSD3. Lightning + user LoRA combinations are flagged "experimental" in the UI since Lightning was distilled against the bare base model, not against arbitrary LoRA stacks.

Base model canonical string: `'Wan 2.2'` (normalised from CivitAI's various spellings such as `"Wan Video 2.2"` by `normalizeBaseModel()` in `registerModel.ts`).

The LoRA picker filters by base model: video mode shows only LoRAs with `baseModel === 'Wan 2.2'`; image mode shows all LoRAs (matches sorted to top). The Models tab shows all LoRAs unfiltered.

Project `defaultVideoLoras` stores a JSON-encoded `WanLoraSpec[]` in the `Project` DB row. New clips generated in a project pre-fill the Studio video LoRA stack from this default. The stored `WanLoraSpec` includes both `loraName` (obfuscated) and `friendlyName` (human-readable); the `friendlyName` can become stale if the LoRA is renamed in the Models tab, but the `loraName` remains correct for ComfyUI resolution.

Video clips persist their LoRA stack and Lightning state on the `Generation` row (`videoLorasJson` and `lightning` columns). Remix-from-gallery reconstructs both into Studio's video form, matching image-mode's full-parameter remix. Legacy rows (pre-batch) have null for both and degrade gracefully on remix — Lightning OFF, empty LoRA stack — preserving today's behavior.

### `/api/generate-video` endpoint

**Request:** POST with JSON body `{ mode, prompt, negativePrompt?, width, height, frames, steps, cfg, seed?, startImageB64?, lightning?, loras? }`.
`loras` is an optional `WanLoraSpec[]` — omit or pass `[]` for no user LoRAs.

**Response:** SSE stream. Events:
| event | data shape |
|-------|-----------|
| `progress` | `{ value: number, max: number }` |
| `complete` | `{ records: GenerationRecord[] }` — single-element array; matches image-mode shape |
| `error` | `{ message: string }` |

**Watchdog timeout:** 15 minutes (image jobs use 10 minutes). Set via `registerVideoJob`'s `timeoutMs` parameter.

**DB record:** `Generation` row with `mediaType: 'video'`, `frames`, `fps: 16`, `model: 'wan2.2-t2v'` or `'wan2.2-i2v'` (lightning variants append `-lightning`). `sampler: 'euler'` (or `'lcm'` for lightning), `scheduler: 'simple'`.

### Studio UI (Phase 1.2a)

A pill toggle at the top of Studio switches between **Image** and **Video** modes. Mode persists for the session via `sessionStorage`. Positive prompt and seed carry across when switching; all other params reset to that mode's defaults. The mode toggle is disabled while a generation is in-flight.

**Video mode — always-visible controls:**

| Control | Notes |
|---|---|
| Positive prompt | required |
| Negative prompt | hidden — hint: "Default Wan 2.2 negative prompt applied." |
| "Choose starting frame" button | Shown when project context is active; opens `ProjectFramePickerModal` to pick any project clip (image, video, or stitched) as I2V starting frame |
| Starting frame toggle + picker | On → I2V mode; Off → T2V mode; shown when no project picker selection is active |
| Settings button | Opens the same right-side drawer as image mode |
| Generate Video button | — |

**Video mode — settings popout (same drawer as image mode, opened via the settings button):**

| Control | Default | Bounds |
|---|---|---|
| Resolution presets | — | 1280×704 / 768×768 / 704×1280 quick-pick buttons |
| Width / Height | 1280 / 704 | See validation rules above |
| Frames slider | 57 | 17–121, step 8; label shows `N frames (N/16s)` |
| Steps slider | 20 | 4–40, step 2 (even-only) |
| CFG slider | 3.5 | 1.0–10.0, step 0.1 |
| Seed | -1 (random) | shared with image mode |
| Batch | 1 | 1–4, step 1 — produces N independent parallel jobs in the queue tray, identical to image-mode batch behaviour |

The settings drawer is mode-aware: opening it in image mode shows checkpoint/LoRA/generation/sampling controls; opening it in video mode shows resolution/frames/steps/cfg/seed controls. Switching modes while the drawer is open immediately shows the new mode's controls. Closing and reopening preserves all entered values (state lives in the parent form, not the drawer).

Image-mode-only controls are hidden in Video mode: checkpoint selector, LoRA stack, ReferencePanel, Hi-Res Fix, sampler/scheduler, batch size, and the Polish button.

**Starting frame picker:** When the starting frame toggle is On, a "Pick from gallery" button appears. Clicking it opens `GalleryPicker` — a modal that shows the gallery grid filtered to `mediaType=image` only. Selecting an image closes the modal and populates a thumbnail preview. The × button clears the selection (keeps the toggle on). The i2v `startImageB64` field is populated by fetching the selected image's URL client-side and base64-encoding it at submit time.

**Generate Video button:** replaces the image-mode "Generate" button. POSTs to `/api/generate-video` as a streaming fetch (not EventSource, since the route is a direct POST→SSE response). Progress and error events are parsed from the SSE stream inline.

**Video batch result card** mirrors image-mode: per-take `GenerationRecord` accumulates into a 3-column thumbnail grid (`<video preload="metadata">` tiles with duration badge). Tapping a tile opens the existing `ImageModal` at that record's index. The grid resets on mode switch, new batch submission, video remix, or project context trigger — same lifecycle as image-mode's `lastImageRecords`.

**Queue UX (Phase 1.2b):** The Generate/Generate Video buttons are never locked. Each submit adds a job to the queue and returns immediately. See **Queue UX** section below.

---

### Queue UX (Phase 1.2b)

**Concurrency model.** Submitting a generation never locks the form. Each submit immediately adds a job to the in-memory `ActiveJob` queue (client-side, `QueueContext`) and returns. Multiple image, video, or mixed jobs can run concurrently. The queue is single-user and has no cap. Video batch submissions (batchSize 1–4) behave identically to image-mode batch: Studio loops N times, each take gets its own independent POST to `/api/generate-video`, its own SSE stream, its own queue-tray entry, and its own `Generation` row — the starting frame (if i2v) is resolved once before the loop and reused across all takes.

**Job status lifecycle.** Jobs are registered with status `'queued'` and transition to `'running'` when the first WS `executing` event arrives from ComfyUI for that prompt (meaning ComfyUI dequeued it and started GPU work). The full status union is: `'queued' | 'running' | 'completing' | 'done' | 'error'`. The tray distinguishes queued (no elapsed counter, no progress bar, shows "Queued" or "Queued (N of M)") from running (live progress, elapsed since execution start). Elapsed is tracked from `runningSince` (execution start), not `startedAt` (submission time), so a job that sat queued for 5 minutes shows elapsed starting from 0 when execution begins. Stitch jobs (local ffmpeg) skip the `'queued'` state and start `'running'` immediately.

**`QueueContext` (`src/contexts/QueueContext.tsx`).** React Context + useReducer. Provides:
- `addJob`, `updateProgress`, `setCompleting`, `completeJob`, `failJob`, `removeJob` — called from Studio's SSE handlers
- `toggleMute` / `muted` — persisted to localStorage (`queue-muted`)
- `toasts` / `dismissToast` — in-app toast list (one per completion)
- `requestPermissionIfNeeded` — requests browser notification permission on first submit; denial stored in localStorage (`queue-notif-perm`) and never re-prompted

**`QueueTray` (`src/components/QueueTray.tsx`).** Badge + dropdown in the Studio header (right of the mode toggle). Badge shows count of active (queued + running + completing) jobs; invisible at zero. Expanded dropdown shows one row per job with: media-type icon, prompt summary (60 chars), for queued: "Queued" label (or "Queued (N of M)" when multiple are queued); for running: progress bar (`N/total steps` or `Saving…`) + elapsed since execution start; abort button (×), View link (done), dismiss button (done/error). Mute toggle (speaker icon) in the tray header. Closes on click-outside or Escape.

**Notification chain** (fires on `completeJob`):
- **Audio chime:** synthesised via Web Audio API (880 Hz → 660 Hz bell tone, ~0.8 s). Skipped if muted.
- **In-app toast** (`src/components/Toast.tsx`): "Image/Video generated" card in bottom-right, auto-dismisses after 5 s. Rendered at page level via `ToastContainer`.
- **Browser Notification API:** fires if `document.hidden` and `Notification.permission === 'granted'`. `onclick` focuses the tab.

**Refresh survivability.** SSE stream close is treated as silent — it just stops pushing events to that subscriber. The job continues on the VM. To intentionally abort a running job, the client calls `POST /api/jobs/[promptId]/abort`. This separation is what makes refresh survivability work: a refresh closes the SSE stream, the job stays alive on the server, the next `/api/jobs/active` poll on mount finds it, and the tray reattaches.

`GET /api/jobs/active` returns all queued/running jobs + recently-completed jobs (5-min cache). On Studio mount, this endpoint is fetched and any found jobs are added to the queue without re-notifying. The `QueueContext` polls this endpoint every 5 s while any jobs are `queued`, `running`, or `completing`, detecting completions and queued→running transitions via status changes.

**`completing` status.** When GPU computation ends (`execution_success`), `finalizeJob` emits a `completing` SSE event before the async save. The client transitions the job to `completing` status and shows `Saving…` in the tray — especially noticeable for video (2-min HTTP transfer from VM).

**Abort.** Clicking × in the tray sends `DELETE /api/jobs/{promptId}` (or `POST /api/jobs/{promptId}/abort`). The server calls `manager.abortJob`, sends an `error` SSE event (`'Aborted by user'`) to any live subscriber, closes the SSE stream, adds to `recentlyCompleted`, and (for video) fires SSH cleanup. For **queued** jobs (not yet executing), `abortJob` calls `POST /queue` with `{ delete: [promptId] }` to remove the prompt from ComfyUI's internal queue without killing the currently-running job. For **running** jobs, it calls `POST /interrupt` to stop GPU work mid-execution.

**Watchdog timeout.** The 60-minute sanity timeout starts at job registration (when the job is `'queued'`), not when execution begins. A job that sits queued for a long time still trips the watchdog.

**New API routes:**
| Route | Description |
|---|---|
| `GET /api/jobs/active` | Returns queued/running + recently-completed jobs from comfyws singleton. Shape: `{ jobs: ActiveJobInfo[] }`. |
| `DELETE /api/jobs/[promptId]` | Aborts a job: calls `abortJob`, sends error SSE, closes stream, SSH cleanup (video), adds to recentlyCompleted. |
| `POST /api/jobs/[promptId]/abort` | Same as DELETE — preferred explicit-abort endpoint. Returns 200 `{ ok: true }` or 404 if the job is not active. |

**`init` SSE event (video only).** `/api/generate-video` emits an `init` event as the first SSE frame with `{ promptId, generationId }` so the client can add the job to the queue before any `progress` events. Image jobs get promptId from the synchronous JSON response of `POST /api/generate`.

### Gallery (Phase 1.3)

Video generations appear in the Gallery alongside images:

- **Tile thumbnails:** `<video preload="metadata">` — the browser fetches enough to render the first frame as a poster; no separate thumbnail asset needed.
- **Duration badge:** Bottom-right corner of every video tile, dark pill: `${(frames / fps).toFixed(1)}s`. Render-only on `mediaType === 'video'` tiles.
- **Modal playback:** `<video controls autoPlay loop playsInline>` with native HTML5 controls. No `muted` attribute — Wan 2.2 generates no audio, so autoplay without mute is permitted. Previous/Next navigation works across mixed media respecting any active filter.
- **Sidebar metadata (modal):** Frames and FPS rows shown for video; sampler/scheduler/HRF shown for image.
- **All/Images/Clips/Videos filter:** Pill toggle group in the filter bar alongside the favorites toggle. Default: All. Four-way taxonomy matches the project detail view: "Clips" = unstitched videos, "Videos" = stitched outputs. Passes `mediaType=image` (Images), `mediaType=video&isStitched=false` (Clips), or `mediaType=video&isStitched=true` (Videos) to `GET /api/gallery`. Combines with favorites filter (AND).
- **Remix from video:** Switches Studio to Video mode and populates the video form with prompt, width, height, frames, steps, cfg. The starting frame is not restored — re-pick from gallery if desired. Remix sets batch size to 4 by default, treating the action as "generate alternates of this clip." The user can adjust down before clicking Generate. This default applies to both image-mode and video-mode remix.
- **Delete/favorite:** Work identically for video — the delete endpoint and favorite toggle are media-type-agnostic.

`GET /api/gallery` accepts optional `mediaType` (`image` or `video`), `isStitched` (`true` or `false`), and `isFavorite=true` query parameters. All filters AND together. Omitting any returns unfiltered for that dimension.

---

---

## Projects (Phase 2)

### Schema additions

```prisma
model Project {
  id             String       @id @default(cuid())
  name           String
  description    String?
  styleNote      String?
  defaultFrames    Int?
  defaultSteps     Int?
  defaultCfg       Float?
  defaultWidth     Int?
  defaultHeight    Int?
  defaultLightning Boolean?
  createdAt        DateTime     @default(now())
  updatedAt        DateTime     @updatedAt
  generations      Generation[]
}

// New fields on Generation:
projectId    String?
project      Project? @relation(fields: [projectId], references: [id], onDelete: SetNull)
position     Int?
```

`onDelete: SetNull` — deleting a project drops clips back to project-less state; they remain in the unified Gallery. `position` has no unique constraint; ordering is enforced at write-time.

Migration: `prisma/migrations/20260503000000_add_projects/migration.sql`

### API routes

| Route | Description |
|---|---|
| `GET /api/projects` | List all projects, most-recently-updated first. Response: `{ projects: ProjectSummary[] }`. |
| `POST /api/projects` | Create a project. Validates default params against Wan 2.2 rules. Returns 201 with the created project. |
| `GET /api/projects/[id]` | Full project + ordered clips (image and video). Response: `{ project: ProjectDetail, clips: ProjectClip[] }`. |
| `PATCH /api/projects/[id]` | Partial update — name, description, styleNote, defaultFrames/Steps/Cfg/Width/Height. |
| `DELETE /api/projects/[id]` | Delete project. Optional `?cascade=true` removes all source items, stitched exports, and aborts in-flight jobs. Default keeps items. Returns `{ ok: true }` or `{ ok: true, deletedItems: N, deletedStitches: M }`. |
| `PATCH /api/projects/[id]/reorder` | Reorder clips: `{ clipOrder: string[] }`. Validates all IDs belong to this project; updates `position` in a Prisma transaction. |
| `PATCH /api/generations/[id]/project` | Assign or unassign a clip to a project. Body: `{ projectId: string \| null }`. Sets `position` to `max+1` in the target project (or null when unassigning). Returns `{ ok: true }`, 404 if generation not found, 400 if projectId is invalid. |

### Projects tab and UI

**Projects** tab is positioned between Studio and Gallery in the tab bar. It has two sub-views:

**Listing view** (`Projects.tsx`): 2-column card grid. Each card shows a cover frame (most-recent clip), project name, description, clip count, and relative last-updated time. "+ New Project" button top-right. Empty state shows a CTA button. Clicking a card navigates to the detail view.

**New Project modal**: Form with name (required), description, style note, and a collapsible "Default settings" section (resolution presets + frames/steps/CFG number inputs). POSTs to `/api/projects`.

**Project detail view** (`ProjectDetail.tsx`):
- Header: back button, inline-editable name and description, Settings gear, overflow menu (Delete, two-tap confirm).
- Style note rendered in a muted box below description (read-only; editable via Settings modal).
- **"Generate image" and "Generate clip" buttons** — two equal-weight entry points. Each opens Studio in the corresponding mode with the project context pre-loaded (see Phase 2.2 below).
- **Clip strip**: `flex flex-wrap` grid. `DndContext` + `SortableContext` (`@dnd-kit/core` + `@dnd-kit/sortable`, `rectSortingStrategy`) wraps source clips only. Stitched output tiles are rendered after source clips as non-draggable `StitchedTile` elements with an emerald **Stitched** badge. Tiles render `<img>` for image clips and `<video preload="metadata">` for video clips. Position badge (top-left) on all source tiles; duration badge (bottom-right) on video tiles. Click opens `ImageModal` scoped to all project clips + stitched exports.
- **All/Images/Clips/Videos filter**: 4-way filter shown above the strip when the project has mixed content. "All" shows everything; "Images" shows image source clips; "Clips" shows unstitched video source clips; "Videos" shows stitched outputs. Does not affect drag-to-reorder order.
- Drag to reorder: optimistic update, then `PATCH /api/projects/[id]/reorder`. Reverts on error with a brief toast.
- Empty strip: placeholder text.
- **Settings modal**: description, style note, and default generation params (resolution presets + frames/steps/CFG inputs). PATCHes `/api/projects/[id]`.
- **Play-through toggle** (hidden on fewer than 2 *video* clips): replaces strip with a single `<video>` player that chains video clips end-to-end. Image clips are excluded from play-through. `onEnded` advances to the next video clip via `load()` + `play()`. Clip-index chips allow jumping to any video clip. "Play again" button shown after the last clip finishes. See **Play-through preview** below.

### Gallery integration

`GenerationRecord` now includes `projectId: string | null` and `projectName: string | null`. The gallery API (`/api/gallery`) includes the project relation. `ImageModal` shows a **Project** row in the metadata footer for all non-stitched clips (image and video): a clickable picker to assign/reassign the clip to a project, or set it to "None". `Gallery` accepts `onNavigateToProject` callback to wire project-name links back to the Projects tab.

### Project-aware generation (Phase 2.2)

Clicking "Generate image" or "Generate clip" calls `onGenerateInProject(project, latestClip, mode)` which propagates up to `page.tsx` → sets `projectContextTrigger` (with `mode: 'image' | 'video'`) → Studio picks it up via `useEffect`.

Project Detail offers two entry points: "Generate image" and "Generate clip". Each opens Studio in the corresponding mode with the project context active. The project's defaults (frames/steps/cfg/dimensions/lightning/videoLoras) pre-fill the video form when entering video mode; only dimensions pre-fill the image form when entering image mode. Generated items inherit the project regardless of mode.

Projects are general containers for generated outputs. Today they hold images and video clips; future phases will add JSON storyboards (Phase 5), long-form stories, and prompt roleplay. The two-mode entry on the project detail view is the current shape; new entry points will be added as new generation surfaces ship.

When a project is active in Studio, **both image and video generations** are created with `projectId` set on the resulting `Generation` row, and `position` is auto-computed as `max(existing positions in this project) + 1`. The project's linear strip shows images and clips in `position` order, mixed together. Clips can also be retroactively assigned to a project after generation; images can be assigned the same way (per Phase 2.3).

**Studio project context** (`ProjectContext` type in `src/types/index.ts`):
- `projectId`, `projectName` — for the badge and the `/api/generate` + `/api/generate-video` `projectId` field.
- `mode` — `'image' | 'video'`; which Studio mode to open.
- `latestClipId` — for last-frame extraction.
- `latestClipPrompt` — carried forward into the positive prompt textarea.
- `latestClipMediaType` — `'image' | 'video' | null`; determines whether to run ffmpeg or use the image directly (Phase 2.3).
- `latestClipFilePath` — filePath of the latest clip, used when `latestClipMediaType === 'image'` to load the image directly without an API call.
- `defaults` — `frames/steps/cfg/width/height/lightning/videoLoras`, each nullable; Studio falls back to `VIDEO_DEFAULTS` for unset video fields when entering video mode. Image mode only consumes `width`/`height`.

**Project badge**: always visible in the Studio header. The badge is a clickable project picker. Selecting a different project hard-resets the video form to that project's defaults and pre-fills the prompt with the new project's latest clip prompt. Selecting "None" or clicking × clears the project association without resetting form values. The picker is the same `<ProjectPicker>` component used by Phase 2.3's gallery modal sidebar. Persisted via `sessionStorage` key `studio-project-context` so it survives refresh (same pattern as `studio-mode`).

**Form pre-fill**: on context load, Studio switches to the requested mode. Video mode sets `videoP` from project defaults (with `VIDEO_DEFAULTS` fallback), applies lightning and video LoRA defaults. Image mode applies only `width`/`height` if set. Positive prompt is carried forward in both modes.

**Prompt threading**: `latestClip?.prompt` is the `promptPos` of the highest-positioned clip in the project. Carry-forward puts it in the textarea so the user can edit before generating.

**Remix vs. project flow**: remix from gallery always clears project context. Remixing is a fresh starting point; re-generating within a project uses the "Generate image" / "Generate clip" buttons.

### Prompt threading and last-frame extraction (Phase 2.2 / 2.3)

When Studio has project context, a **"Choose starting frame"** button replaces the old checkbox in the Starting frame section. Clicking it opens `ProjectFramePickerModal`, a bottom-sheet that lists all project clips (source images, source videos, and stitched exports). Video thumbnails show the last frame, extracted lazily via `POST /api/extract-last-frame` on modal open and cached in `frameCache` (a `useRef<Map<string, string>>`) across open/close cycles. Selecting a clip stores its ID as `selectedStartingClipId`.

At submit time, if `selectedStartingClipId` is set:
- **Image clip**: the image is fetched directly via its `filePath` URL using `encodeImageToBase64()` — no ffmpeg call needed.
- **Video or stitched clip**: checks `frameCache` first; if a cached last-frame exists it's used directly, otherwise Studio calls `POST /api/extract-last-frame` at submit time and sends the result as `startImageB64`.

While a submit-time extraction runs, a spinner appears and the Generate Video button is disabled.

The existing On/Off I2V toggle + gallery picker remain available when no project context is active (or when `selectedStartingClipId` is null). The non-project gallery picker path is unchanged.

### Play-through preview (Phase 2.2)

Single `<video ref={playerRef}>` element. `playingIdx` state tracks the current clip. `onEnded` increments it (or sets `playDone`). A `useEffect` on `[playingIdx, playThrough]` calls `playerRef.current.load()` then `.play()` when the index advances.

- Clip chips (numbered buttons) jump directly to any video clip.
- "Play again" button at end resets to index 0.
- Wan 2.2 generates no audio; no click/gap handling needed at this stage. Video stitching (Phase 3) will solve seamless playback.
- Toggle hidden when project has fewer than 2 video clips (image clips do not count).

---

## Project membership editing and image clips (Phase 2.3)

Clips can be assigned to a project after creation via the gallery modal sidebar's project picker. Both image and video clips can be project members. The project detail view renders mixed-media linear strips with media-type-appropriate thumbnails (`<img>` for images, `<video>` for videos) and a per-strip All/Images/Videos filter (shown only when both types are present). Stitch (Phase 3.1) exposes per-clip selection and is video-only — image clips are excluded from the selection list entirely.

### Project picker in ImageModal

The "Project: …" row in `ImageModal`'s bottom metadata panel is now a clickable button for **all non-stitched clips** (image and video). Clicking it opens a bottom-sheet picker:

- Lists all projects sorted by most-recently-updated, with name + clip count.
- A checkmark indicates the currently-assigned project (or "None").
- Search/filter input appears when there are more than 10 projects.
- "+ Create new project" option at the bottom opens `NewProjectModal`; on success, the clip is auto-assigned to the new project.
- Selecting a project calls `PATCH /api/generations/[id]/project` and optimistically updates the sidebar label.

`NewProjectModal` is now extracted to `src/components/NewProjectModal.tsx` and imported by both `Projects.tsx` and `ImageModal.tsx`.

### Mixed-media project detail strip

`ProjectClip` now includes `mediaType: string`. `GET /api/projects/[id]` returns all clips regardless of media type. `SortableClipTile` renders `<img>` for image clips and `<video>` for video clips; the duration badge appears only on video tiles.

The All/Images/Videos filter above the strip is visible only when the project contains both image and video clips.

### `GET /api/projects` cover frame

`ProjectSummary` now includes `coverMediaType: string | null`. `ProjectCard` in `Projects.tsx` renders `<img>` when `coverMediaType === 'image'` and `<video>` otherwise, preventing the broken-video-element bug when the most recent clip is an image.

---

## Video stitching (Phase 3)

### Overview

The **Stitch** button in `ProjectDetail` combines a project's video clips into a single mp4 file. ffmpeg runs locally on mint-pc — no VM involvement. The resulting file is saved to `IMAGE_OUTPUT_DIR` and appears in the unified Gallery with an emerald **Stitched** badge.

### Schema additions (Phase 3)

```prisma
// New fields on Generation:
isStitched       Boolean  @default(false)
parentProjectId  String?
parentProject    Project? @relation("StitchedFromProject", fields: [parentProjectId], references: [id], onDelete: SetNull)
stitchedClipIds  String?   // JSON: Phase 3 = string[] (plain array); Phase 3.1+ = { selected: string[], total: number }

// Existing relation explicitly named (required when two relations exist between same models):
project          Project? @relation("ProjectClips", fields: [projectId], references: [id], onDelete: SetNull)

// New on Project model:
generations     Generation[] @relation("ProjectClips")
stitchedExports Generation[] @relation("StitchedFromProject")
```

Migration: `prisma/migrations/20260504000000_add_stitched_exports/migration.sql`

### `src/lib/stitch.ts`

Core ffmpeg helper. Exports:

```ts
export async function stitchProject(params: {
  clipPaths: string[];
  outputPath: string;
  transition: 'hard-cut' | 'crossfade';
  onProgress?: (frame: number, totalFrames: number) => void;
  onChildProcess?: (cp: ChildProcessWithoutNullStreams) => void;
}): Promise<{ width: number; height: number; durationSeconds: number; frameCount: number }>
```

Internal helpers: `parseFps()`, `probeClip()` (ffprobe JSON), `runFfmpeg()` (spawns ffmpeg, parses `-progress pipe:2 -nostats` lines for frame-by-frame progress). Four code paths: hard-cut+same-res (concat demuxer), hard-cut+mixed-res (concat filter with scale), crossfade+same-res (xfade chain), crossfade+mixed-res (pre-scale + xfade chain). xfade offset: `cumulOffset += prevDuration - crossfadeDuration`. Concat list temp file deleted in `finally`. ffmpeg is spawned with an array of args (never shell-interpolated).

### `POST /api/projects/[id]/stitch`

SSE route. Body: `{ transition?: 'hard-cut' | 'crossfade', clipIds?: string[] }` (default hard-cut; clipIds optional). The `clipIds` array, when provided, specifies which video clips to stitch and in what order. Every entry must reference a video clip belonging to the project — non-video clip IDs return 400 to surface client-side bugs early. When omitted, defaults to all video clips in position order. Requires ≥ 2 video clips (either selected or total). Creates a pending `Generation` row (`isStitched: true`, `parentProjectId`, `stitchedClipIds`), emits an `init` SSE with `{ promptId, generationId }`, registers the job in `ComfyWSManager`, then fires `stitchProject()` fire-and-forget.

`stitchedClipIds` is stored as `{ selected: string[], total: number }` where `selected` is the ordered list actually stitched and `total` is the project's video clip count at stitch time. This lets the gallery sidebar show "X of N from project Y". Pre-Phase-3.1 rows have the plain array format and are handled gracefully in `ImageModal`.

SSE events:
| event | data |
|---|---|
| `init` | `{ promptId, generationId }` |
| `progress` | `{ value: number, max: number }` |
| `completing` | `{}` |
| `complete` | `{ records: GenerationRecord[] }` — single-element array; matches image-mode shape |
| `error` | `{ message: string }` |

The route reads each source clip from its media-type-appropriate directory via `dirForGeneration` (image → `IMAGE_OUTPUT_DIR`; stitched → `STITCH_OUTPUT_DIR`; otherwise `VIDEO_OUTPUT_DIR`), with `??` fallbacks across the three env vars so co-located output directories degrade gracefully. The output `.mp4` always writes to `STITCH_OUTPUT_DIR`. The shared helper lives in `src/lib/outputDirs.ts` and is also used by `src/app/api/extract-last-frame/route.ts`.

On success: updates the `Generation` row with `width/height/frames/fps`, then calls `manager.finalizeStitchSuccess()`. On error: `unlink(outputPath)` + `prisma.generation.delete()` + `manager.finalizeStitchError()`. Client disconnect (req.signal abort) detaches the SSE subscriber but does NOT kill ffmpeg (refresh survivability). Explicit abort (`DELETE /api/jobs/[promptId]`) calls `abortJob()` → kills the ffmpeg child process via SIGTERM + deletes the partial output file.

### `ComfyWSManager` additions (Phase 3)

New `StitchJob` interface alongside `ImageJob` and `VideoJob`. Public methods: `registerStitchJob()`, `setStitchProcess()`, `updateStitchProgress()`, `finalizeStitchSuccess()` (no-op if already finalized), `finalizeStitchError()` (no-op if already aborted). `abortJob()` for stitch jobs kills the child process and deletes the partial output — no `/interrupt` call to ComfyUI.

### UI

**Stitch button** — sits alongside "Generate new clip" in `ProjectDetail`. Disabled when the project has no clips at all; the modal itself handles the no-video-clips case with an empty state message.

**`StitchModal`** — bottom sheet. Idle state (has video clips): per-clip selection list (checkboxes, all checked by default) + "Select all / Deselect all" links + live summary ("Stitching X of Y clips, Z.Zs total") + transition selector (hard-cut / crossfade 0.5s) + "Stitch N clips" button (disabled if < 2 selected) + Cancel button. Image clips are excluded from the list entirely. Idle state (no video clips): empty-state message. Running state: ffmpeg progress bar + Abort button. Done state: success message + Close button. Error state: error text + Try again / Close buttons. Wires into `QueueContext` (`addJob`, `setCompleting`, `completeJob`, `failJob`) so the stitch appears in `QueueTray`. Passes `clipIds` (selected, in displayed order) to `POST /api/projects/[id]/stitch`.

**Stitched exports** — rendered as non-draggable `StitchedTile` elements directly in the clip strip (no separate section). New stitches are prepended optimistically to `stitchedExports` state, which feeds into the strip alongside `clips`. Select "Videos" in the filter bar to see only stitched outputs.

**Gallery badge** — emerald **Stitched** pill in the top-left corner of Gallery tiles with `isStitched: true`.

**`ImageModal` metadata** — stitched videos show "Stitched from project: [name]" (tappable link to project) or "Project deleted" if `parentProjectId` is null. Source clips line: Phase 3 rows (plain `string[]` format) show "Source clips: N"; Phase 3.1+ rows (`{ selected, total }` format) show "Source clips: X of N from project [name]" (project name omitted if project was deleted).

**`QueueTray`** — stitch jobs show a chain/link SVG icon in `text-emerald-400`.

---

## Delete confirmation pattern

Destructive actions in the app share a single confirm-dialog pattern: `<DeleteConfirmDialog>` opens a modal with a clearly-labeled destructive button (red/Delete) and a Cancel button. Tap to confirm — no text input required. The dialog focuses Cancel by default, so an accidental tap-anywhere doesn't delete. Escape and backdrop-click cancel. Applied to project deletes, gallery modal deletes (image and video clips), and model-tab deletes (checkpoints, LoRAs, embeddings).

Project cascade delete (the "Delete everything" option) adds a 2-second initial delay before the Delete button enables — its scope is large enough to warrant slight extra friction. The button shows a `Wait… Xs` countdown during the delay. Switching back to "Keep items" immediately enables Delete (no delay for the safer choice).

The gallery's tile-level two-tap delete pattern is intentionally NOT routed through this dialog — different intents (sweep cleanup vs. deliberate single-item deletion) get different friction levels.

Component: `src/components/DeleteConfirmDialog.tsx`. Props: `open`, `resourceType` (`'project' | 'clip' | 'checkpoint' | 'lora' | 'embedding'`), `resourceName`, `onConfirm`, `onCancel`, `warningMessage?`, `cascadeInfo?`. Enter confirms when Delete is enabled; Escape and backdrop-click cancel.

---

## Not yet implemented (planned features)

**Live step previews.** The architecture spec calls for catching the intermediate base64 preview images ComfyUI streams during sampling and displaying them in the UI as a live preview (updating every N steps). Currently `GenerationProgress` only shows a progress bar during generation and the final image on completion.

To implement: `onBinary()` in `comfyws.ts` already captures the latest image buffer on every binary WS frame. Intermediate previews arrive as binary frames with event type `1` (`PREVIEW_IMAGE`) before the final `SaveImageWebsocket` frame. The data is a JPEG. Wiring this up requires:
1. Converting each intermediate buffer to a base64 data URL in `onBinary()`.
2. Adding a new `preview` SSE event alongside `progress`.
3. Displaying the data URL in `GenerationProgress` while generation is in flight.

## Next.js config notes

- Using Next.js **14.2** (not 15). `next.config.ts` is not supported — config is `next.config.mjs`.
- `serverComponentsExternalPackages` (not the v15 `serverExternalPackages`) for `ws` and `@prisma/client`.
- `images.unoptimized: true` — generated images are served via `/api/images/[filename]`, which reads from `IMAGE_OUTPUT_DIR` (an absolute path outside the repo, set in `.env`). DB rows store the URL path `/api/images/<filename>` regardless of where the files live on disk.
- `tsconfig.json` sets `"target": "es2017"` — required for `Map.values()` iteration to compile without `--downlevelIteration`.
