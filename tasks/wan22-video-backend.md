# Batch — Wan 2.2 video generation backend (Phase 1.1)

First step toward video in the app. This batch is **backend only** — no UI work. After this lands, you can hit `/api/generate-video` with curl and get a webm back. Studio integration (Prompt 1.2) and Gallery integration (Prompt 1.3) follow in subsequent batches.

The model is Wan 2.2 (14B fp8 MoE). Models are already on the VM. Two API-format ComfyUI workflows are at `tasks/wan22_t2v.json` and `tasks/wan22_i2v.json`, smoke-tested end-to-end. Read `tasks/video-report.md` carefully — it documents three load-bearing gotchas and the parameter map for the API override layer.

Re-read CLAUDE.md before starting. This batch introduces a **narrow exception** to the disk-avoidance rule, documented in detail below.

---

## The video disk-avoidance pattern

`SaveImageWebsocket` doesn't have a video equivalent in ComfyUI. The video path therefore writes one webm file to the VM filesystem per generation, fetches it via HTTP, and immediately SSH-deletes it. This is intentional and the *only* allowed disk write in the new path.

Concretely, per generation:

1. mint-pc builds a workflow whose only save node is `SaveWEBM`, with `filename_prefix: video-${generation_id}` (so cleanup can glob safely).
2. mint-pc POSTs the workflow to ComfyUI's `/prompt`.
3. WS reports completion with `{filename, subfolder, type}` for the SaveWEBM node.
4. mint-pc fetches `http://127.0.0.1:8188/view?filename=...&subfolder=...&type=output` and streams the response into mint-pc local storage.
5. mint-pc opens an SSH session and runs `rm -f /models/ComfyUI/output/video-${generation_id}*` (glob — covers the 00001_ suffix that SaveWEBM appends, and any partial files from a crashed run).
6. DB row updates to completed.

If any step 3-5 fails: the SSH `rm -f` glob still runs in a `finally` block, so a crashed generation doesn't leave files on the VM. SSH errors during cleanup are logged but don't fail the request — the file is small and can be cleaned manually if it ever matters.

The image path's strict "no SaveImage/no LoadImage" guard does **not** apply to the video path — the video runtime guard is parallel but different (described below).

---

## Required changes

### Schema migration

Read `prisma/schema.prisma` and inspect the existing `Generation` model. Add:

- `mediaType: String` — `"image" | "video"`. Default `"image"` so existing rows backfill correctly. Use a Prisma enum if the project conventions favor enums; otherwise a constrained string is fine — match existing patterns.
- `frames: Int?` — null for images, frame count for videos.
- `fps: Int?` — null for images, frame rate for videos (always 16 for Wan 2.2 in Phase 1).

Don't add `duration_seconds` — derive it as `frames / fps` at the read-side. Don't store derived data.

Generate a migration named `add_video_support`. Test that `npx prisma migrate dev` runs cleanly against a copy of the dev DB before committing.

### `src/lib/wan22-workflow.ts` — workflow builder

Mirror the structure of `src/lib/workflow.ts` (same author, same conventions). Two exported functions:

```ts
export function buildT2VWorkflow(params: VideoParams): ComfyWorkflow;
export function buildI2VWorkflow(params: VideoParams & { startImageB64: string }): ComfyWorkflow;
```

Where `VideoParams` is roughly:

```ts
type VideoParams = {
  generationId: string;       // for SaveWEBM filename_prefix
  prompt: string;
  negativePrompt?: string;    // defaults to the template's Chinese default — see report
  width: number;              // multiple of 32, 256–1280
  height: number;             // multiple of 32, 256–1280
  frames: number;             // (frames - 1) % 8 === 0, i.e. 8N+1; range 17–121
  steps: number;              // even, 4–40
  cfg: number;                // 1.0–10.0
  seed: number;
};
```

Implementation:

