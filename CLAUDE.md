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

### 4. Network & API Routing Rules
All communication between the Next.js frontend/backend and the A100 Core VM MUST route through the established local SSH tunnels. The Next.js API should NEVER attempt to contact `100.96.99.94` directly. 

Use the following `localhost` / `127.0.0.1` ports for all fetch requests:
* **ComfyUI (Image Generation):** `http://127.0.0.1:8188`
* **LLM / Prompt Polish:** `LLM_ENDPOINT` env var (typically `http://127.0.0.1:11438/v1/chat/completions`)
---

## Environment

```
DATABASE_URL=postgresql://...        # local Postgres
IMAGE_OUTPUT_DIR=/home/charlie/illustrator-images  # absolute path for generated image files (outside repo)
GALLERY_PAGE_SIZE=30                 # records per page for gallery infinite-scroll (default 30, max 100)
COMFYUI_URL=http://localhost:8188    # ComfyUI HTTP API
COMFYUI_WS_URL=ws://localhost:8188   # ComfyUI WebSocket
CIVITAI_TOKEN=...                    # CivitAI API token, used by add_model.sh and ingest API
A100_VM_USER=charlie                 # SSH username for the Azure VM
A100_VM_IP=100.96.99.94              # Tailscale IP of the Azure VM
A100_SSH_KEY_PATH=/home/charlie/.ssh/a100-key.pem  # Private key for VM SSH
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

Each checkpoint config can store recommended generation defaults: steps, CFG, sampler, scheduler, width, height, and hi-res fix on/off. These are set via the collapsible **Default generation settings** section in ModelConfig's Checkpoints sub-tab. When the user explicitly selects a checkpoint in Studio's picker, any non-null defaults are soft-filled into the corresponding image-form fields. Width and height are always applied (existing behaviour). Null fields are left alone. Selection is soft-fill — choosing a second checkpoint applies only its own non-null defaults; it does not reset fields that had no default on the first checkpoint. The soft-fill fires only on an explicit user pick, not on the auto-selection that occurs at mount time (so a page refresh respects the user's last-session values). This applies to the image form only; the video form is unaffected.

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
Deletes project. DB `onDelete: SetNull` drops clips to project-less. Returns `{ ok: true }`.

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

SSE events: same shape as the image progress route — `progress`, `complete`, `error`. The `complete` event carries `{ id, filePath, frames, fps, seed, createdAt }`.

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
  lib/
    comfyws.ts          WS singleton, binary parsing, SSE fan-out, file save, DB insert; tracks promptSummary/startedAt/progress per job; recentlyCompleted cache (5 min); getActiveJobs()
    notification.ts     playChime() Web Audio API bell tone; requestNotificationPermission(); sendBrowserNotification()
    workflow.ts         buildWorkflow() — image path
    wan22-workflow.ts   buildT2VWorkflow(), buildI2VWorkflow() — Wan 2.2 video path; exports VideoParams, ComfyWorkflow
    wan22-templates/    wan22-t2v.json, wan22-i2v.json — API-format ComfyUI workflow templates (runtime data; do not reference prompts/ at runtime)
    prisma.ts           Prisma client singleton (global.__prisma)
    imageSrc.ts         imgSrc(filePath) helper — handles legacy /generations/ paths
    civitaiIngest.ts    SSH-driven CivitAI metadata fetch + download to A100 VM; supports type: 'checkpoint' | 'lora' | 'embedding'; embeddings go to /models/ComfyUI/models/embeddings/
    civitaiUrl.ts       parseCivitaiInput(input) — accepts CivitAI URLs and Air strings (urn:air:...); alias parseCivitaiUrl kept for backwards compat; returns canonicalUrl, type, baseModel; type now includes 'embedding'
    registerModel.ts    DB upsert logic shared by /api/models/register and ingest; handles checkpoint, lora, and embedding types; includes extractCategoryFromTags() heuristic
    systemLoraFilter.ts isSystemLora() / filterSystemLoras() — hides system-managed LoRAs (IP-Adapter companion weights) from user-facing API responses
    useModelLists.ts    React hook: shared fetcher for /api/models + /api/checkpoint-config + /api/lora-config + /api/embedding-config; consumed by ModelSelect and ModelConfig
  types/
    index.ts            GenerationParams, GenerationRecord (now includes projectId/projectName), ModelInfo (now includes embeddings[]), EmbeddingConfig,
                        ProjectSummary, ProjectDetail, ProjectClip, SSEEvent, SAMPLERS, SCHEDULERS, RESOLUTIONS constants
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
    ImageModal.tsx      bottom-sheet modal with full image + all metadata fields; shows Project link for video clips
    Projects.tsx        Projects tab — 2-col project card grid, New Project modal
    ProjectDetail.tsx   Project detail view — inline-editable header, horizontal DnD clip strip (@dnd-kit), Settings modal
    ModelConfig.tsx     Model Settings tab; sub-tabs Checkpoints / LoRAs / Embeddings / Add Models; saves trigger onSaved (increments modelConfigVersion); Embeddings sub-tab has copy-to-clipboard for embedding:name usage syntax
    IngestPanel.tsx     CivitAI URL paste form for single + batch model ingestion (Add Models sub-tab)
    ServerBay.tsx       Admin tab; Illustrator Stack card with Start All/Stop All (sequential with progress) + individual service rows + Check Status
    GalleryPicker.tsx   Modal for selecting a gallery image as I2V starting frame; images-only filter (mediaType=image), infinite scroll, no delete/remix/favorite actions
  contexts/
    QueueContext.tsx    Global job queue state; Context + useReducer; notification side effects; 5 s polling while jobs run; 30 s auto-dismiss for done jobs

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
| `steps` | Even integer, 4–40 inclusive |
| `cfg` | Number, 1.0–10.0 inclusive |
| `mode='i2v'` | `startImageB64` required |
| `mode='t2v'` | `startImageB64` forbidden |

### `/api/generate-video` endpoint

**Request:** POST with JSON body `{ mode, prompt, negativePrompt?, width, height, frames, steps, cfg, seed?, startImageB64? }`.

**Response:** SSE stream. Events:
| event | data shape |
|-------|-----------|
| `progress` | `{ value: number, max: number }` |
| `complete` | `{ id, filePath, frames, fps, seed, createdAt }` |
| `error` | `{ message: string }` |

**Watchdog timeout:** 15 minutes (image jobs use 10 minutes). Set via `registerVideoJob`'s `timeoutMs` parameter.

**DB record:** `Generation` row with `mediaType: 'video'`, `frames`, `fps: 16`, `model: 'wan2.2-t2v'` or `'wan2.2-i2v'`. `sampler: 'euler'`, `scheduler: 'simple'` are hardcoded (Wan 2.2 defaults).

### Studio UI (Phase 1.2a)

A pill toggle at the top of Studio switches between **Image** and **Video** modes. Mode persists for the session via `sessionStorage`. Positive prompt and seed carry across when switching; all other params reset to that mode's defaults. The mode toggle is disabled while a generation is in-flight.

**Video mode — always-visible controls:**

| Control | Notes |
|---|---|
| Positive prompt | required |
| Negative prompt | hidden — hint: "Default Wan 2.2 negative prompt applied." |
| Starting frame toggle + picker | On → I2V mode; Off → T2V mode |
| "Use last frame of previous clip" checkbox | Only shown when project context has a prior clip |
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

The settings drawer is mode-aware: opening it in image mode shows checkpoint/LoRA/generation/sampling controls; opening it in video mode shows resolution/frames/steps/cfg/seed controls. Switching modes while the drawer is open immediately shows the new mode's controls. Closing and reopening preserves all entered values (state lives in the parent form, not the drawer).

Image-mode-only controls are hidden in Video mode: checkpoint selector, LoRA stack, ReferencePanel, Hi-Res Fix, sampler/scheduler, batch size, and the Polish button.

**Starting frame picker:** When the starting frame toggle is On, a "Pick from gallery" button appears. Clicking it opens `GalleryPicker` — a modal that shows the gallery grid filtered to `mediaType=image` only. Selecting an image closes the modal and populates a thumbnail preview. The × button clears the selection (keeps the toggle on). The i2v `startImageB64` field is populated by fetching the selected image's URL client-side and base64-encoding it at submit time.

**Generate Video button:** replaces the image-mode "Generate" button. POSTs to `/api/generate-video` as a streaming fetch (not EventSource, since the route is a direct POST→SSE response). Progress and error events are parsed from the SSE stream inline. On `complete`, a `<video>` element is shown in Studio with controls/loop.

**Queue UX (Phase 1.2b):** The Generate/Generate Video buttons are never locked. Each submit adds a job to the queue and returns immediately. See **Queue UX** section below.

---

### Queue UX (Phase 1.2b)

**Concurrency model.** Submitting a generation never locks the form. Each submit immediately adds a job to the in-memory `ActiveJob` queue (client-side, `QueueContext`) and returns. Multiple image, video, or mixed jobs can run concurrently. The queue is single-user and has no cap.

**`QueueContext` (`src/contexts/QueueContext.tsx`).** React Context + useReducer. Provides:
- `addJob`, `updateProgress`, `setCompleting`, `completeJob`, `failJob`, `removeJob` — called from Studio's SSE handlers
- `toggleMute` / `muted` — persisted to localStorage (`queue-muted`)
- `toasts` / `dismissToast` — in-app toast list (one per completion)
- `requestPermissionIfNeeded` — requests browser notification permission on first submit; denial stored in localStorage (`queue-notif-perm`) and never re-prompted

**`QueueTray` (`src/components/QueueTray.tsx`).** Badge + dropdown in the Studio header (right of the mode toggle). Badge shows count of running jobs; invisible at zero. Expanded dropdown shows one row per job with: media-type icon, prompt summary (60 chars), progress bar (`N/total steps` or `Saving…`), elapsed time, abort button (×), View link (done), and dismiss button (done/error). Mute toggle (speaker icon) in the tray header. Closes on click-outside or Escape.

**Notification chain** (fires on `completeJob`):
- **Audio chime:** synthesised via Web Audio API (880 Hz → 660 Hz bell tone, ~0.8 s). Skipped if muted.
- **In-app toast** (`src/components/Toast.tsx`): "Image/Video generated" card in bottom-right, auto-dismisses after 5 s. Rendered at page level via `ToastContainer`.
- **Browser Notification API:** fires if `document.hidden` and `Notification.permission === 'granted'`. `onclick` focuses the tab.

**Refresh survivability.** SSE stream close is treated as silent — it just stops pushing events to that subscriber. The job continues on the VM. To intentionally abort a running job, the client calls `POST /api/jobs/[promptId]/abort`. This separation is what makes refresh survivability work: a refresh closes the SSE stream, the job stays alive on the server, the next `/api/jobs/active` poll on mount finds it, and the tray reattaches.

`GET /api/jobs/active` returns all running jobs + recently-completed jobs (5-min cache). On Studio mount, this endpoint is fetched and any found jobs are added to the queue without re-notifying. The `QueueContext` polls this endpoint every 5 s while any jobs are `running` or `completing`, detecting completions via status transitions.

**`completing` status.** When GPU computation ends (`execution_success`), `finalizeJob` emits a `completing` SSE event before the async save. The client transitions the job to `completing` status and shows `Saving…` in the tray — especially noticeable for video (2-min HTTP transfer from VM).

**Abort.** Clicking × in the tray sends `DELETE /api/jobs/{promptId}` (or `POST /api/jobs/{promptId}/abort`). The server calls `manager.abortJob`, sends an `error` SSE event (`'Aborted by user'`) to any live subscriber, closes the SSE stream, adds to `recentlyCompleted`, and (for video) fires SSH cleanup. The in-tab SSE handler calls `failJob`; post-refresh polling detects it via `recentlyCompleted`. `abortJob` also fires `POST /interrupt` to ComfyUI fire-and-forget, releasing the GPU immediately rather than letting the cancelled workflow finish naturally.

**New API routes:**
| Route | Description |
|---|---|
| `GET /api/jobs/active` | Returns running + recently-completed jobs from comfyws singleton. Shape: `{ jobs: ActiveJobInfo[] }`. |
| `DELETE /api/jobs/[promptId]` | Aborts a job: calls `abortJob`, sends error SSE, closes stream, SSH cleanup (video), adds to recentlyCompleted. |
| `POST /api/jobs/[promptId]/abort` | Same as DELETE — preferred explicit-abort endpoint. Returns 200 `{ ok: true }` or 404 if the job is not active. |

**`init` SSE event (video only).** `/api/generate-video` emits an `init` event as the first SSE frame with `{ promptId, generationId }` so the client can add the job to the queue before any `progress` events. Image jobs get promptId from the synchronous JSON response of `POST /api/generate`.

### Gallery (Phase 1.3)

Video generations appear in the Gallery alongside images:

- **Tile thumbnails:** `<video preload="metadata">` — the browser fetches enough to render the first frame as a poster; no separate thumbnail asset needed.
- **Duration badge:** Bottom-right corner of every video tile, dark pill: `${(frames / fps).toFixed(1)}s`. Render-only on `mediaType === 'video'` tiles.
- **Modal playback:** `<video controls autoPlay loop playsInline>` with native HTML5 controls. No `muted` attribute — Wan 2.2 generates no audio, so autoplay without mute is permitted. Previous/Next navigation works across mixed media respecting any active filter.
- **Sidebar metadata (modal):** Frames and FPS rows shown for video; sampler/scheduler/HRF shown for image.
- **All/Images/Videos filter:** Pill toggle group in the filter bar alongside the favorites toggle. Default: All. Passes `mediaType=image` or `mediaType=video` to `GET /api/gallery`. Combines with favorites filter (AND).
- **Remix from video:** Switches Studio to Video mode and populates the video form with prompt, width, height, frames, steps, cfg. The starting frame is not restored — re-pick from gallery if desired.
- **Delete/favorite:** Work identically for video — the delete endpoint and favorite toggle are media-type-agnostic.

`GET /api/gallery` accepts an optional `mediaType` query parameter (`image` or `video`). Omitting it returns all generations. Combines with `isFavorite=true` as an AND filter.

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
  defaultFrames  Int?
  defaultSteps   Int?
  defaultCfg     Float?
  defaultWidth   Int?
  defaultHeight  Int?
  createdAt      DateTime     @default(now())
  updatedAt      DateTime     @updatedAt
  generations    Generation[]
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
| `GET /api/projects/[id]` | Full project + ordered clips. Response: `{ project: ProjectDetail, clips: ProjectClip[] }`. |
| `PATCH /api/projects/[id]` | Partial update — name, description, styleNote, defaultFrames/Steps/Cfg/Width/Height. |
| `DELETE /api/projects/[id]` | Delete project; clips set `projectId=null` via DB cascade. Returns `{ ok: true }`. |
| `PATCH /api/projects/[id]/reorder` | Reorder clips: `{ clipOrder: string[] }`. Validates all IDs belong to this project; updates `position` in a Prisma transaction. |

### Projects tab and UI

**Projects** tab is positioned between Studio and Gallery in the tab bar. It has two sub-views:

**Listing view** (`Projects.tsx`): 2-column card grid. Each card shows a cover frame (most-recent clip), project name, description, clip count, and relative last-updated time. "+ New Project" button top-right. Empty state shows a CTA button. Clicking a card navigates to the detail view.

**New Project modal**: Form with name (required), description, style note, and a collapsible "Default settings" section (resolution presets + frames/steps/CFG number inputs). POSTs to `/api/projects`.

**Project detail view** (`ProjectDetail.tsx`):
- Header: back button, inline-editable name and description, Settings gear, overflow menu (Delete, two-tap confirm).
- Style note rendered in a muted box below description (read-only; editable via Settings modal).
- **"Generate new clip in this project" button** — tapping navigates to Studio with the project's context pre-loaded (see Phase 2.2 below).
- **Linear strip**: horizontal-scrollable `DndContext` + `SortableContext` (`@dnd-kit/core` + `@dnd-kit/sortable`). Each tile is a `<video preload="metadata">` thumbnail with position badge (top-left) and duration badge (bottom-right). Click opens `ImageModal` scoped to project clips.
- Drag to reorder: optimistic update, then `PATCH /api/projects/[id]/reorder`. Reverts on error with a brief toast.
- Empty strip: placeholder text.
- **Settings modal**: description, style note, and default generation params (resolution presets + frames/steps/CFG inputs). PATCHes `/api/projects/[id]`.
- **Play-through toggle** (hidden on 0–1 clips): replaces strip with a single `<video>` player that chains all clips end-to-end. `onEnded` advances to the next clip via `load()` + `play()`. Clip-index chips allow jumping to any clip. "Play again" button shown after the last clip finishes. See **Play-through preview** below.

### Gallery integration

`GenerationRecord` now includes `projectId: string | null` and `projectName: string | null`. The gallery API (`/api/gallery`) includes the project relation. `ImageModal` shows a **Project** row in the metadata footer for video clips: a tappable link to the project, or "None". `Gallery` accepts `onNavigateToProject` callback to wire the link back to the Projects tab.

### Project-aware generation (Phase 2.2)

Clicking "Generate new clip in this project" calls `onGenerateInProject(project, latestClip)` which propagates up to `page.tsx` → sets `projectContextTrigger` → Studio picks it up via `useEffect`.

**Studio project context** (`ProjectContext` type in `src/types/index.ts`):
- `projectId`, `projectName` — for the badge and the `/api/generate-video` `projectId` field.
- `latestClipId` — for last-frame extraction.
- `latestClipPrompt` — carried forward into the positive prompt textarea.
- `defaults` — `frames/steps/cfg/width/height`, each nullable; Studio falls back to `VIDEO_DEFAULTS` for unset fields.

**Project badge**: shown in Studio header when project context is active. Has a × button to clear it. Persisted via `sessionStorage` key `studio-project-context` so it survives refresh (same pattern as `studio-mode`).

**Form pre-fill**: on context load, Studio switches to Video mode, sets `videoP` from project defaults (with `VIDEO_DEFAULTS` fallback), and sets `positivePrompt` from the latest clip's prompt.

**Prompt threading**: `latestClip?.prompt` is the `promptPos` of the highest-positioned clip in the project. Carry-forward puts it in the textarea so the user can edit before generating.

**Remix vs. project flow**: remix from gallery always clears project context. Remixing is a fresh starting point; re-generating within a project uses the "Generate new clip" button.

### Prompt threading and last-frame extraction (Phase 2.2)

When Studio has project context and a `latestClipId`, a **"Use last frame of previous clip"** checkbox appears in the Starting frame (I2V) section:

- Checking it implicitly enables I2V mode (turns on the Starting frame toggle) and hides the gallery picker.
- On submit, Studio calls `POST /api/extract-last-frame` with the `latestClipId`, gets a `data:image/png;base64,...` data URI, strips the prefix, and sends the raw base64 as `startImageB64` to `/api/generate-video`.
- While extraction runs, a spinner appears and the Generate Video button is disabled.

### Play-through preview (Phase 2.2)

Single `<video ref={playerRef}>` element. `playingIdx` state tracks the current clip. `onEnded` increments it (or sets `playDone`). A `useEffect` on `[playingIdx, playThrough]` calls `playerRef.current.load()` then `.play()` when the index advances.

- Clip chips (numbered buttons) jump directly to any clip.
- "Play again" button at end resets to index 0.
- Wan 2.2 generates no audio; no click/gap handling needed at this stage. Video stitching (Phase 3) will solve seamless playback.
- Toggle hidden when project has 0 or 1 clips.

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
