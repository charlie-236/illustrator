# Illustrator

Mobile-first ComfyUI generation frontend. Next.js 14 App Router, Tailwind CSS, Prisma + PostgreSQL. Runs locally via PM2 on port **3001**. ComfyUI backend is tunneled to `localhost:8188`.

---

## 🛑 CRITICAL ARCHITECTURE RULES

### 1. The WebSocket Constraint
The remote Azure A100 VM has severely limited disk space. ComfyUI must **NEVER** save images to its local storage.

- **NEVER** use the standard `SaveImage` node in any workflow JSON.
- **ALWAYS** use the `SaveImageWebsocket` node to stream raw image bytes back to the Next.js server.
- **VALIDATION REQUIRED:** After any change to API routes that construct the ComfyUI workflow payload, explicitly scan the generated code to verify the string `"SaveImage"` does not appear as a node `class_type` anywhere in the node graph. Only `"SaveImageWebsocket"` is permitted.

### 2. General Agent Directives
- Before proposing any fix, verify it aligns with the `SaveImageWebsocket` requirement.
- If a package update or ComfyUI node change breaks the WebSocket relay, fixing the relay takes priority over all UI/UX features.

### 3. Tablet-first application
This is a tablet-first application. Every interactive element MUST have a minimum touch target of 48x48 pixels. Use Tailwind classes like min-h-12, min-w-12, p-3, or p-4 to ensure they are easily tappable.

---

## Environment

```
DATABASE_URL=postgresql://...        # local Postgres
COMFYUI_URL=http://localhost:8188    # ComfyUI HTTP API
COMFYUI_WS_URL=ws://localhost:8188   # ComfyUI WebSocket
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
          writes PNG to /public/generations/
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

### Binary image extraction

ComfyUI binary frames carry a format-type word at bytes 4–7 (BE uint32): `2` = PNG (emitted by `SaveImageWebsocket`), `1` = JPEG (live previews from taesd/latent2rgb/auto). `parseImageFrame()` reads that byte, slices from offset 8, and verifies the image magic bytes. If magic doesn't match the declared format it falls back to scanning the first 32 bytes — defensive against protocol drift. JPEG preview frames are dropped at the call site (`onBinary`); only PNG frames are pushed to `imageBuffers`. A `// TODO` marks where JPEG frames should be forwarded to a `preview` SSE event once live previews are wired up.

### SSE job registration split

`POST /api/generate` builds and submits the workflow, gets back `promptId` + `resolvedSeed`, calls `manager.stashJobParams(promptId, params, resolvedSeed)` to store the params server-side (with a 60-second TTL and `baseImage`/`denoise` stripped), and returns immediately. The browser then opens `GET /api/progress/[promptId]` (no query params) which calls `manager.registerJob(promptId, controller)`. `registerJob` looks up and deletes the stashed entry, populating the `Job` record; if the entry has expired or is missing it sends an `error` SSE and closes. This avoids round-tripping `GenerationParams` through the URL, which would exceed header limits when a base image (~1–4 MB base64) is attached.

### Seed resolution

`params.seed === -1` means random. The seed is resolved in `buildWorkflow()` via `Math.floor(Math.random() * 2**32)` and embedded directly into the KSampler node. `extractSeedFromWorkflow()` reads it back from `workflow['5'].inputs.seed`. The resolved seed travels: workflow.ts → `/api/generate` response → `stashJobParams()` → `registerJob()` → `prisma.generation.create()`.

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
| `complete` | `{ imageUrl: string, generationId: string }` |
| `error` | `{ message: string }` |

### `GET /api/models`
Returns `{ checkpoints: string[], loras: string[] }` by calling ComfyUI's `/object_info/CheckpointLoaderSimple` and `/object_info/LoraLoader`. 5-second timeout via `AbortSignal.timeout(5000)`. Returns empty arrays on failure so the UI degrades gracefully.

### `GET /api/gallery?page=1&limit=20`
Paginated. `limit` capped at 50. Returns:
```ts
{ items: GenerationRecord[], total: number, page: number, pages: number }
```

### `GET /api/generation/[id]`
Returns a single `GenerationRecord` or 404.

## Source layout

