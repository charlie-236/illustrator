# Batch — Image batch as N independent jobs

When the user submits an image generation with `batchSize > 1`, the current code path produces N visually-similar outputs because it uses ComfyUI's native `EmptyLatentImage.batch_size` parameter. ComfyUI's batch sampling produces N images that share a base seed and differ only by batch-index offsets — the structural design produces "related" outputs, not "alternative" outputs.

The user's mental model is "give me 4 different alternates." The current behavior is "give me 4 closely-related variants of one sample." Bug. Fix by switching image batch to N independent ComfyUI workflows, each with its own random seed, each registered as its own job in the queue tray.

This is the structural prerequisite for the upcoming video-batch and remix-default-4 batches. Without this, remix-with-batch-4 inherits the seed-shared behavior and remix produces 4 nearly-identical alternates instead of 4 actually-different ones.

Re-read CLAUDE.md before starting.

---

## What's happening today (verified via `project_knowledge_search`)

In `src/lib/workflow.ts`, `buildWorkflow()` sets:

```ts
nodes['2'] = {
  class_type: 'EmptyLatentImage',
  inputs: { width: params.width, height: params.height, batch_size: params.batchSize ?? 1 },
};
```

The KSampler downstream operates on this batched latent and produces N image frames that all share the workflow's single `seed` value. ComfyUI streams the N frames back over the same WS connection during the same prompt's execution. `comfyws.ts` accumulates them in `imageBuffers` and `finalizeImageJob` writes all N to disk under indexed filenames (`slug_timestamp_1.png`, `slug_timestamp_2.png`, ...) sharing one `resolvedSeed` value.

This is structurally one workflow, one seed, one prompt ID, one job — N frames.

After this fix: N workflows, N seeds, N prompt IDs, N jobs — one frame each.

---

## What to build

### 1. Workflow builder — drop `batch_size` from EmptyLatentImage

In `src/lib/workflow.ts`, change `EmptyLatentImage`'s `batch_size` to always be `1` (or remove the input entirely if `1` is the ComfyUI default):

```ts
nodes['2'] = {
  class_type: 'EmptyLatentImage',
  inputs: { width: params.width, height: params.height, batch_size: 1 },
};
```

The `params.batchSize` is no longer consulted by the workflow builder. The builder always produces a single-image workflow.

### 2. Studio submit logic — N parallel POSTs

`Studio.tsx` currently makes one POST to `/api/generate` per Generate click and opens one SSE stream. After this fix, with `batchSize: N`, it makes N POSTs (each with a different randomized seed) and opens N SSE streams (each registering its own queue tray job).

Loop pattern (matching how the `video-batch-support` prompt describes the video side):

```ts
const batchSize = p.batchSize ?? 1;

// Pre-resolve the seed strategy once
const baseSeed = p.seed === -1
  ? -1                       // signal "randomize per take"
  : p.seed;                  // explicit seed; increment per take

for (let i = 0; i < batchSize; i++) {
  const takeSeed = baseSeed === -1
    ? -1                     // route resolves random seed per take
    : baseSeed + i;          // sequential for explicit seeds

  const generateParams = {
    ...basePayload,
    seed: takeSeed,
  };

  // POST to /api/generate, get promptId + resolvedSeed
  // Add job to queue tray with status: 'queued'
  // Open SSE stream for this prompt's progress
  // (existing per-job SSE handling unchanged)
}
```

Each iteration adds its own queue-tray entry. The form's `submitting` debounce (per `generate-button-debounce`) covers the whole loop — one click produces N submissions, all queued before the user can click again.

### 3. Seed semantics

When `seed === -1`: each take gets its own randomized seed. The existing route handler already does `seed === -1 → Math.floor(Math.random() * 2 ** 32)`, so passing `-1` per take produces N independent random seeds.

When `seed !== -1` (explicit): each take gets `seed + i`. Take 0 reproduces what the user typed; takes 1, 2, 3 are deterministic neighbors. Reproducibility is preserved for the explicit-seed case.

This matches the existing image-mode contract for single submissions and extends it to batches in the most predictable way.

### 4. Queue tray — N jobs per submit

No code change needed in the queue tray itself; it already handles N concurrent jobs. The submit loop registers N jobs, each gets its own row, each progresses independently.

ComfyUI processes prompts sequentially (one GPU), so the tray will show take 1 as Running, takes 2-4 as Queued, transitioning as each completes.

### 5. Filename and DB row per take

Each take produces one image, one row, one filename. The existing `isBatch` filename logic in `finalizeImageJob` (`slug_timestamp_${i+1}.png` vs `slug_timestamp.png`) is no longer needed since each job's `imageBuffers` array always has length 1. Simplify:

```ts
const isBatch = imageBuffers.length > 1;  // always false after this batch
const filename = `${slug}_${timestamp}.${ext}`;
```

You can leave the `isBatch` branch in place as defensive code (it'll just never trigger), or remove it for cleanness. Agent's call. Removing is slightly preferable.

But there's a real collision concern: N takes submitted within the same millisecond (which now happens because they're submitted in a tight loop) will share the `Date.now()` timestamp. The slug + timestamp combo collides. Fix one of two ways:

- **(a)** Add a small per-job index suffix unconditionally: `slug_timestamp_<promptId-prefix>.png` — promptId is unique per ComfyUI submission.
- **(b)** Rely on `prisma.generation.create()`'s implicit ordering and append a row-id-derived suffix in the rare collision case.