1. Copy `tasks/wan22_t2v.json` and `tasks/wan22_i2v.json` into `src/lib/wan22-templates/` (new directory). These are the API-format templates. Import them as JSON modules. Don't reference `tasks/` at runtime — that directory is for tasks to me, not runtime data.

2. For each builder, deep-clone the template, then mutate per the parameter map in `tasks/video-report.md`:

   | Parameter | Node (t2v) | Node (i2v) | Path |
   |---|---|---|---|
   | Positive prompt | 6 | 6 | `inputs.text` |
   | Negative prompt | 7 | 7 | `inputs.text` |
   | Width | 61 | 50 | `inputs.width` |
   | Height | 61 | 50 | `inputs.height` |
   | Frame count | 61 | 50 | `inputs.length` |
   | Seed | 57 | 57 | `inputs.noise_seed` |
   | filename_prefix | 47 | 47 | `inputs.filename_prefix` — set to `video-${generationId}` |

3. **MoE step coupling** — single helper, four writes:

   ```ts
   function applySteps(wf: ComfyWorkflow, total: number) {
     if (total % 2 !== 0) throw new Error('steps must be even');
     const handoff = total / 2;
     wf['57'].inputs.steps = total;
     wf['57'].inputs.end_at_step = handoff;
     wf['58'].inputs.steps = total;
     wf['58'].inputs.start_at_step = handoff;
   }
   ```

   Naively writing only `steps` on both nodes leaves the handoff stuck at 10 and silently breaks sampling at any total ≠ 20. The report flags this; the helper exists to make the four-field write atomic and impossible to forget.

4. **CFG sync** — apply to nodes 57 AND 58 in lockstep. Same reason.

5. **Strip `SaveAnimatedWEBP` (node 28)** in both builders. The template ships with two save nodes; we keep only `SaveWEBM` (47). Deleting node 28 is safe because nothing downstream references it.

6. **i2v only — replace `LoadImage` (node 52) with `ETN_LoadImageBase64`:**

   ```ts
   wf['52'] = {
     inputs: { image: stripDataUriPrefix(startImageB64) },
     class_type: 'ETN_LoadImageBase64',
     _meta: { title: 'Load Image (Base64)' },
   };
   ```

   `ETN_LoadImageBase64` is already in use by `src/lib/workflow.ts` for img2img — no new node-pack dependency. The data URI prefix (`data:image/png;base64,`) must be stripped if present; mirror the helper that already exists in `workflow.ts`.

7. **Do NOT translate or replace the default negative prompt.** It's verbatim Alibaba-recommended Chinese, and the model was trained against that exact string. The report flags this; the builder treats it as immutable unless the caller overrides it explicitly.

### `src/app/api/generate-video/route.ts` — new endpoint

