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
- On reconnect (`reconnectAttempts > 0`), calls `flushJobsOnReconnect()` which sends `error` SSE to every pending job and clears the map — in-flight jobs cannot be recovered after a WS drop.

### Binary image extraction

ComfyUI binary WS frames have a variable-length header (4 or 8 bytes depending on version). Rather than hard-coding an offset, `extractImage()` scans the first 32 bytes of the buffer for PNG magic bytes (`89 50 4E 47`) or JPEG magic bytes (`FF D8 FF`) and slices from there. This is robust against header format differences.

### SSE job registration split

`POST /api/generate` builds and submits the workflow, gets back `promptId` + `resolvedSeed`, and returns immediately. The browser then opens `GET /api/progress/[promptId]?params=...&seed=...` which registers the job with the WS manager. The `GenerationParams` and `resolvedSeed` are passed as query params on the SSE URL so the manager has them for the DB insert when the image arrives.

### Seed resolution

`params.seed === -1` means random. The seed is resolved in `buildWorkflow()` via `Math.floor(Math.random() * 2**32)` and embedded directly into the KSampler node. `extractSeedFromWorkflow()` reads it back from `workflow['5'].inputs.seed`. The resolved seed travels: workflow.ts → `/api/generate` response → SSE URL query param → `registerJob()` → `prisma.generation.create()`.

### BigInt serialization

Prisma returns `seed` as `BigInt`. All API routes that return generation records call `.toString()` on it before serialising to JSON. `GenerationRecord.seed` is typed as `string` on the client side.

## Database

Single model. `npx prisma db push` to apply schema changes (no migration files).

```prisma
model Generation {
  id        String   @id @default(cuid())
  filePath  String           // e.g. /generations/1714000000000_abc12345.png
  promptPos String
  promptNeg String
  model     String           // checkpoint filename
  lora      String?          // null when no LoRA used
  seed      BigInt
  cfg       Float
  steps     Int
  width     Int
  height    Int
  sampler   String
  scheduler String
  createdAt DateTime @default(now())
  @@index([createdAt(sort: Desc)])
}
```

## API routes

### `POST /api/generate`
Body: `GenerationParams` JSON.
1. Calls `buildWorkflow(params)` → ComfyUI API-format workflow object.
2. POSTs `{ prompt: workflow, client_id }` to `http://localhost:8188/prompt`.
3. Returns `{ promptId: string, resolvedSeed: number }`.
- No timeout on the ComfyUI fetch — ComfyUI usually responds immediately with a queue ID.

### `GET /api/progress/[promptId]`
Query params: `params` (JSON-encoded `GenerationParams`), `seed` (resolved seed as string).
Returns an SSE stream. Calls `manager.registerJob(promptId, genParams, resolvedSeed, controller)`.

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