I lean (a). The promptId is already a UUID; take its first 8 chars as a suffix. Cheap, collision-free, traceable back to the queue tray.

### 6. Studio result display — handle N completions

`Studio.tsx`'s post-generation thumbnail grid currently consumes a single `complete` SSE event with `records: GenerationRecord[]` (the array of N batch outputs). After this fix, each job emits its own `complete` event with a single record.

Two options:

- **(a)** Change Studio to track per-job completion and accumulate records into `lastImageRecords` as each job finishes. The thumbnail grid still shows N images when all complete.
- **(b)** Drop the post-generation thumbnail grid entirely and rely on the gallery (which auto-refreshes when new generations land).

(b) is simpler and matches what the user actually does — they don't sit and watch the grid; they go look at the gallery. (a) preserves current behavior at the cost of more state to track.

**Lean: (a)**. Some users may rely on the immediate-feedback grid. Don't pull a feature out as a side effect of this fix. Track per-prompt completions; render the grid as soon as the first job completes; append as more arrive.

If (a) gets ugly, fall back to (b) and document in the PR description.

### 7. The `lastResolvedSeed` display

Studio shows "Seed: N" below the result grid using `lastResolvedSeed`. With batch=4, there are now N different seeds. Two options:

- Show the seed of the *first* completed take (acceptable; user can see all seeds in each generation's gallery modal)
- Show all seeds joined ("Seed: 12345, 12346, 12347, 12348" — gets long)
- Drop the seed display when batchSize > 1

**Lean**: show the *first* completed take's seed. Document in code that this is the displayed value when `batchSize > 1`. The user has full per-take seeds in the gallery.

### 8. The "send N latent indices" image-frame routing

Verify in `comfyws.ts`'s `onBinary` handler. Today it pushes incoming PNG buffers into the active prompt's `imageBuffers`. With single-image workflows, only one buffer arrives per prompt. The existing logic still works — just with `imageBuffers.length === 1` instead of N.

`finalizeImageJob`'s `imageBuffers.map(...)` becomes a length-1 map. No code change required.

---

## Acceptance criteria

- `npm run build` passes clean.
- `grep -rn "class_type.*['\"]SaveImage['\"]" src/` returns only SaveImageWebsocket.
- `grep -rn "class_type.*['\"]LoadImage['\"]" src/` returns only ETN_LoadImageBase64 / ETN_LoadMaskBase64.
- `grep -n "batch_size" src/lib/workflow.ts` shows `batch_size: 1` (or no `batch_size` at all if removed).
- `grep -n "params.batchSize" src/lib/workflow.ts` returns no matches — the workflow builder no longer consults it.
- Studio's submit handler loops over `batchSize`, making N POSTs and registering N queue-tray jobs.
- Each take's seed is either `seed + i` (explicit) or independently randomized (`-1`).
- `git log --oneline -1 origin/<branch>` shows the agent's commit.

Manual smoke test (deferred to user):

1. Open Studio image mode. Set batch to 4. Generate. Confirm 4 jobs appear in the queue tray. Confirm all 4 share the same prompt but produce visibly *different* (not just slightly different) outputs.
2. Compare to the previous behavior: the 4 outputs should look like 4 separate generations, not 4 variants of one.
3. With an explicit seed (e.g. 12345) and batch=4, generate. Inspect the resulting 4 gallery rows. Confirm seeds are 12345, 12346, 12347, 12348.
4. Repeat with seed=-1 and batch=4. Confirm seeds are 4 different random values.
5. Confirm the post-generation thumbnail grid in Studio still shows all 4 images (per option (a) above).
6. Confirm batch=1 produces exactly one job, one row, no regression.
7. Generate batch=4 with i2img active (a base image set). Confirm all 4 jobs run with the same base image but different seeds. Confirm outputs are 4 different variants of the same starting image.
8. Generate batch=4 with FaceID references. Same: 4 takes, same references, different seeds.

---

## Out of scope

- Changing the ComfyUI batch capability for any other purpose. ComfyUI's `EmptyLatentImage.batch_size` is gone from this app's image path; if some future feature needs it (e.g. animation diffs that benefit from batched sampling), reintroduce explicitly with documentation.
- Migrating existing batch generations in the DB. They were what they were; new batches are different. No data migration needed.
- Folding the multiple-take submission into a single request to `/api/generate`. The existing route handles single-prompt submissions; the loop is client-side. Don't add a new `/api/generate-batch` endpoint.
- Showing aggregate progress across the N jobs ("Take 2/4 complete"). The queue tray's per-job progress is sufficient.
- Reducing the batch cap from 4. Cap stays at 4.
- Touching the video path. That's the next batch (`video-batch-support`) which already specifies N independent jobs.

---

## Documentation

In CLAUDE.md, find the section describing image generation and batching. Update to note:

> Image batches are N independent ComfyUI workflows, not one workflow with `batch_size > 1`. Each take has its own seed (random if seed=-1, sequential `seed + i` if explicit), its own queue tray entry, and its own `Generation` row. This produces visually-distinct outputs at the cost of N times the prompt-submission overhead. The cap remains at 4 takes per submit.

Find the workflow node graph section. Update the EmptyLatentImage entry to remove any mention of batched latent indices.

When done, push and create the PR via `gh pr create` per AGENTS.md.

**Final acceptance — verify before declaring done:** `git log --oneline -1 origin/<your-branch>` MUST show your commit. If it doesn't, you haven't pushed. Push, then verify again.