```
src/
  app/
    layout.tsx          root layout, sets dark theme + viewport meta
    page.tsx            tab state (studio | gallery), passes refreshToken to Gallery
    globals.css         Tailwind directives + utility classes: .input-base, .label, .card
    api/
      models/           GET — checkpoint + lora lists from ComfyUI
      generate/         POST — submit workflow, return promptId
      progress/[promptId]/  GET — SSE stream
      gallery/          GET — paginated DB query
      generation/[id]/  GET — single record
  lib/
    comfyws.ts          WS singleton, binary parsing, SSE fan-out, file save, DB insert
    workflow.ts         buildWorkflow() + extractSeedFromWorkflow()
    prisma.ts           Prisma client singleton (global.__prisma)
    imageSrc.ts         imgSrc(filePath) helper — handles legacy /generations/ paths
  types/
    index.ts            GenerationParams, GenerationRecord, ModelInfo, SSEEvent,
                        SAMPLERS, SCHEDULERS, RESOLUTIONS constants
  components/
    TabNav.tsx          sticky header with Studio / Gallery tabs
    Studio.tsx          full generation form; owns all GenerationParams state + SSE lifecycle
    PromptArea.tsx      labelled textarea
    ModelSelect.tsx     checkpoint + LoRA dropdowns; fetches /api/models on mount
    ParamSlider.tsx     range slider + number input pair
    GenerationProgress.tsx  progress bar (during gen) or result image (on complete)
    Gallery.tsx         3-col image grid, load-more pagination, opens ImageModal
    ImageModal.tsx      bottom-sheet modal with full image + all metadata fields
```

## Workflow node graph

Node IDs used in the ComfyUI API workflow:

| ID | class_type | notes |
|----|-----------|-------|
| 1 | CheckpointLoaderSimple | outputs: model[0], clip[1], vae[2] |
| 2 | EmptyLatentImage | |
| 3 | CLIPTextEncode | positive; clip input = last node in LoRA chain (or node 1 if none) |
| 4 | CLIPTextEncode | negative; same clip source as node 3 |
| 5 | KSampler | seed is the resolved value, never -1 |
| 6 | VAEDecode | |
| 7 | SaveImageWebsocket | terminal node — no disk write on remote |
| 100 | LoraLoader | first LoRA (`params.loras[0]`); inputs from node 1 |
| 101 | LoraLoader | second LoRA (`params.loras[1]`); inputs from node 100 |
| 100+i | LoraLoader | pattern: node ID = `100 + index`; each takes model/clip from the previous node in the chain; final node feeds KSampler + CLIPTextEncode nodes |

## Tailwind conventions

- Page bg: `bg-zinc-950` / Card: `bg-zinc-900` / Input: `bg-zinc-800`
- Borders: `border-zinc-800` (card), `border-zinc-700` (input)
- Accent: `violet-500` / `violet-600` (Generate button, focus rings, slider thumb)
- `.card` = `bg-zinc-900 border border-zinc-800 rounded-xl p-4`
- `.input-base` = full-width styled input/select/textarea with violet focus ring
- `.label` = uppercase xs tracking-wide zinc-400 label

## Not yet implemented (planned features)

**Live step previews.** The architecture spec calls for catching the intermediate base64 preview images ComfyUI streams during sampling and displaying them in the UI as a live preview (updating every N steps). Currently `GenerationProgress` only shows a progress bar during generation and the final image on completion.

To implement: `onBinary()` in `comfyws.ts` already captures the latest image buffer on every binary WS frame. Intermediate previews arrive as binary frames with event type `1` (`PREVIEW_IMAGE`) before the final `SaveImageWebsocket` frame. The data is a JPEG. Wiring this up requires:
1. Converting each intermediate buffer to a base64 data URL in `onBinary()`.
2. Adding a new `preview` SSE event alongside `progress`.
3. Displaying the data URL in `GenerationProgress` while generation is in flight.

## Next.js config notes

- Using Next.js **14.2** (not 15). `next.config.ts` is not supported — config is `next.config.mjs`.
- `serverComponentsExternalPackages` (not the v15 `serverExternalPackages`) for `ws` and `@prisma/client`.
- `images.unoptimized: true` — generated images are served as static files from `/public/generations/`.
- `tsconfig.json` sets `"target": "es2017"` — required for `Map.values()` iteration to compile without `--downlevelIteration`.
