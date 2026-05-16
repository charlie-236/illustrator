# Batch — Migrate image-mode generation to one-call SSE

Today, image generation uses a two-call pattern: POST `/api/generate` returns `{ promptId, resolvedSeed }` synchronously; the browser then opens `EventSource('/api/progress/[promptId]')` to receive progress events. The route bridges these via `manager.stashJobParams()` (60-second TTL); the `/api/progress` route consumes the stash via `manager.registerJob()`. Video and stitch use a one-call POST-streaming-SSE pattern with no stash. Two patterns, two stash mechanisms, two parsing paths in Studio.

Migrate image to the video/stitch one-call pattern. Result: one consistent SSE pattern across all generation types, no stash, no `/progress` route, simpler `comfyws.ts`. **No user-visible behavior changes** — same form, same generate button, same progress, same result grid, same refresh-recovery via active-jobs poll.

**This is a transport-layer-only refactor.** The image generation workflow itself (SaveImageWebsocket, ETN_LoadImageBase64, ETN_LoadMaskBase64, `finalizeImageJob` writing to `IMAGE_OUTPUT_DIR` on mint-pc) is untouched. The disk-avoidance contract — no images on the VM, ever — is preserved by virtue of not modifying any of the code paths that enforce it.

Re-read CLAUDE.md before starting. Disk-avoidance is non-negotiable; verify before claiming done that the WS-hijack and ETN_LoadImageBase64 patterns are unchanged.

---

## What changes

### `src/app/api/generate/route.ts` — return SSE stream instead of JSON

Restructure to mirror `/api/generate-video`'s shape. Existing logic before the response stays:

1. Validation (mask, referenceImages, projectId, prompts, seed contract, etc.) runs unchanged.
2. Prompt assembly (checkpoint defaults + LoRA triggers + user prompts) runs unchanged.
3. `buildWorkflow(workflowParams)` runs unchanged.
4. The forbidden-class-type check runs unchanged.
5. POST to ComfyUI `/prompt` runs unchanged.

The change is in what's returned. Instead of stashing params and returning JSON, open an SSE response stream:

```ts
const sseEncoder = new TextEncoder();
const stream = new ReadableStream<Uint8Array>({
  start(controller) {
    // Strip the four large fields before passing to manager.
    // Today this stripping is split between the route (referenceImages, mask)
    // and stashJobParams (baseImage, denoise) — consolidate at the boundary.
    const { referenceImages: _ri, mask: _mk, baseImage: _bi, denoise: _d, ...paramsForJob } = params;

    controller.enqueue(
      sseEncoder.encode(`event: init\ndata: ${JSON.stringify({ promptId, resolvedSeed })}\n\n`),
    );

    manager.registerJob(
      promptId,
      paramsForJob as GenerationParams,
      resolvedSeed,
      finalPositive,
      finalNegative,
      controller,
    );

    // Client disconnect — detach controller; job continues for refresh-survivability.
    // SSE close ≠ user intent. Do NOT abort the job here. (Same pattern as video/stitch.)
    req.signal.addEventListener('abort', () => {
      manager.removeSubscriber(promptId, controller);
      try { controller.close(); } catch { /* already closed */ }
    });
  },
});

return new Response(stream, {
  headers: {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  },
});
```

