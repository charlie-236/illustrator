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
Returns `{ checkpoints: string[], loras: string[] }` by calling ComfyUI's `/object_info/CheckpointLoaderSimple` and `/object_info/LoraLoader`. 5-second timeout via `AbortSignal.timeout(5000)`. Returns empty arrays on failure so the UI degrades gracefully.

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
SSH-based service status check. Opens a single SSH session, runs `systemctl is-active {unit}` for all three services in one command, and returns:
```ts
{ statuses: Record<ServiceName, 'active' | 'inactive' | 'unknown'> }
```
Exit code `0` from `systemctl is-active` → `active`; anything else → `inactive`. If SSH fails entirely, returns HTTP 500. `ServiceName` is `'comfy-illustrator' | 'aphrodite-writer' | 'aphrodite-illustrator-polisher'`.

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

### `POST /api/models/ingest`
SSE-streamed single-model ingestion. Body: `{ type: 'checkpoint' | 'lora', modelId: number, parentUrlId: number }`. Performs metadata fetch + download to A100 VM + size validation + DB upsert via SSH, emitting per-phase progress events. Used by the in-app ingestion UI; `add_model.sh` remains as a desktop fallback that posts to `/api/models/register` directly.

Phase events: `metadata`, `download`, `validate`, `register`, `done`, `error`. Error events may include an `orphanPath` field pointing to a file that exists on the VM but has no DB entry.

### `POST /api/models/ingest-batch`
Same as `/ingest` but accepts `{ items: [...] }` with up to 20 items. Each item extends the single-item body with a caller-supplied `clientId` string. Processes items sequentially and emits `item` events tagged with `clientId`, plus a final `summary` event with `{ succeeded, failed, total }`.

## Source layout

```
src/
  app/
    layout.tsx          root layout, sets dark theme + viewport meta
    page.tsx            tab state (studio | gallery | models | admin); passes refreshToken to Gallery, modelConfigVersion to Studio, onSaved to ModelConfig
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
      services/status/       GET  — SSH systemctl is-active for all four services
      generate/polish/route.ts     POST — LLM prompt expansion with frozen-token validation
      generate/polish/prompt.ts    POLISH_SYSTEM_PROMPT, POLISH_SAMPLING, STATIC_NEGATIVE constants
      generate/polish/validate.ts  extractFrozenTokens(), validatePreservation()
  lib/
    comfyws.ts          WS singleton, binary parsing, SSE fan-out, file save, DB insert
    workflow.ts         buildWorkflow()
    prisma.ts           Prisma client singleton (global.__prisma)
    imageSrc.ts         imgSrc(filePath) helper — handles legacy /generations/ paths
    civitaiIngest.ts    SSH-driven CivitAI metadata fetch + download to A100 VM; supports type: 'checkpoint' | 'lora' | 'embedding'; embeddings go to /models/ComfyUI/models/embeddings/
    civitaiUrl.ts       parseCivitaiInput(input) — accepts CivitAI URLs and Air strings (urn:air:...); alias parseCivitaiUrl kept for backwards compat; returns canonicalUrl, type, baseModel; type now includes 'embedding'
    registerModel.ts    DB upsert logic shared by /api/models/register and ingest; handles checkpoint, lora, and embedding types; includes extractCategoryFromTags() heuristic
    systemLoraFilter.ts isSystemLora() / filterSystemLoras() — hides system-managed LoRAs (IP-Adapter companion weights) from user-facing API responses
    useModelLists.ts    React hook: shared fetcher for /api/models + /api/checkpoint-config + /api/lora-config; consumed by ModelSelect and ModelConfig
  types/
    index.ts            GenerationParams, GenerationRecord, ModelInfo (now includes embeddings[]), EmbeddingConfig, SSEEvent,
                        SAMPLERS, SCHEDULERS, RESOLUTIONS constants
  components/
    TabNav.tsx          sticky header with Studio / Gallery tabs
    Studio.tsx          full generation form; owns all GenerationParams state + SSE lifecycle; renders ReferencePanel between prompts and the generate bar
    ReferencePanel.tsx  img2img + FaceID identity reference upload zones (collapsible card in Studio)
    PromptArea.tsx      labelled textarea
    ModelSelect.tsx     checkpoint + LoRA dropdowns; re-fetches /api/models + configs when refreshToken changes (incremented by ModelConfig saves) or when the user taps the Refresh button in the picker sheet
    ParamSlider.tsx     range slider + number input pair
    GenerationProgress.tsx  progress bar (during gen) or result image (on complete)
    Gallery.tsx         3-col image grid, cursor-based infinite-scroll via IntersectionObserver, opens ImageModal
    ImageModal.tsx      bottom-sheet modal with full image + all metadata fields
    ModelConfig.tsx     Model Settings tab; sub-tabs Checkpoints / LoRAs / Embeddings / Add Models; saves trigger onSaved (increments modelConfigVersion); Embeddings sub-tab has copy-to-clipboard for embedding:name usage syntax
    IngestPanel.tsx     CivitAI URL paste form for single + batch model ingestion (Add Models sub-tab)
    ServerBay.tsx       Admin tab; Illustrator Stack card with Start All/Stop All (sequential with progress) + individual service rows + Check Status

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

**Embeddings (textual inversions):** Supported as a third type alongside checkpoints and LoRAs. Ingested via the same Add Models tab — select the "Embedding" radio (or paste an Air string with `type=embedding`). The file downloads to `/models/ComfyUI/models/embeddings/` on the VM. After ingestion, browse and edit metadata in the Models tab → Embeddings sub-tab. To use an embedding in a generation, type `embedding:<filename-without-extension>` directly in the positive or negative prompt in Studio. ComfyUI resolves embeddings by name at prompt-parse time — no workflow changes required. There is no Studio-side picker; users type the syntax manually. The Embeddings sub-tab provides a copy-to-clipboard button for each embedding's usage syntax.

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