POST endpoint, SSE response (mirror `/api/generate`'s SSE shape so the frontend can reuse the progress consumer in Prompt 1.2).

Request body:

```ts
{
  mode: 't2v' | 'i2v',
  prompt: string,             // required, non-empty
  negativePrompt?: string,    // optional override of template default
  width: number,
  height: number,
  frames: number,
  steps: number,
  cfg: number,
  seed?: number,              // omit → random
  startImageB64?: string,     // required for mode='i2v', forbidden for 't2v'
}
```

Validation (return 400 with a clear error message on any failure):

- `prompt` non-empty after trim.
- `width`, `height` integers, multiples of 32, 256–1280 inclusive.
- `frames` integer, `(frames - 1) % 8 === 0`, 17–121 inclusive.
- `steps` integer, even, 4–40 inclusive.
- `cfg` number, 1.0–10.0 inclusive.
- `mode === 'i2v'` ⟺ `startImageB64` is present.

Flow:

1. Validate. Reject early.
2. Generate `generationId` (use `cuid()` or whatever the existing image path uses — match conventions).
3. Build workflow via `buildT2VWorkflow` or `buildI2VWorkflow`.
4. Run the **video runtime guard** (see below). Throw 500 on failure.
5. Create the DB row with `mediaType: 'video'`, `status: 'pending'` (or whatever the existing pending state is called), all the params for remix-ability.
6. Open SSE response stream.
7. POST workflow to ComfyUI; subscribe to WS for `prompt_id`.
8. Stream sampling progress events (reuse the existing comfyws routing).
9. On `executed` for the SaveWEBM node, extract `{filename, subfolder}`. Check all three keys (`images`, `videos`, `gifs`) — ComfyUI's choice depends on the save node and is version-dependent. The example pipeline's `comfyui_client.py` handles this exact case — mirror its logic.
10. HTTP GET `http://127.0.0.1:8188/view?filename=<f>&subfolder=<s>&type=output` and stream the response to the local storage location used by image generation. Use the same directory layout the existing image pipeline uses — read `/api/generate`'s storage logic and match it (substituting `.webm` for the image extension).
11. SSH `rm -f /models/ComfyUI/output/video-${generationId}*` in a `finally` block — runs whether step 9-10 succeeded or failed.
12. Update DB row to completed with the local file path, `frames`, `fps: 16`.
13. Stream final SSE event with the generation ID; close.

Per-job watchdog: extend the existing comfyws watchdog timeout for video jobs to **15 minutes**. Image generations don't take that long; video routinely does. Don't change the image-path watchdog. The cleanest split is a parameter on whatever the watchdog-arming function is, defaulting to the existing image timeout.

### Video runtime guard

In `route.ts` or a shared helper, before POSTing the workflow:

```ts
function validateVideoWorkflow(wf: ComfyWorkflow): void {
  for (const [nodeId, node] of Object.entries(wf)) {
    const cls = node.class_type;
    if (cls === 'SaveImage') throw new Error(`SaveImage forbidden (node ${nodeId})`);
    if (cls === 'LoadImage') throw new Error(`LoadImage forbidden — use ETN_LoadImageBase64 (node ${nodeId})`);
    if (cls === 'SaveAnimatedWEBP') throw new Error(`SaveAnimatedWEBP should have been stripped (node ${nodeId})`);
  }
}
```

`SaveWEBM` is the explicit exception — allowed in this path only. The image-path guard in `/api/generate` is unchanged and still rejects everything except `SaveImageWebsocket`.

### `src/lib/comfyws.ts` — extend completion routing for video

The existing comfyws.ts is a singleton with per-prompt subscriptions. Extend it (don't fork it):

- The `executed` message handler currently looks for image binary data via WS. For video tasks, no binary frames arrive — the data lives on disk. Add a code path that, when the executed message is for a SaveWEBM node (detect by class_type or by the prompt being marked as a video prompt at registration time), records `{filename, subfolder}` and resolves the prompt's promise with that metadata instead of binary data.
- Cleanest implementation: when a prompt is registered, the caller passes a `mediaType` flag. Video tasks resolve with `{kind: 'video', filename, subfolder}`; image tasks resolve with `{kind: 'image', bytes}` as today.
- Watchdog timeout argument added to the registration call (15 min for video, existing default for image).

If the existing API doesn't expose registration cleanly, factor it out — but minimize churn. The image path's behavior must be byte-for-byte identical after this batch.

---

## Acceptance criteria

- `npm run build` passes clean.
- `npm run typecheck` passes clean (or whatever the project's equivalent is).
- `npx prisma migrate dev` applies cleanly. Existing rows have `mediaType: 'image'`.
- `grep -rn "class_type.*['\"]SaveImage['\"]" src/` returns only SaveImageWebsocket (image path unchanged).
- `grep -rn "class_type.*['\"]LoadImage['\"]" src/` returns only ETN_LoadImageBase64 / ETN_LoadMaskBase64 (image path unchanged; video path uses ETN_LoadImageBase64 too).
- `grep -rn "SaveWEBM" src/` returns matches only in `wan22-workflow.ts`, `generate-video/route.ts`, and the imported template JSON. SaveWEBM never appears in the image path.
- `grep -rn "SaveAnimatedWEBP" src/` returns no matches outside the template JSONs (it's stripped at build time, not present in any code path).
- `wan22-workflow.ts` exports `buildT2VWorkflow` and `buildI2VWorkflow`.
- The four MoE step fields are written by a single helper. `grep -n "end_at_step\|start_at_step" src/lib/wan22-workflow.ts` shows the helper, not scattered writes.
- `/api/generate-video` validates dimensions, frame count, and step count per the rules above and returns 400 with clear messages on each.

Manual smoke test (verify before opening the PR):

1. POST a t2v request via `curl`:

   ```bash
   curl -N -X POST http://localhost:3000/api/generate-video \
     -H 'Content-Type: application/json' \
     -d '{
       "mode": "t2v",
       "prompt": "a robot running through a cyberpunk city, neon signs",
       "width": 1280,
       "height": 704,
       "frames": 57,
       "steps": 20,
       "cfg": 3.5
     }'
   ```

   Expect: SSE stream with sampling progress, completion event after ~5 minutes, generation row in the DB with `mediaType: 'video'` and a valid local file path. The webm file plays in a browser.

2. Confirm post-generation: `ssh a100-core ls /models/ComfyUI/output/video-*` returns nothing. The VM is clean.

3. POST an i2v request with a small base64-encoded image. Same expectations.

4. POST a malformed request (e.g. `frames: 50`) and confirm 400 with a clear error message.

5. Existing image generation via the Studio still works end-to-end. No regression.

Document in the PR description: total wall-clock time observed for a 57-frame t2v generation at 1280×704, and the size of the resulting webm file. Both for capacity-planning when we get to Phase 1.2.

---

## Out of scope

- No UI work. Studio gets a video mode in Prompt 1.2.
- No gallery video playback. Prompt 1.3.
- No model selection — Wan 2.2 14B fp8 is hardcoded for Phase 1.
- No sampler/scheduler selection — euler/simple hardcoded.
- No FPS selection — 16 hardcoded.
- No LoRA support for video. Wan LoRAs exist but the workflow plumbing is its own batch — queue separately if you want it.
- Don't touch the existing image path's class_type guard, watchdog timeout, or storage logic except where the video path explicitly needs to extend them.
- Don't add a Polish equivalent for video tasks. The polisher is SD-tag-tuned; Wan wants prose. Confirmed out of scope by the user.
- Don't expose first+last-frame conditioning. First-frame i2v only for Phase 1.
- Don't add audio support. Wan 2.2 doesn't generate audio natively — the example LTX setup did, Wan doesn't, this is fine.
- Don't try to surface VAE-decode progress in SSE. Sampling-only progress is sufficient for Phase 1.

---

## Documentation

In CLAUDE.md, add a new section "Video generation (Phase 1)" with:

- The disk-avoidance exception, framed as a narrow exception with the rationale (no `SaveVideoWebsocket` exists). State explicitly that SaveWEBM is the *only* allowed disk-write class on the VM, and only via the video path.
- The MoE step coupling: four fields, one helper, why naive overrides break.
- The Chinese negative prompt: don't translate.
- Validation rules for width/height (multiple of 32, 256–1280), frames (8N+1, 17–121), steps (even, 4–40).
- The `/api/generate-video` endpoint: request shape, SSE response shape, watchdog timeout (15 min).

Find the API routes table and add an entry for `POST /api/generate-video`.

Find the source layout section. Add `src/lib/wan22-workflow.ts` and `src/lib/wan22-templates/`.

When done, push and create the PR via `gh pr create` per AGENTS.md. Include in the PR description: the wall-clock observation from smoke test step 1, the webm file size, and confirmation that `ssh a100-core ls /models/ComfyUI/output/video-*` returns nothing post-test.