Pre-stream errors (validation failures, ComfyUI unreachable, forbidden class_types) still return as JSON with the appropriate status code — the client distinguishes "POST returned non-OK status" from "POST started SSE stream" via `res.ok` and `Content-Type` checks (mirror video route's existing error-handling pattern).

### `src/lib/comfyws.ts` — `registerJob` takes params inline

The new signature mirrors `registerVideoJob`:

```ts
registerJob(
  promptId: string,
  params: GenerationParams,
  resolvedSeed: number,
  assembledPos: string,
  assembledNeg: string,
  controller: ReadableStreamDefaultController<Uint8Array>,
): void {
  const timeoutId = setTimeout(() => this.expireJob(promptId), IMAGE_JOB_TIMEOUT_MS);
  const promptSummary = params.positivePrompt.slice(0, 60).trim() || 'Image generation';

  this.jobs.set(promptId, {
    promptId,
    mediaType: 'image',
    params,
    resolvedSeed,
    assembledPos,
    assembledNeg,
    controller,
    imageBuffers: [],
    activeNode: null,
    finalized: false,
    timeoutId,
    promptSummary,
    startedAt: Date.now(),
    runningSince: null,
    progress: null,
  });
}
```

### Delete the stash mechanism

After `registerJob` accepts inline params, the stash has no consumers. Remove:

- `stashJobParams()` method on `ComfyWSManager`
- The `pendingParams` Map field
- The TTL purge loop inside `stashJobParams` (which iterated `pendingParams` to drop entries older than 60s)
- The `PendingJobEntry` interface / type if exported

`grep -n "stashJobParams\|pendingParams" src/` after the change should return nothing.

### Delete `src/app/api/progress/[promptId]/route.ts`

After the change, image submissions go straight to SSE via POST. The `/progress` route has no consumers.

**Verify before deleting:** `grep -rn "api/progress\|/progress/" src/` returns no live callers (only documentation references in CLAUDE.md, which the documentation step below updates). Once verified empty, delete the file and its enclosing directory.

`find src/app/api/progress` after the change should return nothing.

### `src/components/Studio.tsx` — image batch loop uses ReadableStream reader

Replace the per-take `EventSource` setup in the image batch submit loop with the same ReadableStream-reader pattern the video batch loop uses. Read the existing video loop for the canonical structure; mirror it for image.

Key differences from today's image loop:

- The fetch's response is no longer JSON; it's an SSE stream. The two-step "POST then EventSource" collapses into one streaming fetch.
- `promptId` and `resolvedSeed` arrive in the `init` event, not the POST response body.
- The queue-tray `addJob` registration moves from "right after the POST resolves" to "right after the init event arrives" — a few milliseconds later, but visually identical.
- Error handling distinguishes pre-stream errors (`!res.ok` → parse JSON `{error}`) from in-stream errors (SSE `error` event with `{message}`).

Rough shape (match the existing video batch loop's structure exactly):

```ts
const res = await fetch('/api/generate', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(generateParams),
});
if (!res.ok) {
  const { error } = await res.json() as { error: string };
  throw new Error(error);
}
if (!res.body) throw new Error('No SSE body');

const reader = res.body.getReader();
const decoder = new TextDecoder();
let buffer = '';
let promptId = '';

(async () => {
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const messages = buffer.split('\n\n');
      buffer = messages.pop() ?? '';
      for (const message of messages) {
        const eventLine = message.split('\n').find((l) => l.startsWith('event: '));
        const dataLine = message.split('\n').find((l) => l.startsWith('data: '));
        if (!eventLine || !dataLine) continue;
        const eventType = eventLine.slice(7).trim();
        const data = JSON.parse(dataLine.slice(6));

        if (eventType === 'init') {
          promptId = data.promptId;
          if (i === 0) setLastResolvedSeed(data.resolvedSeed);
          addJob({ promptId, generationId: '', mediaType: 'image', /* ... */ });
        } else if (eventType === 'progress') {
          updateProgress(promptId, { current: data.value, total: data.max });
        } else if (eventType === 'completing') {
          setCompleting(promptId);
        } else if (eventType === 'complete') {
          const records = data.records as GenerationRecord[];
          setLastImageRecords((prev) => [...prev, ...records]);
          completeJob(promptId, records[0]?.id ?? '');
          onGenerated();
        } else if (eventType === 'error') {
          setSubmitError(data.message ?? 'Generation failed');
          if (promptId) errorJob(promptId, data.message ?? '');
        }
      }
    }
  } catch (err) {
    if (promptId) errorJob(promptId, String(err));
  }
})();
```

If the existing image loop has any other side effects (custom error toasts, completion sounds, gallery refresh hooks), preserve them. The structural change is the transport; the side effects stay.

### `src/contexts/QueueContext.tsx` — verify no flat-field reads

The queue context's `completeJob`, `errorJob`, `updateProgress` take primitives — they don't read off the SSE event payload directly. Should be unaffected by the transport change.

`grep -n "EventSource" src/` after the change shows no EventSource usage tied to image generation. (Other EventSource usages elsewhere — e.g. ingest panel — are unaffected and stay.)

---

## Critical: disk-avoidance contract is preserved

This batch must NOT touch:

- `src/lib/workflow.ts` — `buildWorkflow()` produces SaveImageWebsocket nodes and ETN_LoadImageBase64 / ETN_LoadMaskBase64 node references. All of this is unchanged.
- `src/lib/comfyws.ts`'s `onBinary()` handler — this is where SaveImageWebsocket binary frames get captured into `imageBuffers`. Unchanged.
- `finalizeImageJob` — this writes the captured buffer to mint-pc's `IMAGE_OUTPUT_DIR`. Unchanged.
- The post-finalize SSH cleanup glob (if applicable).

The only `comfyws.ts` changes are: `registerJob` signature widening, deletion of `stashJobParams` / `pendingParams`. The actual generation lifecycle (queue → execute → binary frames captured on WS → finalize writes to mint-pc) is untouched.

Verify before claiming done:
- `grep -rn "class_type.*['\"]SaveImage['\"]" src/` returns only `SaveImageWebsocket`.
- `grep -rn "class_type.*['\"]LoadImage['\"]" src/` returns only `ETN_LoadImageBase64` / `ETN_LoadMaskBase64`.
- `grep -n "IMAGE_OUTPUT_DIR" src/lib/comfyws.ts` shows the same write sites as before (diff against pre-batch state).
- The `onBinary` capture path is unchanged (diff against pre-batch state).
- Manual smoke test 9 (VM `ls` check) returns no orphan `.png` files after a successful generation.

---

## Acceptance criteria

- `npm run build` passes clean.
- `grep -rn "class_type.*['\"]SaveImage['\"]" src/` returns only SaveImageWebsocket.
- `grep -rn "class_type.*['\"]LoadImage['\"]" src/` returns only ETN_LoadImageBase64 / ETN_LoadMaskBase64.
- `find src/app/api/progress` returns nothing — directory is gone.
- `grep -rn "stashJobParams" src/` returns nothing.
- `grep -rn "pendingParams" src/lib/comfyws.ts` returns nothing.
- `grep -n "EventSource" src/components/Studio.tsx` returns no usages tied to image generation.
- `grep -n "registerJob\b" src/lib/comfyws.ts` shows the new signature `(promptId, params, resolvedSeed, assembledPos, assembledNeg, controller)`.
- `/api/generate` returns `Content-Type: text/event-stream` for successful submissions (verify via curl or network panel).
- `/api/generate` still returns JSON with appropriate status codes for pre-stream errors (400 for validation, 502 for ComfyUI unreachable, 500 for forbidden class_types).
- The image-mode complete-event payload shape is unchanged: `{ records: GenerationRecord[] }`.
- Studio's image submit loop is structurally similar to the video submit loop (both use ReadableStream readers, both parse `event:` / `data:` lines, both branch on event type).
- `git log --oneline -1 origin/<branch>` shows the agent's commit.

Manual smoke test (deferred to user — tablet, full regression):

1. Generate a single image (batch=1). Confirm: progress bar advances, completion notification fires, image appears in result grid, gallery refresh picks it up.
2. Generate batch=4 images. Confirm: 4 jobs in queue tray, all complete, 4 thumbnails in result grid.
3. Generate img2img with a base image and mask. Confirm: ref images successfully loaded (no SaveImage / LoadImage errors in logs), output matches the inputs.
4. Generate with a project context active (after H5 lands, both image and video). Confirm: image inherits the project.
5. Refresh the page mid-generation. Confirm: queue tray's poll-based recovery picks up the running job; completion still fires when the job finishes (visible via active-jobs poll).
6. Abort a running image generation via the queue tray. Confirm: error appears, no orphan files on mint-pc IMAGE_OUTPUT_DIR or VM /models/ComfyUI/output.
7. Submit invalid params (e.g. malformed referenceImages). Confirm: 400 returned with error message, no SSE stream opened, no job entry in tray.
8. Stop ComfyUI on the VM. Submit a generation. Confirm: 502 returned with "ComfyUI unreachable" error, no SSE stream opened.
9. **Disk-avoidance regression check.** After a successful generation: `ssh a100 ls /models/ComfyUI/output/*.png 2>&1` returns "no such file or directory" (no orphans). The image lives only on mint-pc's `IMAGE_OUTPUT_DIR`.
10. Inspect a completed image's DB row. Confirm `filePath`, `lorasJson`, `assembledPos`, `assembledNeg`, `seed` all populated as before.

---

## Out of scope

- Changing ComfyUI workflow shape, SaveImageWebsocket node, ETN_LoadImage* nodes, or any node parameters. Workflow code is not touched by this batch.
- Changing `finalizeImageJob` write logic or output path resolution.
- Changing the WS binary-frame capture in `onBinary`.
- Changing the queue tray UI or its polling cadence.
- Changing the active-jobs poll endpoint (`/api/jobs/active`) or the recently-completed cache.
- Changing the watchdog timeout duration.
- Changing the abort flow.
- Changing video or stitch routes — already on the one-call pattern.
- Adding placeholder DB rows at submit time for image. Video creates rows upfront; image creates rows in finalize. Keep that distinction — image's pattern leaves no DB row on abort/error, which is preferable.
- Type unification across `ImageJob` / `VideoJob` / `StitchJob`. That's M1, the next batch.

---

## Documentation

In CLAUDE.md, find the `POST /api/generate` description. Update to match `/api/generate-video`'s pattern:

> **`POST /api/generate`** — SSE-streaming image generation. Returns an SSE stream directly (no separate `/progress` route).
>
> Request body: `GenerationParams` JSON.
>
> SSE events:
> | event | data shape |
> |---|---|
> | `init` | `{ promptId: string, resolvedSeed: number }` |
> | `progress` | `{ value: number, max: number }` |
> | `completing` | `{}` |
> | `complete` | `{ records: GenerationRecord[] }` |
> | `error` | `{ message: string }` |
>
> Pre-stream errors (validation, ComfyUI unreachable, forbidden class_types) return JSON with appropriate HTTP status codes; only successful submissions open an SSE stream.

Find any references to `/api/progress/[promptId]` and remove them.

Find the description of `manager.stashJobParams()` / `pendingParams`. Remove. Update the `registerJob()` description to reflect the new signature.

Find the "Seed resolution" section. Update the line describing seed travel:

> The resolved seed travels: `buildWorkflow()` return value → SSE `init` event → `registerJob()` argument → `prisma.generation.create()`.

In the source layout, remove `/api/progress/` from the directory listing.

When done, push and create the PR via `gh pr create` per AGENTS.md.

**Final acceptance — verify before declaring done:** `git log --oneline -1 origin/<your-branch>` MUST show your commit.
