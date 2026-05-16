# Batch — SSE complete-event shape parity (video and stitch emit full GenerationRecord)

When an image generation completes, the SSE `complete` event payload is `{ records: GenerationRecord[] }` — a fully hydrated record array suitable for direct gallery rendering. When a video or stitch generation completes, the payload is a flat partial subset: `{ id, filePath, frames, fps, seed, createdAt }`. Studio consumers have to either work around the missing fields or refetch via `/api/generation/[id]`.

Make video and stitch emit the same shape image does. The route already creates the full DB row at finalize time; just include the serialized result in the SSE event.

This batch is foundational for the upcoming Studio video result-grid batch, which mirrors the image result grid by accumulating per-take `GenerationRecord` instances. Do this first.

Re-read CLAUDE.md before starting.

---

## Required changes

### `src/lib/comfyws.ts` — `finalizeVideoJob`

Currently, after `prisma.generation.create({ ... })`, `finalizeVideoJob` emits a flat-shape SSE event roughly like `{ id, filePath, frames, fps, seed: seed.toString(), createdAt: createdAt.toISOString() }`.

Replace with the image-side shape:

```ts
const record: GenerationRecord = {
  ...created,
  seed: created.seed.toString(),
  createdAt: created.createdAt.toISOString(),
  // Match whatever projection /api/gallery does — projectName, parentProjectName, etc.
  // If the image-side complete event in finalizeImageJob omits any field, mirror that omission here.
};
controller.enqueue(sseChunk('complete', { records: [record] }));
```

The two `complete` payloads (image and video) should be byte-identical in shape — same field set, same key order if practical. Read `finalizeImageJob`'s emission for the canonical shape and replicate.

If `finalizeImageJob` does any additional projection (e.g. dropping internal fields like `projectId` in favor of `projectName`), do the same for video. The point is one consumer can handle either event with no branching.

### `src/app/api/projects/[id]/stitch/route.ts` (or `comfyws.ts` `finalizeStitchSuccess`) — same payload change

Stitch's `complete` event currently emits the same flat shape as video. Switch to `{ records: [record] }`. Stitch always emits a single record (no batches), so the array has one element.

Locate the emission site by searching for `'complete'` and the stitch finalize path. The change is mechanical — same record-construction pattern.

### `src/components/Studio.tsx` — update video and stitch SSE consumers

Find the video batch loop's per-take SSE consumer:

```ts
sse.addEventListener('complete', (e) => { /* ... */ });
```

Update to read `records: GenerationRecord[]`:

```ts
sse.addEventListener('complete', (e) => {
  const d = JSON.parse(e.data) as { records: GenerationRecord[] };
  const record = d.records[0]; // video and stitch emit single-element arrays
  // ... existing post-completion logic, now reading fields off `record` instead of flat top-level fields
});
```

If Studio is using flat fields directly anywhere (e.g. `videoResult.frames`, `videoResult.fps`, `videoResult.seed`), update those reads to come from the record. Check both the video submit-loop SSE handler and any stitch consumer (`stitchProject` invocation in projects/stitch UI, if Studio handles it; otherwise the consumer is in `Projects.tsx` or `ProjectDetail.tsx`).

### `src/types/index.ts` — review `VideoResult` type

If `VideoResult` exists as a separate narrow type, decide:

- **(a) Delete it**, replace consumers with `GenerationRecord`. Cleaner.
- **(b) Keep it** as a type alias / projection of `GenerationRecord`. Justifies only if there's a pre-existing reason to constrain the surface area.

Recommendation: (a). The whole point of this batch is the shapes match — having two named types for the same thing is exactly what we're trying to remove.

`grep -rn "VideoResult" src/` — if it's used in only one or two places, just delete it. If threaded through more, leave the name but make it `type VideoResult = GenerationRecord;` for now and let the Studio video result-grid batch (next) finish the cleanup.

### Queue context (if applicable)

`src/contexts/QueueContext.tsx`'s `completeJob` takes a `generationId` string from Studio's complete handler. That call signature doesn't change. But verify nothing in QueueContext reads flat fields off the SSE event payload directly.

`project_knowledge_search` for `'complete'` event handlers in QueueContext to confirm.

---

## Acceptance criteria

- `npm run build` passes clean.
- `grep -rn "class_type.*['\"]SaveImage['\"]" src/` returns only SaveImageWebsocket.
- `grep -rn "class_type.*['\"]LoadImage['\"]" src/` returns only ETN_LoadImageBase64 / ETN_LoadMaskBase64.
- `grep -n "records:" src/lib/comfyws.ts | grep -i complete` shows the new payload shape in `finalizeVideoJob` (and stitch finalize if it lives here).
- The image-side complete payload in `finalizeImageJob` is unchanged — diff against pre-batch state to confirm.
- Studio's video and stitch SSE `complete` consumers parse `records: GenerationRecord[]` and read fields off the record.
- The flat fields (`id`, `filePath`, `frames`, `fps`, `seed`, `createdAt`) are no longer at the top level of the video or stitch `complete` payload.
- `git log --oneline -1 origin/<branch>` shows the agent's commit.

Manual smoke test (deferred to user):

1. Generate a video. Watch the network panel's SSE stream. Confirm the `complete` event payload is `{"records":[{...full record fields...}]}` — same shape as the image-side complete event.
2. Confirm Studio displays the result correctly (the result card still shows the video, seed, etc.). No regressions.
3. Stitch a project. Confirm the same payload shape and that the stitch result renders correctly.
4. Generate an image (regression check). Confirm the image-side `complete` payload shape is unchanged.
5. Refresh the page mid-video-generation, then check the queue tray's recovery path. Confirm the recovery path still works (the `getActiveJobs` poll endpoint is independent of SSE shape).

---

## Out of scope

- Migrating image-mode to a one-call SSE pattern. Deferred refactor (audit's H1).
- Changing the Studio video result card to show batch grids. Next batch (H4) builds on this one.
- Changing how the queue tray displays jobs.
- Adding any new fields to `GenerationRecord`. The H3 video-remix batch handles that.
- Changing the SSE `init`, `progress`, `completing`, or `error` event shapes — only `complete` changes.
- Backfilling any DB rows.

---

## Documentation

In CLAUDE.md, find the table describing `/api/generate-video` SSE events. Update the `complete` row:

```
| `complete` | `{ records: GenerationRecord[] }` — single-element array; matches image-mode shape |
```

Find the equivalent table for `/api/projects/[id]/stitch`. Same update.

When done, push and create the PR via `gh pr create` per AGENTS.md.

**Final acceptance — verify before declaring done:** `git log --oneline -1 origin/<your-branch>` MUST show your commit. If it doesn't, you haven't pushed. Push, then verify again.
